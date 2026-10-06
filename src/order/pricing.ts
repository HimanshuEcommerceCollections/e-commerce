import { Prisma } from '@prisma/client';
import type { Config, ShippingRate } from '../config';
import type { ShippingMethod } from '../common/enums';

/**
 * Money, tax and shipping rules (FR-IN-06, FR-ST-09/10) — the one place they
 * live. Cart, guest preview, checkout quote, order placement and the store
 * config all call these, so a cart total never disagrees with the charged
 * amount. Pure functions over Prisma.Decimal: no I/O, no floating point.
 */

type Decimal = Prisma.Decimal;
type Numeric = Decimal | string | number;

const D = (v: Numeric) => (v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v));
const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/** Half-up to cents, as money columns store it. */
export function round2(v: Numeric): Decimal {
  return D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export interface PricingRules {
  pricesIncludeTax: boolean;
  /** Percent; applies when a SKU has no tax rate of its own. */
  defaultTaxRate: Numeric;
  shipping: Config['shipping'];
}

export function pricingRules(config: Config): PricingRules {
  return {
    pricesIncludeTax: config.pricing.pricesIncludeTax,
    defaultTaxRate: config.pricing.defaultTaxRate,
    shipping: config.shipping,
  };
}

/** The SKU's own rate (percent), else the store default. */
export function effectiveTaxRate(skuRate: Numeric | null | undefined, rules: Pick<PricingRules, 'defaultTaxRate'>): Decimal {
  return skuRate === null || skuRate === undefined ? D(rules.defaultTaxRate) : D(skuRate);
}

export interface LineAmounts {
  /** unit price × quantity. */
  subtotal: Decimal;
  taxRate: Decimal;
  /**
   * Tax on the line, rounded per line. With PRICES_INCLUDE_TAX it is the
   * portion already inside the price (reported, never added).
   */
  taxAmount: Decimal;
}

export function lineAmounts(
  unitPrice: Numeric,
  quantity: number,
  skuTaxRate: Numeric | null | undefined,
  rules: Pick<PricingRules, 'pricesIncludeTax' | 'defaultTaxRate'>,
): LineAmounts {
  const subtotal = D(unitPrice).mul(quantity);
  const taxRate = effectiveTaxRate(skuTaxRate, rules);
  const taxAmount = rules.pricesIncludeTax
    ? round2(subtotal.mul(taxRate).div(HUNDRED.add(taxRate)))
    : round2(subtotal.mul(taxRate).div(HUNDRED));
  return { subtotal, taxRate, taxAmount };
}

export interface ShippingOption {
  method: ShippingMethod;
  label: string;
  /** e.g. "3–5 business days". */
  estimatedDelivery: string;
  minDays: number;
  maxDays: number;
  /** What the customer pays: 0 when `free`. */
  fee: Decimal;
  free: boolean;
}

const LABELS: Record<ShippingMethod, string> = { STANDARD: 'Standard shipping', EXPRESS: 'Express shipping' };

export function deliveryLabel(rate: Pick<ShippingRate, 'minDays' | 'maxDays'>): string {
  const range = rate.minDays === rate.maxDays ? `${rate.minDays}` : `${rate.minDays}–${rate.maxDays}`;
  return `${range} business ${rate.maxDays === 1 ? 'day' : 'days'}`;
}

function rateFor(method: ShippingMethod, shipping: Config['shipping']): ShippingRate {
  return method === 'EXPRESS' ? shipping.express : shipping.standard;
}

/** Standard is free at/above the threshold; Express never is. */
export function isFreeShipping(method: ShippingMethod, subtotal: Numeric, shipping: Config['shipping']): boolean {
  return method === 'STANDARD' && shipping.freeThreshold !== null && D(subtotal).gte(shipping.freeThreshold);
}

/** Both methods priced for this subtotal (checkout quote). */
export function shippingOptions(subtotal: Numeric, shipping: Config['shipping']): ShippingOption[] {
  return (['STANDARD', 'EXPRESS'] as const).map((method) => {
    const rate = rateFor(method, shipping);
    const free = isFreeShipping(method, subtotal, shipping);
    return {
      method,
      label: LABELS[method],
      estimatedDelivery: deliveryLabel(rate),
      minDays: rate.minDays,
      maxDays: rate.maxDays,
      fee: free ? ZERO : round2(rate.fee),
      free,
    };
  });
}

/** List prices of both methods, before any free-shipping rule (store config). */
export function baseShippingOptions(shipping: Config['shipping']): Omit<ShippingOption, 'free'>[] {
  return (['STANDARD', 'EXPRESS'] as const).map((method) => {
    const rate = rateFor(method, shipping);
    return {
      method,
      label: LABELS[method],
      estimatedDelivery: deliveryLabel(rate),
      minDays: rate.minDays,
      maxDays: rate.maxDays,
      fee: round2(rate.fee),
    };
  });
}

/** Shipping charged for a method; shipping itself is never taxed. */
export function shippingFee(method: ShippingMethod, subtotal: Numeric, shipping: Config['shipping']): Decimal {
  return isFreeShipping(method, subtotal, shipping) ? ZERO : round2(rateFor(method, shipping).fee);
}

export interface OrderTotals {
  subtotal: Decimal;
  taxTotal: Decimal;
  shippingTotal: Decimal;
  discountTotal: Decimal;
  grandTotal: Decimal;
}

/**
 * grand = subtotal + tax + shipping − discount. Included tax (PRICES_INCLUDE_TAX)
 * is reported in taxTotal but not added. Discount is always 0: there are no
 * promotions in P0.
 */
export function orderTotals(
  lines: Pick<LineAmounts, 'subtotal' | 'taxAmount'>[],
  method: ShippingMethod,
  rules: Pick<PricingRules, 'pricesIncludeTax' | 'shipping'>,
): OrderTotals {
  const subtotal = round2(lines.reduce((acc, l) => acc.add(l.subtotal), ZERO));
  const taxTotal = round2(lines.reduce((acc, l) => acc.add(l.taxAmount), ZERO));
  const shippingTotal = lines.length ? shippingFee(method, subtotal, rules.shipping) : ZERO;
  const discountTotal = ZERO;
  const grandTotal = subtotal
    .add(rules.pricesIncludeTax ? ZERO : taxTotal)
    .add(shippingTotal)
    .sub(discountTotal);
  return { subtotal, taxTotal, shippingTotal, discountTotal, grandTotal: round2(grandTotal) };
}

/** Whole percent below MRP, or null when there is no (higher) MRP. */
export function discountPercent(price: Numeric, mrp: Numeric | null | undefined): number | null {
  if (mrp === null || mrp === undefined) return null;
  const m = D(mrp);
  const p = D(price);
  if (m.lte(0) || p.gte(m)) return null;
  return m.sub(p).div(m).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Σ (MRP − price) × qty over lines whose MRP is above the price. */
export function savings(lines: { unitPrice: Numeric; mrp: Numeric | null | undefined; quantity: number }[]): Decimal {
  return round2(
    lines.reduce((acc, l) => {
      if (l.mrp === null || l.mrp === undefined) return acc;
      const diff = D(l.mrp).sub(D(l.unitPrice));
      return diff.gt(0) ? acc.add(diff.mul(l.quantity)) : acc;
    }, ZERO),
  );
}

// ── Delivery dates ─────────────────────────────────────────────────────────

/** `days` business days (Mon–Fri) after `from`, in UTC. 0 returns `from`'s date. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Delivery window for an order: min/max business days after it was paid (or
 * placed, while unpaid). ISO dates, e.g. { from: "2026-10-09", to: "2026-10-13" }.
 */
export function estimatedDelivery(
  start: Date,
  rate: Pick<ShippingRate, 'minDays' | 'maxDays'>,
): { from: string; to: string } {
  return { from: isoDate(addBusinessDays(start, rate.minDays)), to: isoDate(addBusinessDays(start, rate.maxDays)) };
}

/** Same, by shipping method name; null for an order without one (pre-existing orders). */
export function estimatedDeliveryFor(
  order: { shippingMethod: string | null; paidAt: Date | null; createdAt: Date },
  shipping: Config['shipping'],
): { from: string; to: string } | null {
  if (order.shippingMethod !== 'STANDARD' && order.shippingMethod !== 'EXPRESS') return null;
  return estimatedDelivery(order.paidAt ?? order.createdAt, rateFor(order.shippingMethod, shipping));
}
