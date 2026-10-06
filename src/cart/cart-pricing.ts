import { Prisma } from '@prisma/client';
import { money } from '../common/api-response';
import type { ShippingMethod } from '../common/enums';
import type { Db } from '../db';
import {
  lineAmounts,
  orderTotals,
  savings,
  shippingOptions,
  type OrderTotals,
  type PricingRules,
} from '../order/pricing';
import { primaryImageUrl } from '../product/product.mapper';

/**
 * Prices cart lines — the signed-in cart, a guest's browser cart and the
 * checkout quote all go through here, with the rules in src/order/pricing.ts,
 * so every total the shopper sees is the one checkout charges.
 */

export const CART_PRODUCT_INCLUDE = {
  images: { where: { deleted: false }, orderBy: { position: 'asc' } },
} satisfies Prisma.ProductInclude;

export type CartProduct = Prisma.ProductGetPayload<{ include: typeof CART_PRODUCT_INCLUDE }>;

export interface CartLine {
  product: CartProduct;
  quantity: number;
}

/** Live (not deleted) products by id, with images. Unknown ids are simply absent. */
export async function loadCartProducts(db: Db, ids: string[]): Promise<Map<string, CartProduct>> {
  if (!ids.length) return new Map();
  const rows = await db.product.findMany({
    where: { id: { in: [...new Set(ids)] }, deleted: false },
    include: CART_PRODUCT_INCLUDE,
  });
  return new Map(rows.map((p) => [p.id, p]));
}

/** Buyable right now: published and with stock (FR-ST-13). */
export const isPurchasable = (p: Pick<CartProduct, 'status' | 'stockQuantity'>) => p.status === 'ACTIVE' && p.stockQuantity > 0;

export interface PricedCart {
  items: ReturnType<typeof toCartItem>[];
  totalItems: number;
  totals: OrderTotals;
  savings: Prisma.Decimal;
}

function toCartItem(line: CartLine, rules: PricingRules) {
  const { product, quantity } = line;
  const available = isPurchasable(product);
  const amounts = lineAmounts(product.price, quantity, product.taxRate, rules);
  const zero = new Prisma.Decimal(0);
  // Unavailable lines stay visible but count for nothing.
  const subtotal = available ? amounts.subtotal : zero;
  return {
    productId: product.id,
    productName: product.name,
    parentId: product.parentId,
    sku: product.sku,
    variantName: product.variantName,
    color: product.color,
    size: product.size,
    urlSlug: product.urlSlug,
    primaryImageUrl: primaryImageUrl(product.images),
    unitPrice: money(product.price),
    mrp: product.mrp === null ? null : money(product.mrp),
    taxRate: Number(amounts.taxRate),
    quantity,
    stockQuantity: Math.max(0, product.stockQuantity),
    lineTotal: money(subtotal),
    subtotal: money(subtotal),
    taxAmount: money(available ? amounts.taxAmount : zero),
    available,
  };
}

export function priceCart(lines: CartLine[], rules: PricingRules, method: ShippingMethod = 'STANDARD'): PricedCart {
  const live = lines.filter((l) => isPurchasable(l.product));
  const amounts = live.map((l) => lineAmounts(l.product.price, l.quantity, l.product.taxRate, rules));
  return {
    items: lines.map((l) => toCartItem(l, rules)),
    totalItems: live.reduce((n, l) => n + l.quantity, 0),
    totals: orderTotals(amounts, method, rules),
    savings: savings(live.map((l) => ({ unitPrice: l.product.price, mrp: l.product.mrp, quantity: l.quantity }))),
  };
}

/** `CartResponse`: the signed-in cart, or a guest preview (`cart` null). */
export function toCartResponse(
  cart: { id: string; userId: string; updatedAt: Date } | null,
  lines: CartLine[],
  rules: PricingRules,
) {
  const priced = priceCart(lines, rules);
  const { totals } = priced;
  return {
    cartId: cart?.id ?? null,
    customerId: cart?.userId ?? null,
    items: priced.items,
    totalItems: priced.totalItems,
    totalPrice: money(totals.subtotal),
    savings: money(priced.savings),
    taxTotal: money(totals.taxTotal),
    shippingEstimate: money(totals.shippingTotal),
    grandTotalEstimate: money(totals.grandTotal),
    pricesIncludeTax: rules.pricesIncludeTax,
    freeShippingThreshold:
      rules.shipping.freeThreshold === null ? null : money(new Prisma.Decimal(rules.shipping.freeThreshold)),
    updatedAt: cart?.updatedAt ?? null,
  };
}

/** `CheckoutQuote`: totals for one shipping method, plus both methods priced for this cart. */
export function toCheckoutQuote(lines: CartLine[], method: ShippingMethod, rules: PricingRules, currency: string) {
  const priced = priceCart(lines, rules, method);
  const { totals } = priced;
  return {
    currency,
    shippingMethod: method,
    shippingOptions: shippingOptions(totals.subtotal, rules.shipping).map((o) => ({ ...o, fee: money(o.fee) })),
    freeShippingThreshold:
      rules.shipping.freeThreshold === null ? null : money(new Prisma.Decimal(rules.shipping.freeThreshold)),
    subtotal: money(totals.subtotal),
    savings: money(priced.savings),
    taxTotal: money(totals.taxTotal),
    shippingTotal: money(totals.shippingTotal),
    discountTotal: money(totals.discountTotal),
    grandTotal: money(totals.grandTotal),
    pricesIncludeTax: rules.pricesIncludeTax,
    lines: priced.items,
  };
}

/** Same product twice in one request counts once, with the quantities added. */
export function mergeLineInputs(items: { productId: string; quantity: number }[]) {
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}
