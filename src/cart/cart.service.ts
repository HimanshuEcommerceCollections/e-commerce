import type { Cart, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { CartItemNotFoundError, InsufficientStockError, ProductNotAvailableError } from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { integer, requiredUuid } from '../common/validation';
import type { Db } from '../db';
import type { ShippingMethod } from '../common/enums';
import type { PricingRules } from '../order/pricing';
import {
  isPurchasable,
  loadCartProducts,
  mergeLineInputs,
  toCartResponse,
  toCheckoutQuote,
  type CartLine,
} from './cart-pricing';

export const CartItemSchema = z.object({
  productId: requiredUuid(),
  quantity: integer({ required: true, positive: true, max: 999 }),
});

export const CartItemUpdateSchema = z.object({
  quantity: integer({ required: true, positive: true, max: 999 }),
});

/** A guest's browser cart (preview, merge, quote, guest checkout): at most 100 lines. */
export const CartLinesSchema = z
  .array(CartItemSchema, { invalid_type_error: 'must be a list of { productId, quantity }' })
  .max(100, 'A cart can hold at most 100 lines');

export const CartLinesBodySchema = z.object({
  items: z.preprocess((v) => v ?? [], CartLinesSchema),
});

export type CartLineInput = { productId: string; quantity: number };

/** Most a merged line can hold (the add-to-cart limit). */
const MAX_LINE_QUANTITY = 999;

/**
 * The caller's cart. One live cart per user and one live line per product are
 * enforced by partial unique indexes (V8); the code below leans on them to make
 * concurrent requests safe rather than locking.
 */
export class CartService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly rules: PricingRules,
    private readonly currency: string,
  ) {}

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

  /**
   * Prices a guest's browser cart (FR-ST-09) without touching any server
   * cart. Never fails over availability: unknown or deleted products are
   * dropped, unbuyable ones come back `available: false`, and quantities are
   * reported as sent (the client caps them with `stockQuantity`).
   */
  async preview(items: CartLineInput[]) {
    return toCartResponse(null, await this.resolveLines(this.prisma, items), this.rules);
  }

  /**
   * After sign-in: adds the guest's lines to the account cart. Each line is
   * capped at the stock left; unavailable products are skipped.
   */
  async merge(userId: string, items: CartLineInput[]) {
    const cart = await this.getOrCreateCart(userId);
    const lines = mergeLineInputs(items);
    const products = await loadCartProducts(this.prisma, lines.map((l) => l.productId));
    for (const line of lines) {
      const product = products.get(line.productId);
      if (!product || !isPurchasable(product)) continue;
      const cap = Math.min(product.stockQuantity, MAX_LINE_QUANTITY);
      const existing = await this.prisma.cartItem.findFirst({
        where: { cartId: cart.id, productId: product.id, deleted: false },
      });
      if (existing) {
        const quantity = Math.min(existing.quantity + line.quantity, cap);
        if (quantity !== existing.quantity) {
          await this.prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } });
        }
      } else {
        try {
          await this.addNewLine(cart.id, product.id, Math.min(line.quantity, cap));
        } catch (e) {
          // A concurrent add created the line first; keep theirs.
          if (!isIntegrityViolation(e)) throw e;
        }
      }
    }
    return this.buildResponse(cart);
  }

  /**
   * Checkout quote (FR-ST-10): shipping options and totals for the given
   * lines, or — when a signed-in customer sends none — for their server cart.
   */
  async quote(items: CartLineInput[] | undefined, customerId: string | null, method: ShippingMethod = 'STANDARD') {
    const lines =
      items === undefined
        ? customerId
          ? await this.linesForUser(customerId)
          : []
        : await this.resolveLines(this.prisma, items);
    return toCheckoutQuote(lines, method, this.rules, this.currency);
  }

  /** The caller's live cart lines (for the checkout quote); no cart means none. */
  async linesForUser(userId: string, db: Db = this.prisma): Promise<CartLine[]> {
    const cart = await db.cart.findFirst({ where: { userId, deleted: false } });
    if (!cart) return [];
    const items = await db.cartItem.findMany({ where: { cartId: cart.id, deleted: false }, orderBy: { createdAt: 'asc' } });
    return this.resolveLines(db, items);
  }

  /** Request lines → priced-cart lines; unknown and deleted products drop out. */
  async resolveLines(db: Db, items: CartLineInput[]): Promise<CartLine[]> {
    const lines = mergeLineInputs(items);
    const products = await loadCartProducts(db, lines.map((l) => l.productId));
    return lines.flatMap((l) => {
      const product = products.get(l.productId);
      return product ? [{ product, quantity: l.quantity }] : [];
    });
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
    // Soft-deleted products drop out (nothing to show); unbuyable ones stay
    // with available=false and don't count toward the totals.
    return toCartResponse(cart, await this.resolveLines(this.prisma, items), this.rules);
  }
}

function validateStock(available: number, requested: number) {
  if (requested > available) throw new InsufficientStockError(available, requested);
}
