import type { ParentProduct, Prisma, Product, ProductCategory, ProductImage } from '@prisma/client';
import { bigint, money } from '../common/api-response';

/** A product row with everything the responses render. */
export const PRODUCT_INCLUDE = {
  category: true,
  parent: true,
  images: { where: { deleted: false }, orderBy: { position: 'asc' } },
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Product & {
  category: ProductCategory | null;
  parent: ParentProduct;
  images: ProductImage[];
};

export function toCategoryResponse(c: ProductCategory) {
  return { id: c.id, name: c.name, slug: c.slug, description: c.description };
}

/** The primary image, or failing that the first by position. */
export function primaryImageUrl(images: ProductImage[]): string | null {
  return (images.find((i) => i.isPrimary) ?? images[0])?.url ?? null;
}

export function toImageResponse(i: ProductImage) {
  return {
    id: i.id,
    url: i.url,
    altText: i.altText,
    position: i.position,
    primary: i.isPrimary,
    width: i.width,
    height: i.height,
    contentType: i.contentType,
    fileSizeBytes: bigint(i.fileSizeBytes),
    storageKey: i.storageKey,
  };
}

export function toParentResponse(p: ParentProduct) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    brand: p.brand,
    shortDescription: p.shortDescription,
    description: p.description,
  };
}

export function toVariantResponse(p: Product & { images: ProductImage[] }) {
  return {
    id: p.id,
    sku: p.sku,
    variantName: p.variantName,
    color: p.color,
    size: p.size,
    material: p.material,
    pattern: p.pattern,
    style: p.style,
    price: money(p.price),
    stockQuantity: p.stockQuantity,
    status: p.status,
    primaryImageUrl: primaryImageUrl(p.images),
  };
}

export function toSummaryResponse(p: ProductWithRelations) {
  return {
    id: p.id,
    name: p.name,
    price: money(p.price),
    stockQuantity: p.stockQuantity,
    sku: p.sku,
    status: p.status,
    categoryName: p.category?.name ?? null,
    primaryImageUrl: primaryImageUrl(p.images),
    parentId: p.parent.id,
    parentCode: p.parent.code,
    brand: p.parent.brand,
    variantName: p.variantName,
    color: p.color,
    size: p.size,
    merchantId: p.merchantId,
    createdAt: p.createdAt,
  };
}

export function toDetailResponse(p: ProductWithRelations, variants: ReturnType<typeof toVariantResponse>[]) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: money(p.price),
    stockQuantity: p.stockQuantity,
    sku: p.sku,
    status: p.status,
    variantName: p.variantName,
    color: p.color,
    size: p.size,
    material: p.material,
    pattern: p.pattern,
    style: p.style,
    category: p.category ? toCategoryResponse(p.category) : null,
    parent: toParentResponse(p.parent),
    variants,
    images: p.images.map(toImageResponse),
    merchantId: p.merchantId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
