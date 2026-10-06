import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import {
  addBusinessDays,
  deliveryLabel,
  discountPercent,
  estimatedDelivery,
  estimatedDeliveryFor,
  lineAmounts,
  orderTotals,
  pricingRules,
  savings,
  shippingFee,
  shippingOptions,
} from '../src/order/pricing';

/** Money, tax and shipping rules (CONTRACT §3, FR-IN-06). Pure functions: no database. */
const config = (env: Record<string, string> = {}) => loadConfig({ JWT_SECRET: 'x'.repeat(32), ...env });
const rules = pricingRules(config());
const str = (d: Prisma.Decimal) => d.toFixed(2);

describe('config', () => {
  it('parses shipping ranges, fees and the free threshold', () => {
    const c = config({ SHIPPING_STANDARD_DAYS: '4 - 6', SHIPPING_EXPRESS_FEE: '12.5', SHIPPING_EXPRESS_DAYS: '2' });
    expect(c.shipping.standard).toEqual({ fee: '5.99', minDays: 4, maxDays: 6 });
    expect(c.shipping.express).toEqual({ fee: '12.50', minDays: 2, maxDays: 2 });
    expect(c.shipping.freeThreshold).toBe('35.00');
    expect(c.pricing).toEqual({ pricesIncludeTax: false, defaultTaxRate: '0.00' });
    expect(c.store.name).toBe('Ecommerce Collections');
  });

  it('an empty or "none" free threshold means never free', () => {
    expect(config({ SHIPPING_FREE_THRESHOLD: '' }).shipping.freeThreshold).toBeNull();
    expect(config({ SHIPPING_FREE_THRESHOLD: 'none' }).shipping.freeThreshold).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(() => config({ SHIPPING_STANDARD_DAYS: '5-3' })).toThrow(/day range/);
    expect(() => config({ SHIPPING_STANDARD_FEE: '-1' })).toThrow(/amount/);
    expect(() => config({ DEFAULT_TAX_RATE: '120' })).toThrow(/percentage/);
  });
});

describe('line tax', () => {
  it('adds the SKU rate on top, rounded per line', () => {
    const line = lineAmounts('19.99', 3, '8.25', rules);
    expect(str(line.subtotal)).toBe('59.97');
    expect(str(line.taxRate)).toBe('8.25');
    expect(str(line.taxAmount)).toBe('4.95'); // 4.947525 → 4.95
  });

  it('falls back to DEFAULT_TAX_RATE when the SKU has none', () => {
    const r = pricingRules(config({ DEFAULT_TAX_RATE: '5' }));
    expect(str(lineAmounts('10.00', 1, null, r).taxAmount)).toBe('0.50');
    expect(str(lineAmounts('10.00', 1, '0', r).taxAmount)).toBe('0.00');
  });

  it('with prices including tax, reports the included portion', () => {
    const r = pricingRules(config({ PRICES_INCLUDE_TAX: 'true' }));
    expect(str(lineAmounts('108.00', 1, '8', r).taxAmount)).toBe('8.00');
  });
});

describe('shipping', () => {
  it('standard is free at/above the threshold, express never', () => {
    const below = shippingOptions('34.99', rules.shipping);
    expect(below.map((o) => [o.method, str(o.fee), o.free])).toEqual([
      ['STANDARD', '5.99', false],
      ['EXPRESS', '9.99', false],
    ]);
    const at = shippingOptions('35.00', rules.shipping);
    expect(at.map((o) => [o.method, str(o.fee), o.free])).toEqual([
      ['STANDARD', '0.00', true],
      ['EXPRESS', '9.99', false],
    ]);
    expect(at[0]).toMatchObject({ label: 'Standard shipping', estimatedDelivery: '3–5 business days', minDays: 3, maxDays: 5 });
    expect(str(shippingFee('EXPRESS', '500', rules.shipping))).toBe('9.99');
  });

  it('labels single-day ranges', () => {
    expect(deliveryLabel({ minDays: 1, maxDays: 1 })).toBe('1 business day');
    expect(deliveryLabel({ minDays: 2, maxDays: 2 })).toBe('2 business days');
  });
});

describe('totals', () => {
  it('grand = subtotal + tax + shipping − discount; shipping untaxed', () => {
    const lines = [lineAmounts('12.00', 2, '8', rules), lineAmounts('5.50', 1, '0', rules)];
    const t = orderTotals(lines, 'STANDARD', rules);
    expect([t.subtotal, t.taxTotal, t.shippingTotal, t.discountTotal, t.grandTotal].map(str)).toEqual([
      '29.50', '1.92', '5.99', '0.00', '37.41',
    ]);
    const express = orderTotals(lines, 'EXPRESS', rules);
    expect(str(express.grandTotal)).toBe('41.41');
  });

  it('free standard shipping applies to the pre-tax subtotal', () => {
    const t = orderTotals([lineAmounts('35.00', 1, '10', rules)], 'STANDARD', rules);
    expect([t.shippingTotal, t.grandTotal].map(str)).toEqual(['0.00', '38.50']);
  });

  it('included tax is not added again', () => {
    const r = pricingRules(config({ PRICES_INCLUDE_TAX: 'true' }));
    const t = orderTotals([lineAmounts('54.00', 1, '8', r)], 'STANDARD', r);
    expect([t.taxTotal, t.grandTotal].map(str)).toEqual(['4.00', '54.00']);
  });

  it('an empty order has no shipping', () => {
    expect(str(orderTotals([], 'STANDARD', rules).grandTotal)).toBe('0.00');
  });
});

describe('MRP', () => {
  it('discount percent and savings', () => {
    expect(discountPercent('149.99', '199.99')).toBe(25);
    expect(discountPercent('10', null)).toBeNull();
    expect(discountPercent('10', '10')).toBeNull();
    expect(discountPercent('10', '8')).toBeNull();
    expect(str(savings([
      { unitPrice: '24.99', mrp: '29.99', quantity: 2 },
      { unitPrice: '10', mrp: null, quantity: 5 },
      { unitPrice: '10', mrp: '9', quantity: 1 },
    ]))).toBe('10.00');
  });
});

describe('delivery dates', () => {
  it('counts Mon–Fri only', () => {
    const friday = new Date('2026-10-09T15:00:00Z');
    expect(addBusinessDays(friday, 1).toISOString().slice(0, 10)).toBe('2026-10-12'); // Monday
    expect(addBusinessDays(friday, 0).toISOString().slice(0, 10)).toBe('2026-10-09');
    const saturday = new Date('2026-10-10T09:00:00Z');
    expect(estimatedDelivery(saturday, { minDays: 3, maxDays: 5 })).toEqual({ from: '2026-10-14', to: '2026-10-16' });
  });

  it('uses paidAt, else createdAt; null without a shipping method', () => {
    const shipping = rules.shipping;
    const createdAt = new Date('2026-10-05T10:00:00Z'); // Monday
    const paidAt = new Date('2026-10-06T10:00:00Z');
    expect(estimatedDeliveryFor({ shippingMethod: 'EXPRESS', paidAt, createdAt }, shipping)).toEqual({
      from: '2026-10-07',
      to: '2026-10-08',
    });
    expect(estimatedDeliveryFor({ shippingMethod: 'STANDARD', paidAt: null, createdAt }, shipping)).toEqual({
      from: '2026-10-08',
      to: '2026-10-12',
    });
    expect(estimatedDeliveryFor({ shippingMethod: null, paidAt, createdAt }, shipping)).toBeNull();
  });
});
