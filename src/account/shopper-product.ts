import type { Prisma } from '@prisma/client';
import { money } from '../common/api-response';
import { primaryImageUrl } from '../product/product.mapper';

// The product bits the account pages (saved items, buy again) show for a SKU:
// live price, stock and the link to its page.

export const SHOPPER_PRODUCT_INCLUDE = {
  images: { where: { deleted: false }, orderBy: { position: 'asc' } },
  parent: { select: { name: true, brand: true } },
} satisfies Prisma.ProductInclude;

export type ShopperProduct = Prisma.ProductGetPayload<{ include: typeof SHOPPER_PRODUCT_INCLUDE }>;

export function toShopperProduct(p: ShopperProduct) {
  return {
    productId: p.id,
    // The PDP route takes the url slug or the id.
    slug: p.urlSlug ?? p.id,
    parentId: p.parentId,
    name: p.name,
    brand: p.parent.brand,
    imageUrl: primaryImageUrl(p.images),
    price: money(p.price),
    // The "was" price, only when it is above today's price.
    mrp: p.mrp !== null && p.mrp.gt(p.price) ? money(p.mrp) : null,
    // Unpublished SKUs can't be bought: they read as out of stock.
    stock: p.status === 'ACTIVE' ? Math.max(0, p.stockQuantity) : 0,
    variantName: p.variantName,
    color: p.color,
    size: p.size,
  };
}
