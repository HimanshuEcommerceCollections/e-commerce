import { Prisma } from '@prisma/client';
import type { Config, ShippingRate } from '../config';
import type { ShippingMethod } from '../common/enums';
import { stateTaxRate } from './state-tax';

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
  /** Percent; applies when a SKU has no tax rate of its own (and, by destination, no known state). */
  defaultTaxRate: Numeric;
  shipping: Config['shipping'];
  /** TAX_MODE. Absent means flat. */
  taxMode?: 'destination' | 'flat';
}

export function pricingRules(config: Config): PricingRules {
  return {
    pricesIncludeTax: config.pricing.pricesIncludeTax,
    defaultTaxRate: config.pricing.defaultTaxRate,
    shipping: config.shipping,
    taxMode: config.pricing.taxMode,
  };
}

/** Where the order ships, as far as tax is concerned. */
export interface TaxDestination {
  state?: string | null;
  postalCode?: string | null;
}

/**
 * The SKU's own rate (percent); else, in destination mode, the ship-to state's
 * base rate; else the store default.
 */
export function effectiveTaxRate(
  skuRate: Numeric | null | undefined,
  rules: Pick<PricingRules, 'defaultTaxRate' | 'taxMode'>,
  destination?: TaxDestination | null,
): Decimal {
  if (skuRate !== null && skuRate !== undefined) return D(skuRate);
  if (rules.taxMode === 'destination') {
    const byState = stateTaxRate(destination?.state);
    if (byState !== null) return D(byState);
  }
  return D(rules.defaultTaxRate);
}

/** Destination mode without a known ship-to state: the tax shown is a guess ("Calculated at checkout"). */
export function taxIsEstimate(rules: Pick<PricingRules, 'taxMode'>, destination?: TaxDestination | null): boolean {
  return rules.taxMode === 'destination' && stateTaxRate(destination?.state) === null;
}

export interface LineAmounts {
  /** unit price × quantity. */
  subtotal: Decimal;
  /** This line's share of the order discount (0 without a promotion). */
  discount: Decimal;
  taxRate: Decimal;
  /**
   * Tax on the line after its discount, rounded per line. With
   * PRICES_INCLUDE_TAX it is the portion already inside the price (reported,
   * never added).
   */
  taxAmount: Decimal;
}

export function lineAmounts(
  unitPrice: Numeric,
  quantity: number,
  skuTaxRate: Numeric | null | undefined,
  rules: Pick<PricingRules, 'pricesIncludeTax' | 'defaultTaxRate' | 'taxMode'>,
  options: { discount?: Numeric; destination?: TaxDestination | null } = {},
): LineAmounts {
  const subtotal = D(unitPrice).mul(quantity);
  const discount = D(options.discount ?? 0);
  const taxable = subtotal.sub(discount);
  const taxRate = effectiveTaxRate(skuTaxRate, rules, options.destination);
  const taxAmount = rules.pricesIncludeTax
    ? round2(taxable.mul(taxRate).div(HUNDRED.add(taxRate)))
    : round2(taxable.mul(taxRate).div(HUNDRED));
  return { subtotal, discount, taxRate, taxAmount };
}

// ── Promotions ─────────────────────────────────────────────────────────────

/** What a promotion takes off (src/promo): PERCENT of the subtotal, a FIXED amount, or FREE_SHIPPING. */
export interface PromoTerms {
  type: string;
  value: Numeric;
}

/** PERCENT = round2(subtotal × value / 100); FIXED = min(value, subtotal); FREE_SHIPPING = 0. */
export function promoDiscount(terms: PromoTerms | null | undefined, subtotal: Numeric): Decimal {
  if (!terms) return ZERO;
  const sub = D(subtotal);
  if (terms.type === 'PERCENT') return Prisma.Decimal.min(sub, round2(sub.mul(D(terms.value)).div(HUNDRED)));
  if (terms.type === 'FIXED') return round2(Prisma.Decimal.min(D(terms.value), sub));
  return ZERO;
}

/**
 * Splits an order discount across lines in proportion to their subtotals, in
 * whole cents that add up exactly (largest remainder first), so tax can be
 * charged on what each line really costs.
 */
export function allocateDiscount(subtotals: Numeric[], discount: Numeric): Decimal[] {
  const subs = subtotals.map(D);
  const total = subs.reduce((a, s) => a.add(s), ZERO);
  const cents = D(discount).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  if (total.lte(0) || cents.lte(0)) return subs.map(() => ZERO);
  const exact = subs.map((s) => cents.mul(s).div(total));
  const floors = exact.map((e) => e.floor());
  let left = cents.sub(floors.reduce((a, f) => a.add(f), ZERO)).toNumber();
  const order = exact.map((e, i) => ({ i, r: e.sub(floors[i]) })).sort((a, b) => b.r.cmp(a.r) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = floors[i].add(1);
    left--;
  }
  return floors.map((f) => f.div(100));
}

export interface PricedLines {
  lines: LineAmounts[];
  totals: OrderTotals;
  /** The promotion made Standard shipping free. */
  freeShipping: boolean;
}

/**
 * Prices purchasable lines end to end: the promotion's discount, spread over
 * the lines, then tax by destination on the discounted amounts, then shipping.
 * Cart, quote and checkout all call this.
 */
export function priceLines(
  lines: { unitPrice: Numeric; quantity: number; taxRate: Numeric | null | undefined }[],
  method: ShippingMethod,
  rules: PricingRules,
  options: { promo?: PromoTerms | null; destination?: TaxDestination | null } = {},
): PricedLines {
  const subtotals = lines.map((l) => D(l.unitPrice).mul(l.quantity));
  const subtotal = subtotals.reduce((a, s) => a.add(s), ZERO);
  const shares = allocateDiscount(subtotals, promoDiscount(options.promo, subtotal));
  const amounts = lines.map((l, i) =>
    lineAmounts(l.unitPrice, l.quantity, l.taxRate, rules, { discount: shares[i], destination: options.destination }),
  );
  const freeShipping = options.promo?.type === 'FREE_SHIPPING';
  return { lines: amounts, totals: orderTotals(amounts, method, rules, { freeShipping }), freeShipping };
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

/**
 * Standard is free at/above the threshold, or with a FREE_SHIPPING promotion
 * (`promoFree`); Express never is.
 */
export function isFreeShipping(method: ShippingMethod, subtotal: Numeric, shipping: Config['shipping'], promoFree = false): boolean {
  if (method !== 'STANDARD') return false;
  return promoFree || (shipping.freeThreshold !== null && D(subtotal).gte(shipping.freeThreshold));
}

/** Both methods priced for this subtotal (checkout quote). */
export function shippingOptions(subtotal: Numeric, shipping: Config['shipping'], promoFree = false): ShippingOption[] {
  return (['STANDARD', 'EXPRESS'] as const).map((method) => {
    const rate = rateFor(method, shipping);
    const free = isFreeShipping(method, subtotal, shipping, promoFree);
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
export function shippingFee(method: ShippingMethod, subtotal: Numeric, shipping: Config['shipping'], promoFree = false): Decimal {
  return isFreeShipping(method, subtotal, shipping, promoFree) ? ZERO : round2(rateFor(method, shipping).fee);
}

export interface OrderTotals {
  subtotal: Decimal;
  taxTotal: Decimal;
  shippingTotal: Decimal;
  discountTotal: Decimal;
  grandTotal: Decimal;
}

/**
 * grand = subtotal − discount + tax + shipping. Included tax (PRICES_INCLUDE_TAX)
 * is reported in taxTotal but not added. The discount is the lines' shares of
 * the promotion (see priceLines); the free-shipping threshold looks at the
 * subtotal before it.
 */
export function orderTotals(
  lines: (Pick<LineAmounts, 'subtotal' | 'taxAmount'> & { discount?: Decimal })[],
  method: ShippingMethod,
  rules: Pick<PricingRules, 'pricesIncludeTax' | 'shipping'>,
  options: { freeShipping?: boolean } = {},
): OrderTotals {
  const subtotal = round2(lines.reduce((acc, l) => acc.add(l.subtotal), ZERO));
  const taxTotal = round2(lines.reduce((acc, l) => acc.add(l.taxAmount), ZERO));
  const shippingTotal = lines.length ? shippingFee(method, subtotal, rules.shipping, options.freeShipping) : ZERO;
  const discountTotal = round2(lines.reduce((acc, l) => acc.add(l.discount ?? ZERO), ZERO));
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
