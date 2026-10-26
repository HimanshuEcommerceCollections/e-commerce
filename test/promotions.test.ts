import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { allocateDiscount, priceLines, pricingRules, promoDiscount } from '../src/order/pricing';
import { harness } from './support/harness';

/** Promotion codes (contract B1): validation, cart/quote pricing, order placement and snapshots (B3). */
const { app, prisma, config, container, fixtures } = harness({ env: { TAX_MODE: 'flat', DEFAULT_TAX_RATE: '10' } });

const run = randomUUID().slice(0, 6).toUpperCase();
const code = (name: string) => `${name}${run}`;

beforeAll(async () => {
  await prisma.promotion.createMany({
    data: [
      { code: code('TEN'), description: '10% off your first order', type: 'PERCENT', value: new Prisma.Decimal(10), firstOrderOnly: true },
      { code: code('SHIP'), description: 'Free standard shipping', type: 'FREE_SHIPPING' },
      { code: code('FIVE'), description: '$5 off $30', type: 'FIXED', value: new Prisma.Decimal(5), minSubtotal: new Prisma.Decimal(30) },
      { code: code('OLD'), description: 'Expired', type: 'PERCENT', value: new Prisma.Decimal(50), endsAt: new Date(Date.now() - 1000) },
      { code: code('ONCE'), description: 'One use', type: 'FIXED', value: new Prisma.Decimal(1), usageLimit: 1 },
    ],
  });
});

async function product(price: string, extra: Prisma.ProductUpdateInput = {}) {
  const p = await fixtures.newActiveProduct(50, price);
  return prisma.product.update({ where: { id: p.id }, data: extra });
}

const address = { recipientName: 'Pat', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '73301' };
const guestOrder = (body: object) =>
  request(app).post('/api/checkout/guest').set('Idempotency-Key', `key-${randomUUID()}`).send({
    email: `promo-${randomUUID()}@test.local`,
    shippingAddress: address,
    ...body,
  });

describe('pricing rules', () => {
  it('percent, fixed, free shipping, and an exact pro-rata split', () => {
    expect(promoDiscount({ type: 'PERCENT', value: 10 }, '33.33').toFixed(2)).toBe('3.33');
    expect(promoDiscount({ type: 'FIXED', value: 50 }, '20.00').toFixed(2)).toBe('20.00');
    expect(promoDiscount({ type: 'FREE_SHIPPING', value: 0 }, '20.00').toFixed(2)).toBe('0.00');
    const shares = allocateDiscount(['10.00', '10.00', '10.00'], '1.00');
    expect(shares.map((s) => s.toFixed(2))).toEqual(['0.34', '0.33', '0.33']);

    const rules = pricingRules(config);
    const priced = priceLines([{ unitPrice: '20.00', quantity: 1, taxRate: null }], 'STANDARD', rules, {
      promo: { type: 'PERCENT', value: 10 },
    });
    // Tax on the discounted 18.00: 1.80; grand = 20 − 2 + 1.80 + 5.99.
    expect(priced.totals.discountTotal.toFixed(2)).toBe('2.00');
    expect(priced.totals.taxTotal.toFixed(2)).toBe('1.80');
    expect(priced.totals.grandTotal.toFixed(2)).toBe('25.79');
  });
});

describe('POST /api/cart/promo/validate', () => {
  it('applies a valid code to the given lines', async () => {
    const p = await product('20.00');
    const res = await request(app)
      .post('/api/cart/promo/validate')
      .send({ code: code('ten').toLowerCase(), items: [{ productId: p.id, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ code: code('TEN'), description: '10% off your first order', type: 'PERCENT', discount: 4, freeShipping: false });
  });

  it('explains why a code does not apply', async () => {
    const p = await product('20.00');
    const items = [{ productId: p.id, quantity: 1 }];
    const check = (c: string, email?: string) => request(app).post('/api/cart/promo/validate').send({ code: c, items, email });

    const unknown = await check('NOPE');
    expect(unknown.status).toBe(400);
    expect(unknown.body.data).toEqual({ code: '"NOPE" isn\'t a valid code.' });
    expect((await check(code('OLD'))).body.data.code).toBe(`"${code('OLD')}" isn't a valid code.`);
    expect((await check(code('FIVE'))).body.data.code).toBe(`Add $10.00 more to use ${code('FIVE')}.`);

    // A returning customer can't use a first-order code.
    const email = `returning-${randomUUID()}@test.local`;
    expect((await guestOrder({ email, items })).status).toBe(201);
    expect((await check(code('TEN'), email)).body.data.code).toBe(`${code('TEN')} is for your first order only.`);
  });
});

describe('cart and quote', () => {
  it('the preview shows the discount, and an invalid code is reported without failing', async () => {
    const p = await product('20.00');
    const res = await request(app)
      .post('/api/cart/preview')
      .send({ items: [{ productId: p.id, quantity: 2 }], promoCode: code('TEN') });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalPrice: 40,
      discountTotal: 4,
      taxTotal: 3.6,
      shippingEstimate: 0,
      grandTotalEstimate: 39.6,
      promo: { code: code('TEN'), discount: 4, freeShipping: false },
      promoError: null,
      taxIsEstimate: false,
    });

    const bad = await request(app).post('/api/cart/preview').send({ items: [{ productId: p.id, quantity: 1 }], promoCode: 'NOPE' });
    expect(bad.status).toBe(200);
    expect(bad.body.data).toMatchObject({ promo: null, discountTotal: 0, promoError: '"NOPE" isn\'t a valid code.' });
  });

  it('free shipping zeroes Standard only', async () => {
    const p = await product('10.00');
    const res = await request(app)
      .post('/api/checkout/quote')
      .send({ items: [{ productId: p.id, quantity: 1 }], promoCode: code('SHIP') });
    expect(res.body.data).toMatchObject({ shippingTotal: 0, discountTotal: 0, promo: { freeShipping: true } });
    const standard = res.body.data.shippingOptions.find((o: { method: string }) => o.method === 'STANDARD');
    const express = res.body.data.shippingOptions.find((o: { method: string }) => o.method === 'EXPRESS');
    expect(standard).toMatchObject({ fee: 0, free: true });
    expect(express).toMatchObject({ fee: 9.99, free: false });
  });

  it('the signed-in cart takes ?promoCode=', async () => {
    const token = await fixtures.registerUser();
    const p = await product('40.00');
    await request(app).post('/api/cart/items').set('Authorization', `Bearer ${token}`).send({ productId: p.id, quantity: 1 });
    const res = await request(app).get(`/api/cart?promoCode=${code('FIVE')}`).set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toMatchObject({ discountTotal: 5, promo: { code: code('FIVE') } });
  });
});

describe('orders', () => {
  it('stores the code, discount, savings, MRP and billing; the response shows them', async () => {
    const p = await product('20.00', { mrp: new Prisma.Decimal('25.00') });
    const res = await guestOrder({
      items: [{ productId: p.id, quantity: 2 }],
      promoCode: code('TEN'),
      billingSameAsShipping: false,
      billingAddress: { addressLine1: '9 Card St', postalCode: '10001' },
    });
    expect(res.status).toBe(201);
    const { order } = res.body.data;
    expect(order).toMatchObject({
      subtotal: 40,
      discountTotal: 4,
      taxTotal: 3.6,
      grandTotal: 39.6,
      promoCode: code('TEN'),
      savingsTotal: 10,
      billingSameAsShipping: false,
      payment: null,
      hasReturnableItems: false,
    });
    expect(order.items[0]).toMatchObject({ mrp: 25, parentId: p.parentId, productSlug: p.id });
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored).toMatchObject({ billAddressLine1: '9 Card St', billPostalCode: '10001' });
    expect(stored.promotionId).not.toBeNull();

    // Tracking accepts the billing ZIP.
    const tracked = await request(app).post('/api/orders/track').send({ orderNumber: order.orderNumber, emailOrZip: '10001' });
    expect(tracked.status).toBe(200);

    // Marked paid under the manual gateway: payment method MANUAL.
    const paid = JSON.parse(JSON.stringify(await container.orders.markPaid(order.id)));
    expect(paid.payment).toEqual({ type: 'MANUAL', brand: null, last4: null });
  });

  it('an invalid code at placement is a 400 on promoCode and takes no stock', async () => {
    const p = await product('5.00');
    const res = await guestOrder({ items: [{ productId: p.id, quantity: 1 }], promoCode: 'NOPE' });
    expect(res.status).toBe(400);
    expect(res.body.data).toEqual({ promoCode: '"NOPE" isn\'t a valid code.' });
    expect(await fixtures.stockOf(p.id)).toBe(50);
  });

  it('a usage limit holds', async () => {
    const p = await product('5.00');
    expect((await guestOrder({ items: [{ productId: p.id, quantity: 1 }], promoCode: code('ONCE') })).status).toBe(201);
    const second = await guestOrder({ items: [{ productId: p.id, quantity: 1 }], promoCode: code('ONCE') });
    expect(second.status).toBe(400);
    expect(second.body.data).toEqual({ promoCode: `${code('ONCE')} is no longer available.` });
  });

  it('billing and P.O. box rules', async () => {
    const p = await product('5.00');
    const noBilling = await guestOrder({ items: [{ productId: p.id, quantity: 1 }], billingSameAsShipping: false });
    expect(noBilling.status).toBe(400);
    expect(noBilling.body.data).toMatchObject({
      'billingAddress.addressLine1': 'Enter your billing street address.',
      'billingAddress.postalCode': 'Enter a 5-digit billing ZIP code.',
    });
    const poBox = await guestOrder({
      items: [{ productId: p.id, quantity: 1 }],
      shippingMethod: 'EXPRESS',
      shippingAddress: { ...address, addressLine1: 'P.O. Box 123' },
    });
    expect(poBox.status).toBe(400);
    expect(poBox.body.data).toEqual({ 'shippingAddress.addressLine1': "We can't ship Express to a P.O. box." });
    const badState = await guestOrder({ items: [{ productId: p.id, quantity: 1 }], shippingAddress: { ...address, state: 'ZZ', postalCode: '123' } });
    expect(badState.body.data).toMatchObject({ 'shippingAddress.state': 'Choose a state.', 'shippingAddress.postalCode': 'Enter a 5-digit ZIP code.' });
  });
});
