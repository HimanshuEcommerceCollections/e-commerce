import type { ParentProduct, Prisma, Product, ProductCategory, ProductImage } from '@prisma/client';
import { bigint, money } from '../common/api-response';
import { discountPercent } from '../order/pricing';

/** A product row with everything the responses render. */
export const PRODUCT_INCLUDE = {
  category: { include: { parent: true } },
  parent: { include: { category: { include: { parent: true } }, subcategory: true } },
  images: { where: { deleted: false }, orderBy: { position: 'asc' } },
} satisfies Prisma.ProductInclude;

type CategoryWithParent = ProductCategory & { parent: ProductCategory | null };

export type ParentWithTaxonomy = ParentProduct & {
  category: CategoryWithParent | null;
  subcategory: ProductCategory | null;
};

export type ProductWithRelations = Product & {
  category: CategoryWithParent | null;
  parent: ParentWithTaxonomy;
  images: ProductImage[];
};

export function toCategoryResponse(c: ProductCategory) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    parentId: c.parentId,
    position: c.position,
    code: c.code,
  };
}

/**
 * Department and section of a product. The parent product carries both; a
 * category that is itself a section (an older row, or a SKU mapped straight
 * to a section) resolves to its department.
 */
export function taxonomyOf(p: { category: CategoryWithParent | null; parent: ParentWithTaxonomy }): {
  department: ProductCategory | null;
  subcategory: ProductCategory | null;
} {
  const assigned = p.parent.category ?? p.category;
  let subcategory = p.parent.subcategory;
  let department: ProductCategory | null = assigned;
  if (assigned?.parentId) {
    subcategory ??= assigned;
    department = assigned.parent;
  }
  return { department, subcategory };
}

/** The primary image, or failing that the first by position. */
export function primaryImageUrl(images: ProductImage[]): string | null {
  return (images.find((i) => i.isPrimary) ?? images[0])?.url ?? null;
}

/** Gallery URLs, primary first, then by position. */
export function imageUrls(images: ProductImage[]): string[] {
  const primary = images.find((i) => i.isPrimary) ?? images[0];
  return primary ? [primary.url, ...images.filter((i) => i !== primary).map((i) => i.url)] : [];
}

/**
 * The parent's category attribute values as strings (facet values). Multi-value
 * attributes stored as arrays are joined with ", ".
 */
export function attributesOf(json: Prisma.JsonValue): Record<string, string> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(json)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const joined = value.filter((v) => v !== null && v !== '').map(String).join(', ');
      if (joined) out[key] = joined;
    } else if (typeof value !== 'object') {
      out[key] = String(value);
    }
  }
  return out;
}

const moneyOrNull = (v: Prisma.Decimal | null) => (v === null ? null : money(v));

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

export function toParentResponse(p: ParentProduct & { subcategory?: ProductCategory | null }) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    brand: p.brand,
    shortDescription: p.shortDescription,
    description: p.description,
    productType: p.productType,
    subcategory: p.subcategory ? toCategoryResponse(p.subcategory) : null,
    keyFeatures: (p.keyFeatures ?? '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
      .filter(Boolean),
    whatsIncluded: p.whatsIncluded,
    usageInstructions: p.usageInstructions,
    warranty: p.warranty,
    lifestyleImageUrl: p.lifestyleImageUrl,
    sizeChartUrl: p.sizeChartUrl,
    infographicUrl: p.infographicUrl,
    attributes: attributesOf(p.attributes),
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
    mrp: moneyOrNull(p.mrp),
    discountPercent: discountPercent(p.price, p.mrp),
    taxRate: moneyOrNull(p.taxRate),
    stockQuantity: p.stockQuantity,
    lowStockThreshold: p.lowStockThreshold,
    status: p.status,
    primaryImageUrl: primaryImageUrl(p.images),
    imageUrls: imageUrls(p.images),
    urlSlug: p.urlSlug,
  };
}

/** PLP row. `unitsSold` comes from paid order lines (see ProductService). */
export function toSummaryResponse(p: ProductWithRelations, unitsSold = 0) {
  const { department, subcategory } = taxonomyOf(p);
  return {
    id: p.id,
    name: p.name,
    price: money(p.price),
    mrp: moneyOrNull(p.mrp),
    discountPercent: discountPercent(p.price, p.mrp),
    stockQuantity: p.stockQuantity,
    lowStockThreshold: p.lowStockThreshold,
    sku: p.sku,
    status: p.status,
    categoryId: department?.id ?? null,
    categoryName: department?.name ?? null,
    categorySlug: department?.slug ?? null,
    subcategoryId: subcategory?.id ?? null,
    subcategoryName: subcategory?.name ?? null,
    subcategorySlug: subcategory?.slug ?? null,
    productType: p.parent.productType,
    primaryImageUrl: primaryImageUrl(p.images),
    imageUrls: imageUrls(p.images),
    parentId: p.parent.id,
    parentCode: p.parent.code,
    parentName: p.parent.name,
    brand: p.parent.brand,
    featured: p.parent.featured,
    variantName: p.variantName,
    color: p.color,
    size: p.size,
    material: p.material,
    searchKeywords: p.searchKeywords,
    urlSlug: p.urlSlug,
    attributes: attributesOf(p.parent.attributes),
    unitsSold,
    merchantId: p.merchantId,
    createdAt: p.createdAt,
  };
}

export function toDetailResponse(p: ProductWithRelations, variants: ReturnType<typeof toVariantResponse>[]) {
  const { department, subcategory } = taxonomyOf(p);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: money(p.price),
    mrp: moneyOrNull(p.mrp),
    discountPercent: discountPercent(p.price, p.mrp),
    taxCode: p.taxCode,
    taxRate: moneyOrNull(p.taxRate),
    stockQuantity: p.stockQuantity,
    lowStockThreshold: p.lowStockThreshold,
    sku: p.sku,
    status: p.status,
    variantName: p.variantName,
    color: p.color,
    size: p.size,
    material: p.material,
    pattern: p.pattern,
    style: p.style,
    specifications: p.specifications,
    dimensions: p.dimensions,
    weight: p.weight,
    shippingClass: p.shippingClass,
    seo: {
      title: p.seoTitle?.trim() || p.name,
      metaDescription: p.metaDescription ?? p.parent.shortDescription ?? null,
      keywords: p.searchKeywords,
      urlSlug: p.urlSlug,
    },
    category: department ? toCategoryResponse(department) : null,
    parent: toParentResponse({ ...p.parent, subcategory }),
    variants,
    images: p.images.map(toImageResponse),
    merchantId: p.merchantId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
