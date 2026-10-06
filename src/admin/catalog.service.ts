import { Prisma, type PrismaClient, type ProductImage } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { PRODUCT_STATUSES, type ProductStatus } from '../common/enums';
import { CategoryNotFoundError, DomainError, ProductNotFoundError } from '../common/errors';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import {
  ValidationError,
  decimal,
  integer,
  oneOf,
  optionalString,
  optionalUuid,
  requiredString,
  requiredUuid,
} from '../common/validation';
import { TX } from '../db';
import type { ImageCheckService } from '../product/image-check';
import { ImportRow, keyOf, COLUMNS, IMAGE_COLUMNS } from '../product/importer/columns';
import type { CatalogImportService } from '../product/importer/import.service';
import { SLUG } from '../product/importer/slugs';
import { attributesOf, primaryImageUrl } from '../product/product.mapper';

export const ADMIN_PRODUCT_SORTS = ['updatedAt', 'createdAt', 'name', 'code'] as const;
export const ADMIN_INVENTORY_SORTS = ['sku', 'stockQuantity', 'updatedAt', 'price'] as const;
export const STOCK_MOVEMENT_SORTS = ['createdAt'] as const;
export const IMAGE_ISSUE_SORTS = ['checkedAt', 'url'] as const;

const status = () => oneOf(PRODUCT_STATUSES);

/** Optional boolean: absent leaves the value alone. */
const optionalBoolean = () =>
  z.unknown().transform((v, ctx): boolean | undefined => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a boolean' });
    return z.NEVER;
  });

const percent = () => decimal({ positiveOrZero: true, max: 100 });
const money2 = (rules: { positive?: boolean; positiveOrZero?: boolean }) =>
  decimal({ ...rules, max: 9_999_999_999.99 }).superRefine((v, ctx) => {
    if (v && v.decimalPlaces() > 2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must have at most 2 decimal places' });
  });

export const ParentUpdateSchema = z.object({
  name: optionalString({ max: 255 }),
  brand: optionalString({ max: 100 }),
  status: status(),
  productType: optionalString({ max: 100 }),
  shortDescription: optionalString({ max: 1000 }),
  description: optionalString({ max: 10000 }),
  subcategoryId: optionalUuid(),
  featured: optionalBoolean(),
  /** One bullet per entry. */
  keyFeatures: z.array(z.string().max(500, 'size must be between 0 and 500')).max(30).optional(),
});

export const VariantUpdateSchema = z.object({
  price: money2({ positive: true }),
  /** 0 removes the MRP. */
  mrp: money2({ positiveOrZero: true }),
  cost: money2({ positiveOrZero: true }),
  taxCode: optionalString({ max: 50 }),
  taxRate: percent(),
  lowStockThreshold: integer({ positiveOrZero: true }),
  clearLowStockThreshold: optionalBoolean(),
  stockQuantity: integer({ positiveOrZero: true }),
  status: status(),
  urlSlug: optionalString({ max: 255, pattern: SLUG, patternMessage: 'must be lowercase letters, digits and single hyphens' }),
  seoTitle: optionalString({ max: 255 }),
  metaDescription: optionalString({ max: 500 }),
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

const ProductVariantCreate = z.object({
  sku: optionalString({ max: 100, pattern: /^[A-Za-z0-9._-]*$/, patternMessage: "may contain only letters, digits, '.', '_' and '-'" }),
  variantName: optionalString({ max: 150 }),
  color: optionalString({ max: 50 }),
  size: optionalString({ max: 50 }),
  price: money2({ positive: true }).refine((v) => v !== undefined, 'must not be null'),
  mrp: money2({ positiveOrZero: true }),
  taxRate: percent(),
  stockQuantity: integer({ required: true, positiveOrZero: true }),
  lowStockThreshold: integer({ positiveOrZero: true }),
  imageUrls: z
    .array(z.string().url('must be a valid URL').max(2048), { required_error: 'must not be null', invalid_type_error: 'must be an array' })
    .min(1, 'must have at least one image URL')
    .max(5, 'size must be between 1 and 5'),
});

export const ProductCreateSchema = z.object({
  name: requiredString({ max: 255 }),
  brand: optionalString({ max: 100 }),
  subcategoryId: requiredUuid(),
  productType: optionalString({ max: 100 }),
  shortDescription: optionalString({ max: 1000 }),
  description: optionalString({ max: 10000 }),
  status: oneOf(PRODUCT_STATUSES).refine((v) => v !== undefined, 'must not be null'),
  featured: optionalBoolean(),
  variants: z
    .array(ProductVariantCreate, { required_error: 'must not be null', invalid_type_error: 'must be an array' })
    .min(1, 'must have at least one variant')
    .max(100, 'size must be between 1 and 100'),
});

export interface ProductFilter {
  search?: string;
  status?: ProductStatus;
  categoryId?: string;
  subcategoryId?: string;
}

export interface InventoryFilter {
  search?: string;
  categoryId?: string;
  /** `low` is low or out of stock. */
  stock?: 'low' | 'out';
}

export interface Staff {
  id: string;
  email: string;
}

const LIVE_IMAGES = { where: { deleted: false }, orderBy: { position: 'asc' } } as const;
const PRODUCT_ROW_INCLUDE = {
  category: true,
  subcategory: true,
  variants: { where: { deleted: false }, include: { images: LIVE_IMAGES }, orderBy: { sku: 'asc' } },
} satisfies Prisma.ParentProductInclude;
const INVENTORY_INCLUDE = { parent: true, category: true } satisfies Prisma.ProductInclude;

/** Blank text clears an optional field. */
const blankToNull = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? null : v.trim());

/**
 * Catalog side of the admin panel (FR-AD-01/03/05, FR-IM-08/11): products and
 * variants across every merchant, inventory with per-SKU low-stock levels and
 * a stock movement log, and image URL checks. Open to ROLE_ADMIN and
 * ROLE_CATALOG (FR-AD-08).
 */
export class CatalogAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly importer: CatalogImportService,
    private readonly images: ImageCheckService,
    /** Store default (LOW_STOCK_THRESHOLD); a SKU's own threshold wins. */
    private readonly lowStockThreshold: number,
  ) {}

  // ── Products (parents with their variant SKUs) ────────────────────────────

  async listProducts(filter: ProductFilter, pageable: Pageable) {
    const where = productWhere(filter);
    const [rows, total] = await Promise.all([
      this.prisma.parentProduct.findMany({
        where,
        include: PRODUCT_ROW_INCLUDE,
        orderBy: orderBy(pageable, []),
        ...skipTake(pageable),
      }),
      this.prisma.parentProduct.count({ where }),
    ]);
    return toPage(rows.map((p) => this.toProductRow(p)), total, pageable);
  }

  /** Products per status for the tabs; a product counts once per status its variants have. */
  async productStatusCounts(filter: Omit<ProductFilter, 'status'>) {
    const counts = await Promise.all(
      [undefined, ...PRODUCT_STATUSES].map((s) => this.prisma.parentProduct.count({ where: productWhere({ ...filter, status: s }) })),
    );
    return Object.fromEntries([['ALL', counts[0]], ...PRODUCT_STATUSES.map((s, i) => [s, counts[i + 1]])]);
  }

  async getProduct(parentId: string) {
    const parent = await this.prisma.parentProduct.findFirst({ where: { id: parentId, deleted: false }, include: PRODUCT_ROW_INCLUDE });
    if (!parent) throw new ProductNotFoundError(parentId);
    const features = (parent.keyFeatures ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return {
      ...this.toProductRow(parent),
      shortDescription: parent.shortDescription,
      description: parent.description,
      keyFeatures: features.length ? features : null,
      attributes: attributesOf(parent.attributes),
      variants: parent.variants.map((v) => this.toVariant(v)),
    };
  }

  /**
   * Add product (FR-AD-01): one new parent with its variants, through the
   * importer, so the checks, generated codes (GS-CL-MEN-001-BLK-M), URL slugs,
   * stock log and image checks are the bulk import's. All or nothing.
   */
  async createProduct(input: z.output<typeof ProductCreateSchema>, staff: Staff) {
    const section = await this.prisma.productCategory.findFirst({
      where: { id: input.subcategoryId, deleted: false },
      include: { parent: true },
    });
    if (!section) throw new CategoryNotFoundError(input.subcategoryId);
    if (!section.parent) throw new ValidationError({ subcategoryId: 'must be a subcategory, not a department' });

    const headers = [
      ...new Set([
        ...[
          COLUMNS.SKU_ID, COLUMNS.PRODUCT_NAME, COLUMNS.BRAND, COLUMNS.CATEGORY, COLUMNS.SUBCATEGORY, COLUMNS.PRODUCT_TYPE,
          COLUMNS.PRODUCT_STATUS, COLUMNS.FEATURED, COLUMNS.SHORT_DESCRIPTION, COLUMNS.LONG_DESCRIPTION, COLUMNS.VARIANT_NAME,
          COLUMNS.COLOR, COLUMNS.SIZE, COLUMNS.SELLING_PRICE, COLUMNS.MRP, COLUMNS.TAX_RATE, COLUMNS.INVENTORY_QTY,
          COLUMNS.LOW_STOCK_THRESHOLD,
        ].map(keyOf),
        ...IMAGE_COLUMNS.map(keyOf),
      ]),
    ];
    const rows = input.variants.map((v, i) => {
      const cells: [typeof COLUMNS[keyof typeof COLUMNS], string | undefined][] = [
        [COLUMNS.SKU_ID, v.sku],
        [COLUMNS.PRODUCT_NAME, input.name],
        [COLUMNS.BRAND, input.brand],
        [COLUMNS.CATEGORY, section.parent!.slug],
        [COLUMNS.SUBCATEGORY, section.slug],
        [COLUMNS.PRODUCT_TYPE, input.productType],
        [COLUMNS.PRODUCT_STATUS, input.status],
        [COLUMNS.FEATURED, input.featured ? 'TRUE' : 'FALSE'],
        [COLUMNS.SHORT_DESCRIPTION, input.shortDescription],
        [COLUMNS.LONG_DESCRIPTION, input.description],
        [COLUMNS.VARIANT_NAME, v.variantName ?? ([v.color, v.size].filter(Boolean).join(' / ') || undefined)],
        [COLUMNS.COLOR, v.color],
        [COLUMNS.SIZE, v.size],
        [COLUMNS.SELLING_PRICE, v.price?.toFixed(2)],
        [COLUMNS.MRP, v.mrp?.toFixed(2)],
        [COLUMNS.TAX_RATE, v.taxRate?.toFixed(2)],
        [COLUMNS.INVENTORY_QTY, String(v.stockQuantity)],
        [COLUMNS.LOW_STOCK_THRESHOLD, v.lowStockThreshold === undefined ? undefined : String(v.lowStockThreshold)],
        ...IMAGE_COLUMNS.map((c, n) => [c, v.imageUrls[n]] as [typeof c, string | undefined]),
      ];
      const values = new Map(headers.map((h) => [h, '']));
      for (const [column, value] of cells) values.set(keyOf(column), value ?? '');
      return new ImportRow(i, values);
    });

    const report = await this.importer.importRows('Add product', headers, rows, staff.id, {
      staff: true,
      actor: staff.email,
      mode: 'create',
      atomic: true,
    });
    if (report.errors.length) {
      throw new ValidationError(Object.fromEntries(report.errors.map((e) => [`variants[${e.row}]`, e.reason])));
    }
    const parent = await this.prisma.parentProduct.findUniqueOrThrow({ where: { code: report.imported[0].parentProductId } });
    return this.getProduct(parent.id);
  }

  /** Content goes on the parent; status on every variant; a new section may move the product to its department. */
  async updateProduct(parentId: string, input: z.output<typeof ParentUpdateSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const parent = await tx.parentProduct.findFirst({ where: { id: parentId, deleted: false } });
      if (!parent) throw new ProductNotFoundError(parentId);
      let categoryId: string | undefined;
      if (input.subcategoryId) {
        const section = await tx.productCategory.findFirst({ where: { id: input.subcategoryId, deleted: false } });
        if (!section) throw new CategoryNotFoundError(input.subcategoryId);
        if (!section.parentId) throw new ValidationError({ subcategoryId: 'must be a subcategory, not a department' });
        categoryId = section.parentId;
      }
      if (input.name !== undefined && input.name.trim() === '') throw new ValidationError({ name: 'must not be blank' });
      await tx.parentProduct.update({
        where: { id: parentId },
        data: {
          name: input.name?.trim(),
          brand: blankToNull(input.brand),
          productType: blankToNull(input.productType),
          shortDescription: blankToNull(input.shortDescription),
          description: blankToNull(input.description),
          subcategoryId: input.subcategoryId,
          categoryId,
          featured: input.featured,
          keyFeatures: input.keyFeatures ? input.keyFeatures.map((f) => f.trim()).filter(Boolean).join('\n') || null : undefined,
        },
      });
      if (categoryId && categoryId !== parent.categoryId) {
        await tx.product.updateMany({ where: { parentId }, data: { categoryId } });
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

  /**
   * Price, MRP, cost, tax, threshold, SEO and status of one SKU (FR-AD-05).
   * A new stock level is written under the row lock and logged (NFR-08).
   */
  async updateVariant(id: string, input: z.output<typeof VariantUpdateSchema>, staff: Staff) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid AND deleted = false FOR UPDATE`;
        const v = await tx.product.findFirst({ where: { id, deleted: false } });
        if (!v) throw new ProductNotFoundError(id);

        const price = input.price ?? v.price;
        const mrp = input.mrp === undefined ? v.mrp : input.mrp.isZero() ? null : input.mrp;
        if (mrp && mrp.lt(price)) {
          throw new ValidationError({ mrp: `must not be less than the price (${price.toFixed(2)})` });
        }
        if (input.urlSlug) {
          const owner = await tx.product.findFirst({ where: { urlSlug: input.urlSlug, id: { not: id } }, select: { sku: true } });
          if (owner) throw new DomainError(409, `URL slug '${input.urlSlug}' is already used by SKU ${owner.sku}`);
        }
        const data: Prisma.ProductUpdateInput = {
          price: input.price,
          mrp: input.mrp === undefined ? undefined : mrp,
          cost: input.cost,
          taxCode: blankToNull(input.taxCode),
          taxRate: input.taxRate,
          lowStockThreshold: input.clearLowStockThreshold ? null : input.lowStockThreshold,
          status: input.status,
          urlSlug: input.urlSlug,
          seoTitle: blankToNull(input.seoTitle),
          metaDescription: blankToNull(input.metaDescription),
          stockQuantity: input.stockQuantity,
          version: { increment: 1 },
        };
        const updated = await tx.product.update({ where: { id }, data, include: INVENTORY_INCLUDE });
        if (input.stockQuantity !== undefined && input.stockQuantity !== v.stockQuantity) {
          await tx.stockMovement.create({
            data: {
              productId: id,
              delta: input.stockQuantity - v.stockQuantity,
              quantityAfter: input.stockQuantity,
              source: 'ADJUSTMENT',
              reason: 'Stock level set',
              actor: staff.email,
            },
          });
        }
        return this.toInventoryRow(updated);
      }, TX.default);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(409, `URL slug '${input.urlSlug}' is already used by another SKU`);
      }
      throw e;
    }
  }

  // ── Inventory (one row per SKU) ───────────────────────────────────────────

  async listInventory(filter: InventoryFilter, pageable: Pageable) {
    const where = this.inventoryWhere(filter);
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: INVENTORY_INCLUDE, orderBy: orderBy(pageable), ...skipTake(pageable) }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(rows.map((r) => this.toInventoryRow(r)), total, pageable);
  }

  async inventoryStats() {
    const live = { deleted: false, parent: { deleted: false } } satisfies Prisma.ProductWhereInput;
    const [skus, units, low, out] = await Promise.all([
      this.prisma.product.count({ where: live }),
      this.prisma.product.aggregate({ where: live, _sum: { stockQuantity: true } }),
      this.prisma.product.count({ where: { AND: [live, { stockQuantity: { gt: 0 } }, this.atOrBelowThreshold()] } }),
      this.prisma.product.count({ where: { ...live, stockQuantity: 0 } }),
    ]);
    return {
      skus,
      units: units._sum.stockQuantity ?? 0,
      lowStock: low,
      outOfStock: out,
      lowStockThreshold: this.lowStockThreshold,
    };
  }

  /**
   * Adds `delta` (negative to remove) in one conditional UPDATE, so a
   * concurrent checkout can't be overwritten or drive stock below zero
   * (NFR-08), and logs it in the same transaction.
   */
  async adjustStock(id: string, input: z.output<typeof StockAdjustmentSchema>, staff: Staff) {
    if (input.delta === 0) throw new ValidationError({ delta: 'must not be 0' });
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.product.updateMany({
        where: { id, deleted: false, ...(input.delta < 0 ? { stockQuantity: { gte: -input.delta } } : {}) },
        data: { stockQuantity: { increment: input.delta }, version: { increment: 1 } },
      });
      if (count === 0) {
        const exists = await tx.product.findFirst({ where: { id, deleted: false }, select: { stockQuantity: true } });
        if (!exists) throw new ProductNotFoundError(id);
        throw new DomainError(409, `Only ${exists.stockQuantity} in stock; can't remove ${-input.delta}`);
      }
      // The UPDATE holds the row lock, so this is the level it wrote.
      const product = await tx.product.findUniqueOrThrow({ where: { id }, include: INVENTORY_INCLUDE });
      await tx.stockMovement.create({
        data: {
          productId: id,
          delta: input.delta,
          quantityAfter: product.stockQuantity,
          source: 'ADJUSTMENT',
          reason: input.reason?.trim() || null,
          actor: staff.email,
        },
      });
      return this.toInventoryRow(product);
    }, TX.default);
  }

  async stockMovements(productId: string, pageable: Pageable) {
    const product = await this.prisma.product.findFirst({ where: { id: productId }, select: { id: true } });
    if (!product) throw new ProductNotFoundError(productId);
    const where = { productId };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({ where, orderBy: orderBy(pageable, []), ...skipTake(pageable) }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return toPage(
      rows.map((m) => ({
        id: m.id,
        delta: m.delta,
        quantityAfter: m.quantityAfter,
        source: m.source,
        reason: m.reason,
        actor: m.actor,
        createdAt: m.createdAt,
      })),
      total,
      pageable,
    );
  }

  // ── Image checks (FR-IM-08) ───────────────────────────────────────────────

  async imageIssues(pageable: Pageable) {
    const live = { deleted: false, product: { deleted: false, parent: { deleted: false } } } satisfies Prisma.ProductImageWhereInput;
    const where = { ...live, checkStatus: 'BROKEN' };
    const [rows, total, unchecked] = await Promise.all([
      this.prisma.productImage.findMany({
        where,
        include: { product: { select: { id: true, sku: true, name: true, status: true, parentId: true } } },
        orderBy: orderBy(pageable, []),
        ...skipTake(pageable),
      }),
      this.prisma.productImage.count({ where }),
      this.prisma.productImage.count({ where: { ...live, OR: [{ checkStatus: null }, { checkStatus: 'UNCHECKED' }] } }),
    ]);
    const page = toPage(
      rows.map((i) => ({
        imageId: i.id,
        url: i.url,
        error: i.checkError,
        checkedAt: i.checkedAt,
        position: i.position,
        sku: i.product.sku,
        productId: i.product.id,
        parentId: i.product.parentId,
        productName: i.product.name,
        status: i.product.status,
      })),
      total,
      pageable,
    );
    return { ...page, uncheckedImages: unchecked };
  }

  recheckImages(scope: 'problems' | 'all') {
    return this.images.recheck(scope);
  }

  // ── Shapes ────────────────────────────────────────────────────────────────

  private thresholdOf(v: { lowStockThreshold: number | null }) {
    return v.lowStockThreshold ?? this.lowStockThreshold;
  }

  private stockStatus(v: { stockQuantity: number; lowStockThreshold: number | null }) {
    return v.stockQuantity === 0 ? 'OUT_OF_STOCK' : v.stockQuantity <= this.thresholdOf(v) ? 'LOW_STOCK' : 'IN_STOCK';
  }

  /** Stock at or below the SKU's own threshold, or the store default when it has none. */
  private atOrBelowThreshold(): Prisma.ProductWhereInput {
    return {
      OR: [
        { lowStockThreshold: null, stockQuantity: { lte: this.lowStockThreshold } },
        { lowStockThreshold: { not: null }, stockQuantity: { lte: this.prisma.product.fields.lowStockThreshold } },
      ],
    };
  }

  private inventoryWhere(f: InventoryFilter): Prisma.ProductWhereInput {
    const and: Prisma.ProductWhereInput[] = [{ deleted: false }, { parent: { deleted: false } }];
    if (f.categoryId) {
      and.push({ OR: [{ categoryId: f.categoryId }, { parent: { categoryId: f.categoryId } }, { parent: { subcategoryId: f.categoryId } }] });
    }
    if (f.stock === 'low') and.push(this.atOrBelowThreshold());
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

  private toProductRow(p: Prisma.ParentProductGetPayload<{ include: typeof PRODUCT_ROW_INCLUDE }>) {
    const prices = p.variants.map((v) => v.price);
    const min = prices.reduce<Prisma.Decimal | null>((a, b) => (a === null || b.lt(a) ? b : a), null);
    const max = prices.reduce<Prisma.Decimal | null>((a, b) => (a === null || b.gt(a) ? b : a), null);
    const statuses = [...new Set(p.variants.map((v) => v.status))];
    const updated = p.variants.reduce((d, v) => (v.updatedAt > d ? v.updatedAt : d), p.updatedAt);
    const ref = (c: { id: string; name: string } | null) => (c ? { id: c.id, name: c.name } : null);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      brand: p.brand,
      category: ref(p.category),
      subcategory: ref(p.subcategory),
      productType: p.productType,
      featured: p.featured,
      variantCount: p.variants.length,
      minPrice: min && money(min),
      maxPrice: max && money(max),
      totalStock: p.variants.reduce((n, v) => n + v.stockQuantity, 0),
      lowStockVariants: p.variants.filter((v) => v.stockQuantity <= this.thresholdOf(v)).length,
      brokenImages: p.variants.reduce((n, v) => n + v.images.filter((i) => i.checkStatus === 'BROKEN').length, 0),
      /** The variants' status when they agree, otherwise MIXED. */
      status: statuses.length === 1 ? statuses[0] : 'MIXED',
      primaryImageUrl: primaryImageUrl(p.variants[0]?.images ?? []),
      updatedAt: updated,
    };
  }

  private toVariant(v: Prisma.ProductGetPayload<object> & { images: ProductImage[] }) {
    const orNull = (d: Prisma.Decimal | null) => (d === null ? null : money(d));
    return {
      id: v.id,
      sku: v.sku,
      variantName: v.variantName,
      color: v.color,
      size: v.size,
      price: money(v.price),
      mrp: orNull(v.mrp),
      cost: orNull(v.cost),
      taxCode: v.taxCode,
      taxRate: orNull(v.taxRate),
      stockQuantity: v.stockQuantity,
      lowStockThreshold: this.thresholdOf(v),
      ownLowStockThreshold: v.lowStockThreshold,
      status: v.status,
      stockStatus: this.stockStatus(v),
      urlSlug: v.urlSlug,
      seoTitle: v.seoTitle,
      metaDescription: v.metaDescription,
      primaryImageUrl: primaryImageUrl(v.images),
      imageUrls: v.images.map((i) => i.url),
      images: v.images.map((i) => ({ url: i.url, checkStatus: i.checkStatus, checkError: i.checkError })),
    };
  }

  private toInventoryRow(v: Prisma.ProductGetPayload<{ include: typeof INVENTORY_INCLUDE }>) {
    return {
      id: v.id,
      sku: v.sku,
      warehouseId: v.warehouseId,
      parentId: v.parentId,
      productName: v.parent.name,
      variantName: v.variantName ?? ([v.color, v.size].filter(Boolean).join(' / ') || null),
      categoryName: v.category?.name ?? null,
      price: money(v.price),
      mrp: v.mrp === null ? null : money(v.mrp),
      taxRate: v.taxRate === null ? null : money(v.taxRate),
      stockQuantity: v.stockQuantity,
      lowStockThreshold: this.thresholdOf(v),
      ownLowStockThreshold: v.lowStockThreshold,
      stockStatus: this.stockStatus(v),
      status: v.status,
      updatedAt: v.updatedAt,
    };
  }
}

function productWhere(f: ProductFilter): Prisma.ParentProductWhereInput {
  const and: Prisma.ParentProductWhereInput[] = [{ deleted: false }, { variants: { some: { deleted: false } } }];
  if (f.categoryId) and.push({ OR: [{ categoryId: f.categoryId }, { subcategoryId: f.categoryId }] });
  if (f.subcategoryId) and.push({ subcategoryId: f.subcategoryId });
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
