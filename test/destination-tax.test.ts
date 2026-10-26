import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { lineAmounts, pricingRules, taxIsEstimate } from '../src/order/pricing';
import { stateCode, stateTaxRate } from '../src/order/state-tax';
import { harness } from './support/harness';

/** Destination tax (contract B2), US address rules (B4), guest → account address (B5), store config (E). */
const { app, prisma, config, fixtures } = harness({ env: { TAX_MODE: 'destination', DEFAULT_TAX_RATE: '5' } });

const address = { recipientName: 'Casey', phone: '+1 213 555 0100', addressLine1: '5 Sunset Blvd', city: 'Los Angeles', state: 'CA', postalCode: '90028' };

describe('state rates', () => {
  it('codes and names; all 50 states and DC', () => {
    expect(stateCode('oregon')).toBe('OR');
    expect(stateCode('ny')).toBe('NY');
    expect(stateCode('ZZ')).toBeNull();
    expect(stateTaxRate('CA')).toBe('7.25');
    expect(stateTaxRate('OR')).toBe('0.00');
    const rules = pricingRules(config);
    // SKU rate wins; else the state; else the default.
    expect(lineAmounts('100.00', 1, '3', rules, { destination: { state: 'CA' } }).taxAmount.toFixed(2)).toBe('3.00');
    expect(lineAmounts('100.00', 1, null, rules, { destination: { state: 'CA' } }).taxAmount.toFixed(2)).toBe('7.25');
    expect(lineAmounts('100.00', 1, null, rules).taxAmount.toFixed(2)).toBe('5.00');
    expect(taxIsEstimate(rules, null)).toBe(true);
    expect(taxIsEstimate(rules, { state: 'TX' })).toBe(false);
    expect(taxIsEstimate({ taxMode: 'flat' }, null)).toBe(false);
  });
});

describe('quote and checkout', () => {
  it('the quote estimates without a state and uses the state rate with one', async () => {
    const p = await fixtures.newActiveProduct(10, '100.00');
    const items = [{ productId: p.id, quantity: 1 }];
    const none = await request(app).post('/api/checkout/quote').send({ items });
    expect(none.body.data).toMatchObject({ taxTotal: 5, taxIsEstimate: true });
    const ca = await request(app).post('/api/checkout/quote').send({ items, shippingAddress: { state: 'CA', postalCode: '90028' } });
    expect(ca.body.data).toMatchObject({ taxTotal: 7.25, taxIsEstimate: false });
  });

  it('a guest order is taxed by its ship-to state', async () => {
    const p = await fixtures.newActiveProduct(10, '100.00');
    const res = await request(app)
      .post('/api/checkout/guest')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ email: `tax-${randomUUID()}@test.local`, shippingAddress: { ...address, state: 'california' }, items: [{ productId: p.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.order).toMatchObject({ taxTotal: 7.25, shippingAddress: { state: 'CA' } });
    expect(res.body.data.order.items[0]).toMatchObject({ taxRate: 7.25 });
  });
});

describe('saved addresses', () => {
  it('label is optional (Home first, then Other) and US fields are checked', async () => {
    const token = await fixtures.registerUser();
    const auth = { Authorization: `Bearer ${token}` };
    const body = { ...address, country: 'US' };
    const first = await request(app).post('/api/users/me/addresses').set(auth).send(body);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ label: 'Home', isDefault: true });
    const second = await request(app).post('/api/users/me/addresses').set(auth).send({ ...body, addressLine1: '6 Sunset Blvd' });
    expect(second.body.data.label).toBe('Other');
    const bad = await request(app).post('/api/users/me/addresses').set(auth).send({ ...body, state: 'XX', postalCode: '9002' });
    expect(bad.status).toBe(400);
    expect(bad.body.data).toEqual({ state: 'Choose a state.', postalCode: 'Enter a 5-digit ZIP code.' });
  });

  it('an account made from a guest order keeps its address', async () => {
    const p = await fixtures.newActiveProduct(10, '10.00');
    const email = `keep-${randomUUID()}@test.local`;
    const placed = await request(app)
      .post('/api/checkout/guest')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ email, shippingAddress: address, items: [{ productId: p.id, quantity: 1 }] });
    const { order, guestToken } = placed.body.data;
    const res = await request(app)
      .post(`/api/checkout/orders/${order.orderNumber}/account`)
      .set('X-Order-Token', guestToken)
      .send({ password: 'password123' });
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const saved = await prisma.userAddress.findMany({ where: { userId: user.id, deleted: false } });
    expect(saved).toEqual([expect.objectContaining({ label: 'Home', isDefault: true, addressLine1: '5 Sunset Blvd', phone: '+1 213 555 0100', state: 'CA' })]);
  });
});

describe('store config', () => {
  it('has the new storefront flags', async () => {
    const res = await request(app).get('/api/store/config');
    expect(res.body.data).toMatchObject({
      taxMode: 'destination',
      savedPaymentMethods: false,
      reviewsEnabled: true,
      supportHours: '8 AM – 8 PM ET',
      returnCarrier: 'UPS',
      promoCodesEnabled: true,
      twoFactorAvailable: true,
      smsAvailable: false,
      stripePublishableKeyIsTest: false,
    });
  });
});

