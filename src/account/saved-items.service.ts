import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { CartService } from '../cart/cart.service';
import { money } from '../common/api-response';
import { isIntegrityViolation } from '../common/error-handler';
import { DomainError, ProductNotFoundError } from '../common/errors';
import { isUuid, requiredUuid } from '../common/validation';
import { SHOPPER_PRODUCT_INCLUDE, toShopperProduct } from './shopper-product';

export const SaveItemSchema = z.object({ productId: requiredUuid() });

/** Hearts a guest tapped before signing in. */
export const MergeSavedItemsSchema = z.object({
  productIds: z
    .array(z.string().refine(isUuid, 'must be a valid UUID'), {
      required_error: 'must not be null',
      invalid_type_error: 'must be a list of product ids',
    })
    .max(200, 'size must be between 0 and 200'),
});

type SavedRow = Prisma.SavedItemGetPayload<{ include: { product: { include: typeof SHOPPER_PRODUCT_INCLUDE } } }>;

/**
 * Saved items (the heart, design "your-account › Saved"). One row per user and
 * SKU (uk_saved_items_user_product); the price at save time drives the
 * "Price dropped" badge.
 */
export class SavedItemService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cart: CartService,
  ) {}

  /** Newest first; SKUs since deleted from the catalog drop out. */
  async list(userId: string) {
    const rows = await this.prisma.savedItem.findMany({
      where: { userId, product: { deleted: false } },
      include: { product: { include: SHOPPER_PRODUCT_INCLUDE } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toSavedItem);
  }

  async ids(userId: string): Promise<string[]> {
    const rows = await this.prisma.savedItem.findMany({
      where: { userId, product: { deleted: false } },
      select: { productId: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => r.productId);
  }

  async count(userId: string) {
    return this.prisma.savedItem.count({ where: { userId, product: { deleted: false } } });
  }

  /** Idempotent: `created` is false when the SKU was already saved (the first save's price stays). */
  async save(userId: string, productId: string) {
    const product = await findSaveable(this.prisma, productId);
    if (!product) throw new ProductNotFoundError(productId);
    const existing = await this.find(userId, productId);
    if (existing) return { item: toSavedItem(existing), created: false };
    try {
      await this.prisma.savedItem.create({ data: { userId, productId, priceAtSave: product.price } });
    } catch (e) {
      // A concurrent save of the same SKU won.
      if (!isIntegrityViolation(e)) throw e;
      return { item: toSavedItem((await this.find(userId, productId))!), created: false };
    }
    return { item: toSavedItem((await this.find(userId, productId))!), created: true };
  }

  /** Unsaving something not saved is not an error. */
  async remove(userId: string, productId: string) {
    await this.prisma.savedItem.deleteMany({ where: { userId, productId } });
  }

  /** One unit into the cart (stock and availability checked there), then off the list. */
  async moveToCart(userId: string, productId: string) {
    if (!(await this.find(userId, productId))) throw new DomainError(404, 'This item is not in your saved items');
    const cart = await this.cart.addItem(userId, { productId, quantity: 1 });
    await this.prisma.savedItem.deleteMany({ where: { userId, productId } });
    return cart;
  }

  /** Saves every buyable SKU among `productIds` (unknown ones are skipped) and returns all saved ids. */
  async merge(userId: string, productIds: string[]) {
    const ids = [...new Set(productIds.map((id) => id.toLowerCase()))];
    if (ids.length) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: ids }, deleted: false, status: 'ACTIVE' },
        select: { id: true, price: true },
      });
      await this.prisma.savedItem.createMany({
        data: products.map((p) => ({ userId, productId: p.id, priceAtSave: p.price })),
        skipDuplicates: true,
      });
    }
    return this.ids(userId);
  }

  private find(userId: string, productId: string) {
    return this.prisma.savedItem.findUnique({
      where: { userId_productId: { userId, productId } },
      include: { product: { include: SHOPPER_PRODUCT_INCLUDE } },
    });
  }
}

/** Only published, live SKUs can be saved (anything else is a 404, as on the product page). */
function findSaveable(db: PrismaClient, productId: string) {
  return db.product.findFirst({ where: { id: productId, deleted: false, status: 'ACTIVE' }, select: { id: true, price: true } });
}

function toSavedItem(row: SavedRow) {
  const drop = row.priceAtSave.sub(row.product.price);
  return {
    ...toShopperProduct(row.product),
    priceAtSave: money(row.priceAtSave),
    priceDrop: money(drop.gt(0) ? drop : new Prisma.Decimal(0)),
    savedAt: row.createdAt,
  };
}
