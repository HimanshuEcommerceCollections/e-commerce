import type { ParentProduct, Prisma, PrismaClient, ProductCategory } from '@prisma/client';
import { z } from 'zod';
import { PRODUCT_STATUSES } from '../common/enums';
import {
  CategoryNotFoundError,
  ConcurrentUpdateError,
  ParentProductNotFoundError,
  ProductNotFoundError,
  SkuAlreadyExistsError,
  VariantCategoryMismatchError,
} from '../common/errors';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import {
  decimal,
  flag,
  integer,
  oneOf,
  optionalString,
  optionalUuid,
  requiredString,
} from '../common/validation';
import { TX, type Db } from '../db';
import {
  PRODUCT_INCLUDE,
  toDetailResponse,
  toSummaryResponse,
  toVariantResponse,
  type ProductWithRelations,
} from './product.mapper';

const ImageSchema = z.object({
  url: requiredString({ max: 2048 }),
  altText: optionalString({ max: 255 }),
  primary: flag(),
  width: integer({ positive: true }),
  height: integer({ positive: true }),
  contentType: optionalString({ max: 100 }),
  fileSizeBytes: integer({ positive: true }),
  storageKey: optionalString({ max: 512 }),
});

const images = z
  .array(ImageSchema, { invalid_type_error: 'must be an array' })
  .max(10, 'size must be between 0 and 10')
  .nullish();

const variantFields = {
  variantName: optionalString({ max: 150 }),
  color: optionalString({ max: 50 }),
  size: optionalString({ max: 50 }),
  material: optionalString({ max: 100 }),
  pattern: optionalString({ max: 100 }),
  style: optionalString({ max: 100 }),
};

/**
 * Creates one variant SKU. `parentProductCode` groups variants under one parent
 * product (FR-IM-02): an existing code attaches this SKU to that parent; a new
 * code — or none, which defaults to the SKU — creates the parent from this
 * request's name, brand, description and category.
 */
export const ProductCreateSchema = z.object({
  name: requiredString({ max: 255 }),
  description: optionalString({ max: 5000 }),
  price: decimal({ required: true, positive: true }),
  stockQuantity: integer({ required: true, positiveOrZero: true }),
  sku: requiredString({ max: 100 }),
  categoryId: optionalUuid(),
  images,
  parentProductCode: optionalString({
    max: 100,
    pattern: /^[A-Za-z0-9._-]*$/,
    patternMessage: "May contain only letters, digits, '.', '_' and '-'",
  }),
  brand: optionalString({ max: 100 }),
  ...variantFields,
});

/** Partial update: absent or null fields keep their value. */
export const ProductUpdateSchema = z.object({
  name: optionalString({ max: 255 }),
  description: optionalString({ max: 5000 }),
  price: decimal({ positive: true }),
  stockQuantity: integer({ positiveOrZero: true }),
  sku: optionalString({ max: 100 }),
  status: oneOf(PRODUCT_STATUSES),
  categoryId: optionalUuid(),
  images,
  ...variantFields,
});

type ImageInput = z.output<typeof ImageSchema>;

export const PRODUCT_SORTS = ['createdAt', 'updatedAt', 'name', 'price', 'stockQuantity', 'sku', 'status'] as const;

export class ProductService {
  constructor(private readonly prisma: PrismaClient) {}

  create(input: z.output<typeof ProductCreateSchema>, merchantId: string) {
    return this.prisma.$transaction(async (tx) => {
      // SKUs are unique across soft-deleted rows too (uk_products_sku).
      if (await tx.product.findUnique({ where: { sku: input.sku } })) {
        throw new SkuAlreadyExistsError(input.sku);
      }
      const requestedCategory = await resolveCategory(tx, input.categoryId);
      const parentCode = input.parentProductCode?.trim() ? input.parentProductCode : input.sku;
      const parent = await resolveOrCreateParent(tx, parentCode, merchantId, input, requestedCategory);

      const product = await tx.product.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          price: input.price,
          stockQuantity: input.stockQuantity,
          sku: input.sku,
          status: 'DRAFT',
          categoryId: parent.categoryId,
          parentId: parent.id,
          variantName: input.variantName ?? null,
          color: input.color ?? null,
          size: input.size ?? null,
          material: input.material ?? null,
          pattern: input.pattern ?? null,
          style: input.style ?? null,
          merchantId,
          version: 0n,
          images: { create: imageRows(input.images) },
        },
        include: PRODUCT_INCLUDE,
      });
      return toDetail(tx, product, true);
    }, TX.default);
  }

  update(productId: string, input: z.output<typeof ProductUpdateSchema>, merchantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const product = await getOwnedProduct(tx, productId, merchantId);

      if (input.sku !== undefined && input.sku !== product.sku) {
        const clash = await tx.product.findFirst({ where: { sku: input.sku, id: { not: productId } } });
        if (clash) throw new SkuAlreadyExistsError(input.sku);
      }

      const data: Prisma.ProductUncheckedUpdateManyInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.price !== undefined) data.price = input.price;
      if (input.stockQuantity !== undefined) data.stockQuantity = input.stockQuantity;
      if (input.sku !== undefined) data.sku = input.sku;
      if (input.status !== undefined) data.status = input.status;
      for (const key of ['variantName', 'color', 'size', 'material', 'pattern', 'style'] as const) {
        if (input[key] !== undefined) data[key] = input[key];
      }

      if (input.categoryId !== undefined) {
        // Category belongs to the parent, so moving one variant moves all of them.
        const category = await resolveCategory(tx, input.categoryId);
        await tx.parentProduct.update({ where: { id: product.parentId }, data: { categoryId: category?.id ?? null } });
        await tx.product.updateMany({
          where: { parentId: product.parentId, deleted: false, id: { not: productId } },
          data: { categoryId: category?.id ?? null },
        });
        data.categoryId = category?.id ?? null;
      }

      if (input.images) {
        // Full replacement of the gallery, in the given order.
        await tx.productImage.deleteMany({ where: { productId } });
        await tx.productImage.createMany({ data: imageRows(input.images).map((i) => ({ ...i, productId })) });
      }

      // Optimistic lock on the version read above (was JPA @Version).
      const updated = await tx.product.updateMany({
        where: { id: productId, version: product.version },
        data: { ...data, version: (product.version ?? -1n) + 1n },
      });
      if (updated.count === 0) throw new ConcurrentUpdateError();

      const fresh = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: PRODUCT_INCLUDE });
      return toDetail(tx, fresh, true);
    }, TX.default);
  }

  softDelete(productId: string, merchantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const product = await getOwnedProduct(tx, productId, merchantId);
      await tx.product.update({ where: { id: productId }, data: { deleted: true } });

      // The last variant going takes its parent with it, so the parent never
      // lingers as an empty product.
      const remaining = await tx.product.count({ where: { parentId: product.parentId, deleted: false } });
      if (remaining === 0) {
        await tx.parentProduct.update({ where: { id: product.parentId }, data: { deleted: true } });
      }
    }, TX.default);
  }

  /**
   * ACTIVE products are visible to everyone. Others (DRAFT/INACTIVE/ARCHIVED)
   * only to their owning merchant or an admin; anyone else gets a 404, which
   * also avoids confirming the product exists.
   */
  async findById(id: string, requesterId: string | null, isAdmin: boolean) {
    const product = await this.prisma.product.findFirst({ where: { id, deleted: false }, include: PRODUCT_INCLUDE });
    if (!product) throw new ProductNotFoundError(id);

    const canSeeUnpublished = isAdmin || product.merchantId === requesterId;
    if (product.status !== 'ACTIVE' && !canSeeUnpublished) throw new ProductNotFoundError(id);
    return toDetail(this.prisma, product, canSeeUnpublished);
  }

  findAllActive(pageable: Pageable) {
    return this.page({ status: 'ACTIVE', deleted: false }, pageable);
  }

  findByMerchant(merchantId: string, pageable: Pageable) {
    return this.page({ merchantId, deleted: false }, pageable);
  }

  findByCategory(categoryId: string, pageable: Pageable) {
    return this.page({ categoryId, status: 'ACTIVE', deleted: false }, pageable);
  }

  private async page(where: Prisma.ProductWhereInput, pageable: Pageable) {
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: PRODUCT_INCLUDE, orderBy: orderBy(pageable), ...skipTake(pageable) }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(rows.map(toSummaryResponse), total, pageable);
  }
}

/** Detail view with the parent's variant list; unpublished siblings only for privileged callers. */
async function toDetail(db: Db, product: ProductWithRelations, includeUnpublished: boolean) {
  const siblings = await db.product.findMany({
    where: { parentId: product.parentId, deleted: false },
    include: { images: { where: { deleted: false }, orderBy: { position: 'asc' } } },
    orderBy: { sku: 'asc' },
  });
  const variants = siblings
    .filter((v) => includeUnpublished || v.status === 'ACTIVE')
    .map(toVariantResponse);
  return toDetailResponse(product, variants);
}

/**
 * A product owned by another merchant reports as not found (404), not
 * forbidden: a 403 would confirm the id exists.
 */
async function getOwnedProduct(db: Db, productId: string, merchantId: string) {
  const product = await db.product.findFirst({ where: { id: productId, deleted: false } });
  if (!product || product.merchantId !== merchantId) throw new ProductNotFoundError(productId);
  return product;
}

async function resolveCategory(db: Db, categoryId: string | undefined): Promise<ProductCategory | null> {
  if (!categoryId) return null;
  const category = await db.productCategory.findFirst({ where: { id: categoryId, deleted: false } });
  if (!category) throw new CategoryNotFoundError(categoryId);
  return category;
}

/**
 * Finds the parent by code, or creates it from this request. An existing
 * parent must belong to the caller (anything else reports as not found) and
 * fixes the category: a request naming a different one is rejected.
 */
async function resolveOrCreateParent(
  db: Db,
  code: string,
  merchantId: string,
  input: z.output<typeof ProductCreateSchema>,
  requestedCategory: ProductCategory | null,
): Promise<ParentProduct> {
  const existing = await db.parentProduct.findUnique({ where: { code } });
  if (existing) {
    if (existing.deleted || existing.merchantId !== merchantId) throw new ParentProductNotFoundError(code);
    if (requestedCategory && existing.categoryId !== requestedCategory.id) {
      throw new VariantCategoryMismatchError(code);
    }
    return existing;
  }
  return db.parentProduct.create({
    data: {
      code,
      name: input.name,
      brand: input.brand ?? null,
      description: input.description ?? null,
      categoryId: requestedCategory?.id ?? null,
      merchantId,
    },
  });
}

/**
 * Gallery rows in request order (position = index). Exactly one is primary:
 * the first flagged one, or else the first image.
 */
function imageRows(requested: ImageInput[] | null | undefined) {
  if (!requested?.length) return [];
  const primaryIndex = Math.max(0, requested.findIndex((i) => i.primary));
  return requested.map((img, i) => ({
    url: img.url,
    altText: img.altText ?? null,
    position: i,
    isPrimary: i === primaryIndex,
    width: img.width ?? null,
    height: img.height ?? null,
    contentType: img.contentType ?? null,
    fileSizeBytes: img.fileSizeBytes === undefined ? null : BigInt(img.fileSizeBytes),
    storageKey: img.storageKey ?? null,
  }));
}
