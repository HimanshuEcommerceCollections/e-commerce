import { Prisma, type Cart, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { CartItemNotFoundError, InsufficientStockError, ProductNotAvailableError } from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { integer, requiredUuid } from '../common/validation';
import { primaryImageUrl } from '../product/product.mapper';

export const CartItemSchema = z.object({
  productId: requiredUuid(),
  quantity: integer({ required: true, positive: true, max: 999 }),
});

export const CartItemUpdateSchema = z.object({
  quantity: integer({ required: true, positive: true, max: 999 }),
});

/**
 * The caller's cart. One live cart per user and one live line per product are
 * enforced by partial unique indexes (V8); the code below leans on them to make
 * concurrent requests safe rather than locking.
 */
export class CartService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Fetch (lazily creating) the caller's cart. */
  async getCart(userId: string) {
    return this.buildResponse(await this.getOrCreateCart(userId));
  }

  async addItem(userId: string, input: z.output<typeof CartItemSchema>) {
    const product = await this.validateProduct(input.productId);
    const cart = await this.getOrCreateCart(userId);

    const existing = await this.prisma.cartItem.findFirst({
      where: { cartId: cart.id, productId: input.productId, deleted: false },
    });
    if (existing) {
      const newQty = existing.quantity + input.quantity;
      validateStock(product.stockQuantity, newQty);
      await this.prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: newQty } });
    } else {
      validateStock(product.stockQuantity, input.quantity);
      await this.addNewLine(cart.id, input.productId, input.quantity);
    }
    return this.buildResponse(cart);
  }

  async updateItem(userId: string, productId: string, quantity: number) {
    const product = await this.validateProduct(productId);
    const cart = await this.requireCart(userId, productId);
    const item = await this.prisma.cartItem.findFirst({ where: { cartId: cart.id, productId, deleted: false } });
    if (!item) throw new CartItemNotFoundError(productId);

    validateStock(product.stockQuantity, quantity);
    await this.prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
    return this.buildResponse(cart);
  }

  async removeItem(userId: string, productId: string) {
    const cart = await this.requireCart(userId, productId);
    const item = await this.prisma.cartItem.findFirst({ where: { cartId: cart.id, productId, deleted: false } });
    if (!item) throw new CartItemNotFoundError(productId);
    await this.prisma.cartItem.update({ where: { id: item.id }, data: { deleted: true } });
  }

  /** No cart means nothing to clear — deliberately doesn't create one. */
  async clearCart(userId: string) {
    const cart = await this.prisma.cart.findFirst({ where: { userId, deleted: false } });
    if (cart) {
      await this.prisma.cartItem.updateMany({ where: { cartId: cart.id, deleted: false }, data: { deleted: true } });
    }
  }

  /**
   * Re-adding a removed product un-deletes its most recent removed row instead
   * of inserting another, so remove/re-add cycles don't pile up rows. A
   * brand-new product inserts; if two requests race that insert, the unique
   * index rejects the loser with a 409 and the client's retry merges normally.
   */
  private async addNewLine(cartId: string, productId: string, quantity: number) {
    const removed = await this.prisma.cartItem.findFirst({
      where: { cartId, productId, deleted: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (removed) {
      await this.prisma.cartItem.update({ where: { id: removed.id }, data: { deleted: false, quantity } });
    } else {
      await this.prisma.cartItem.create({ data: { cartId, productId, quantity } });
    }
  }

  /**
   * Concurrent creation is safe through uniq_carts_user_live: the loser's
   * insert fails and it re-reads the winner's cart.
   */
  private async getOrCreateCart(userId: string): Promise<Cart> {
    const existing = await this.prisma.cart.findFirst({ where: { userId, deleted: false } });
    if (existing) return existing;
    try {
      return await this.prisma.cart.create({ data: { userId } });
    } catch (e) {
      if (!isIntegrityViolation(e)) throw e;
      const winner = await this.prisma.cart.findFirst({ where: { userId, deleted: false } });
      if (!winner) throw new Error(`Cart creation race left no live cart for user ${userId}`);
      return winner;
    }
  }

  /**
   * Changing a line never creates a cart: a user without one can't have the
   * line either, so it's the same 404 as a missing line.
   */
  private async requireCart(userId: string, productId: string) {
    const cart = await this.prisma.cart.findFirst({ where: { userId, deleted: false } });
    if (!cart) throw new CartItemNotFoundError(productId);
    return cart;
  }

  private async validateProduct(productId: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, deleted: false } });
    if (!product || product.status !== 'ACTIVE') throw new ProductNotAvailableError(productId);
    return product;
  }

  private async buildResponse(cart: Cart) {
    const items = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id, deleted: false },
      orderBy: { createdAt: 'asc' },
    });
    // One batch product lookup for the whole cart.
    const products = new Map(
      (
        await this.prisma.product.findMany({
          where: { id: { in: items.map((i) => i.productId) }, deleted: false },
          include: { images: { where: { deleted: false }, orderBy: { position: 'asc' } } },
        })
      ).map((p) => [p.id, p]),
    );

    // Soft-deleted products drop out (nothing to show); inactive ones stay with
    // available=false and don't count toward the totals.
    const lines = items.flatMap((item) => {
      const product = products.get(item.productId);
      if (!product) return [];
      const available = product.status === 'ACTIVE';
      const subtotal = available ? product.price.mul(item.quantity) : new Prisma.Decimal(0);
      return [{ item, product, available, subtotal }];
    });

    const totalPrice = lines.filter((l) => l.available).reduce((sum, l) => sum.add(l.subtotal), new Prisma.Decimal(0));
    const totalItems = lines.filter((l) => l.available).reduce((sum, l) => sum + l.item.quantity, 0);

    return {
      cartId: cart.id,
      customerId: cart.userId,
      items: lines.map(({ item, product, available, subtotal }) => ({
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        primaryImageUrl: primaryImageUrl(product.images),
        unitPrice: money(product.price),
        quantity: item.quantity,
        subtotal: money(subtotal),
        available,
      })),
      totalItems,
      totalPrice: money(totalPrice),
      updatedAt: cart.updatedAt,
    };
  }
}

function validateStock(available: number, requested: number) {
  if (requested > available) throw new InsufficientStockError(available, requested);
}
