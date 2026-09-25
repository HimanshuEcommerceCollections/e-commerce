import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { PRODUCT_STATUSES, type ProductStatus } from '../common/enums';
import { DomainError, OrderNotFoundError, ProductNotFoundError } from '../common/errors';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { decimal, integer, oneOf, optionalString, requiredUuid } from '../common/validation';
import { ORDER_ITEMS_INCLUDE, toOrderResponse } from '../order/order.mapper';
import { primaryImageUrl } from '../product/product.mapper';

/**
 * Stock at or below this counts as low (FR-AD-03). A per-SKU
 * Low_Stock_Threshold needs a schema column; until then it is one value.
 */
export const LOW_STOCK_THRESHOLD = 5;

export const ADMIN_PRODUCT_SORTS = ['updatedAt', 'createdAt', 'name', 'code'] as const;
export const ADMIN_INVENTORY_SORTS = ['sku', 'stockQuantity', 'updatedAt'] as const;
export const ADMIN_ORDER_SORTS = ['createdAt', 'grandTotal', 'orderNumber', 'status'] as const;

const status = () => oneOf(PRODUCT_STATUSES);

export const ParentUpdateSchema = z.object({
  name: optionalString({ max: 255 }),
  brand: optionalString({ max: 100 }),
  status: status(),
});

export const VariantUpdateSchema = z.object({
  price: decimal({ positive: true }),
  stockQuantity: integer({ positiveOrZero: true }),
  status: status(),
});

export const BulkStatusSchema = z.object({
  parentIds: z
    .array(requiredUuid(), { invalid_type_error: 'must be an array', required_error: 'must not be null' })
    .min(1, 'must not be empty')
    .max(1000, 'size must be between 1 and 1000'),
  status: oneOf(PRODUCT_STATUSES),
});

export const StockAdjustmentSchema = z.object({
  delta: integer({ required: true }),
  reason: optionalString({ max: 100 }),
});

export interface ProductFilter {
  search?: string;
  status?: ProductStatus;
  categoryId?: string;
}

export interface InventoryFilter {
  search?: string;
  categoryId?: string;
  /** `low` is low or out of stock. */
  stock?: 'low' | 'out';
}

export interface OrderFilter {
  search?: string;
  status?: string;
}

const LIVE_VARIANTS = { where: { deleted: false } } as const;

/**
 * Admin views of the whole catalog and every order (FR-AD-01/02/03, FR-IM-11).
 * Unlike the merchant endpoints these ignore ownership; the routes allow
 * ROLE_ADMIN only.
 */
export class AdminService {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Products (parents with their variant SKUs) ────────────────────────────

  async listProducts(filter: ProductFilter, pageable: Pageable) {
    const where = productWhere(filter);
    const [rows, total] = await Promise.all([
      this.prisma.parentProduct.findMany({
        where,
        include: {
          category: true,
          variants: { ...LIVE_VARIANTS, include: { images: { where: { deleted: false }, orderBy: { position: 'asc' } } } },
        },
        orderBy: orderBy(pageable, []),
        ...skipTake(pageable),
      }),
      this.prisma.parentProduct.count({ where }),
    ]);
    return toPage(rows.map(toProductRow), total, pageable);
  }

  /** Products per status for the tabs; a product counts once per status its variants have. */
  async productStatusCounts(filter: Omit<ProductFilter, 'status'>) {
    const counts = await Promise.all(
      [undefined, ...PRODUCT_STATUSES].map((s) => this.prisma.parentProduct.count({ where: productWhere({ ...filter, status: s }) })),
    );
    return Object.fromEntries([['ALL', counts[0]], ...PRODUCT_STATUSES.map((s, i) => [s, counts[i + 1]])]);
  }

  async getProduct(parentId: string) {
    const parent = await this.prisma.parentProduct.findFirst({
      where: { id: parentId, deleted: false },
      include: {
        category: true,
        variants: {
          ...LIVE_VARIANTS,
          include: { images: { where: { deleted: false }, orderBy: { position: 'asc' } } },
          orderBy: { sku: 'asc' },
        },
      },
    });
    if (!parent) throw new ProductNotFoundError(parentId);
    return {
      ...toProductRow(parent),
      shortDescription: parent.shortDescription,
      description: parent.description,
      variants: parent.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        variantName: v.variantName,
        color: v.color,
        size: v.size,
        price: money(v.price),
        stockQuantity: v.stockQuantity,
        status: v.status,
        stockStatus: stockStatus(v.stockQuantity),
        primaryImageUrl: primaryImageUrl(v.images),
        imageUrls: v.images.map((i) => i.url),
      })),
    };
  }

  /** Name and brand go on the parent (and the variants' copies of the name); status on every variant. */
  async updateProduct(parentId: string, input: z.output<typeof ParentUpdateSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const parent = await tx.parentProduct.findFirst({ where: { id: parentId, deleted: false } });
      if (!parent) throw new ProductNotFoundError(parentId);
      if (input.name !== undefined || input.brand !== undefined) {
        await tx.parentProduct.update({
          where: { id: parentId },
          data: { name: input.name, brand: input.brand },
        });
      }
      if (input.status) {
        await tx.product.updateMany({ where: { parentId, deleted: false }, data: { status: input.status } });
      }
    });
    return this.getProduct(parentId);
  }

  /** FR-IM-11: publish or unpublish many products at once. */
  async setStatus(input: z.output<typeof BulkStatusSchema>) {
    const { count } = await this.prisma.product.updateMany({
      where: { parentId: { in: input.parentIds }, deleted: false, parent: { deleted: false } },
      data: { status: input.status },
    });
    return { products: new Set(input.parentIds).size, variantsUpdated: count, status: input.status };
  }

  async updateVariant(id: string, input: z.output<typeof VariantUpdateSchema>) {
    const variant = await this.prisma.product.findFirst({ where: { id, deleted: false } });
    if (!variant) throw new ProductNotFoundError(id);
    const updated = await this.prisma.product.update({
      where: { id },
      data: { price: input.price, stockQuantity: input.stockQuantity, status: input.status, version: { increment: 1 } },
      include: { parent: true, category: true },
    });
    return toInventoryRow(updated);
  }

  // ── Inventory (one row per SKU) ───────────────────────────────────────────

  async listInventory(filter: InventoryFilter, pageable: Pageable) {
    const where = inventoryWhere(filter);
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { parent: true, category: true },
        orderBy: orderBy(pageable),
        ...skipTake(pageable),
      }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(rows.map(toInventoryRow), total, pageable);
  }

  async inventoryStats() {
    const live = { deleted: false, parent: { deleted: false } } satisfies Prisma.ProductWhereInput;
    const [skus, units, low, out] = await Promise.all([
      this.prisma.product.count({ where: live }),
      this.prisma.product.aggregate({ where: live, _sum: { stockQuantity: true } }),
      this.prisma.product.count({ where: { ...live, stockQuantity: { gt: 0, lte: LOW_STOCK_THRESHOLD } } }),
      this.prisma.product.count({ where: { ...live, stockQuantity: 0 } }),
    ]);
    return { skus, units: units._sum.stockQuantity ?? 0, lowStock: low, outOfStock: out, lowStockThreshold: LOW_STOCK_THRESHOLD };
  }

  /**
   * Adds `delta` (negative to remove) in one conditional UPDATE, so a
   * concurrent checkout can't be overwritten or drive stock below zero (NFR-08).
   */
  async adjustStock(id: string, input: z.output<typeof StockAdjustmentSchema>) {
    if (input.delta === 0) throw new DomainError(400, 'delta must not be 0');
    const { count } = await this.prisma.product.updateMany({
      where: { id, deleted: false, ...(input.delta < 0 ? { stockQuantity: { gte: -input.delta } } : {}) },
      data: { stockQuantity: { increment: input.delta }, version: { increment: 1 } },
    });
    if (count === 0) {
      const exists = await this.prisma.product.findFirst({ where: { id, deleted: false }, select: { stockQuantity: true } });
      if (!exists) throw new ProductNotFoundError(id);
      throw new DomainError(409, `Only ${exists.stockQuantity} in stock; can't remove ${-input.delta}`);
    }
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id }, include: { parent: true, category: true } });
    return toInventoryRow(product);
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  async listOrders(filter: OrderFilter, pageable: Pageable) {
    const where = orderWhere(filter);
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { ...ORDER_ITEMS_INCLUDE, user: { select: { fullName: true, email: true } } },
        orderBy: orderBy(pageable),
        ...skipTake(pageable),
      }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(
      rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
        currency: o.currency,
        grandTotal: money(o.grandTotal),
        itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
        customer: { name: o.user.fullName, email: o.user.email, city: o.shipCity, state: o.shipState },
        createdAt: o.createdAt,
      })),
      total,
      pageable,
    );
  }

  async orderStats() {
    const groups = await this.prisma.order.groupBy({ by: ['status'], where: { deleted: false }, _count: { _all: true } });
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
    return { total: groups.reduce((n, g) => n + g._count._all, 0), byStatus };
  }

  async getOrder(id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, deleted: false },
      include: { ...ORDER_ITEMS_INCLUDE, user: { select: { id: true, fullName: true, email: true, phoneNumber: true } } },
    });
    if (!order) throw new OrderNotFoundError(id);
    const customerOrders = await this.prisma.order.count({ where: { userId: order.userId, deleted: false } });
    return {
      ...toOrderResponse(order),
      customer: { ...order.user, orders: customerOrders },
      cancellationReason: order.cancellationReason,
      cancelledBy: order.cancelledBy,
    };
  }
}

// ── Filters ─────────────────────────────────────────────────────────────────

function productWhere(f: ProductFilter): Prisma.ParentProductWhereInput {
  const and: Prisma.ParentProductWhereInput[] = [{ deleted: false }, { variants: { some: { deleted: false } } }];
  if (f.categoryId) and.push({ categoryId: f.categoryId });
  if (f.status) and.push({ variants: { some: { deleted: false, status: f.status } } });
  const q = f.search?.trim();
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
        { variants: { some: { deleted: false, sku: { contains: q, mode: 'insensitive' } } } },
      ],
    });
  }
  return { AND: and };
}

function inventoryWhere(f: InventoryFilter): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [{ deleted: false }, { parent: { deleted: false } }];
  if (f.categoryId) and.push({ categoryId: f.categoryId });
  if (f.stock === 'low') and.push({ stockQuantity: { lte: LOW_STOCK_THRESHOLD } });
  if (f.stock === 'out') and.push({ stockQuantity: 0 });
  const q = f.search?.trim();
  if (q) {
    and.push({
      OR: [
        { sku: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { parent: { name: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }
  return { AND: and };
}

function orderWhere(f: OrderFilter): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [{ deleted: false }];
  if (f.status) and.push({ status: f.status });
  const q = f.search?.trim();
  if (q) {
    and.push({
      OR: [
        { orderNumber: { contains: q, mode: 'insensitive' } },
        { user: { fullName: { contains: q, mode: 'insensitive' } } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }
  return { AND: and };
}

// ── Row shapes ──────────────────────────────────────────────────────────────

function stockStatus(qty: number) {
  return qty === 0 ? 'OUT_OF_STOCK' : qty <= LOW_STOCK_THRESHOLD ? 'LOW_STOCK' : 'IN_STOCK';
}

type ParentWithVariants = Prisma.ParentProductGetPayload<{
  include: { category: true; variants: { include: { images: true } } };
}>;

function toProductRow(p: ParentWithVariants) {
  const prices = p.variants.map((v) => v.price);
  const min = prices.reduce<Prisma.Decimal | null>((a, b) => (a === null || b.lt(a) ? b : a), null);
  const max = prices.reduce<Prisma.Decimal | null>((a, b) => (a === null || b.gt(a) ? b : a), null);
  const statuses = [...new Set(p.variants.map((v) => v.status))];
  const updated = p.variants.reduce((d, v) => (v.updatedAt > d ? v.updatedAt : d), p.updatedAt);
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    brand: p.brand,
    category: p.category ? { id: p.category.id, name: p.category.name } : null,
    variantCount: p.variants.length,
    minPrice: min && money(min),
    maxPrice: max && money(max),
    totalStock: p.variants.reduce((n, v) => n + v.stockQuantity, 0),
    lowStockVariants: p.variants.filter((v) => v.stockQuantity <= LOW_STOCK_THRESHOLD).length,
    /** The variants' status when they agree, otherwise MIXED. */
    status: statuses.length === 1 ? statuses[0] : 'MIXED',
    primaryImageUrl: primaryImageUrl(p.variants[0]?.images ?? []),
    updatedAt: updated,
  };
}

type VariantWithParent = Prisma.ProductGetPayload<{ include: { parent: true; category: true } }>;

function toInventoryRow(v: VariantWithParent) {
  return {
    id: v.id,
    sku: v.sku,
    parentId: v.parentId,
    productName: v.parent.name,
    variantName: v.variantName ?? ([v.color, v.size].filter(Boolean).join(' / ') || null),
    categoryName: v.category?.name ?? null,
    price: money(v.price),
    stockQuantity: v.stockQuantity,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    stockStatus: stockStatus(v.stockQuantity),
    status: v.status,
    updatedAt: v.updatedAt,
  };
}
