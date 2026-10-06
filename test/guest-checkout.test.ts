import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Guest checkout (design 05): one transaction path with signed-in checkout (FR-ST-10/11, NFR-08). */
const { app, prisma, fixtures } = harness();

const address = {
  recipientName: 'Guest Buyer',
  phone: '+1 503 555 0100',
  addressLine1: '12 Market St',
  city: 'Portland',
  state: 'OR',
  postalCode: '97214-1234',
};

async function taxedProduct(stock: number, price: string, taxRate: string) {
  const p = await fixtures.newActiveProduct(stock, price);
  return prisma.product.update({
    where: { id: p.id },
    data: { taxRate: new Prisma.Decimal(taxRate), taxCode: 'STD', mrp: new Prisma.Decimal('30.00'), color: 'Black', size: 'M' },
  });
}

const guestCheckout = (body: object, key: string | null = `key-${randomUUID()}`) => {
  const req = request(app).post('/api/checkout/guest');
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

describe('guest checkout', () => {
  it('places an order with tax, shipping, snapshots, stock movement, timeline and email', async () => {
    const product = await taxedProduct(10, '20.00', '8.25');
    const email = `Guest-${randomUUID()}@Test.local`;
    const res = await guestCheckout({
      email,
      marketingOptIn: true,
      shippingAddress: address,
      shippingMethod: 'EXPRESS',
      items: [{ productId: product.id, quantity: 2 }],
    });

    expect(res.status).toBe(201);
    const { order, guestToken, clientSecret } = res.body.data;
    expect(clientSecret).toBeNull(); // manual gateway
    expect(guestToken).toEqual(expect.any(String));
    expect(order).toMatchObject({
      status: 'PENDING_PAYMENT',
      guest: true,
      customerEmail: email.toLowerCase(),
      shippingMethod: 'EXPRESS',
      subtotal: 40,
      taxTotal: 3.3,
      shippingTotal: 9.99, // express is never free
      grandTotal: 53.29,
      refundedTotal: 0,
      shippingAddress: { country: 'US', postalCode: '97214-1234' },
    });
    expect(order.orderNumber).toMatch(/^EC-\d{7}$/);
    expect(order.items[0]).toMatchObject({
      productId: product.id,
      parentId: product.parentId,
      color: 'Black',
      size: 'M',
      taxCode: 'STD',
      taxRate: 8.25,
      taxAmount: 3.3,
      quantity: 2,
    });
    expect(order.timeline).toEqual([expect.objectContaining({ status: 'PENDING_PAYMENT', note: 'Order placed', actor: 'GUEST' })]);
    expect(order.estimatedDelivery).toEqual({ from: expect.any(String), to: expect.any(String) });

    expect(await fixtures.stockOf(product.id)).toBe(8);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { productId: product.id } });
    expect(movement).toMatchObject({ delta: -2, quantityAfter: 8, source: 'ORDER' });
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.userId).toBeNull();
    expect(stored.marketingOptIn).toBe(true);
    expect(stored.guestTokenHash).toHaveLength(64);
    expect(stored.guestTokenHash).not.toBe(guestToken);
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'ORDER_CONFIRMATION' } })).toBe(1);
  });

  it('a retry with the same key replays the order and token; stock is taken once', async () => {
    const product = await fixtures.newActiveProduct(5, '10.00');
    const key = `key-${randomUUID()}`;
    const body = { email: `g-${randomUUID()}@test.local`, shippingAddress: address, items: [{ productId: product.id, quantity: 1 }] };

    const first = await guestCheckout(body, key);
    const replay = await guestCheckout(body, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.order.orderNumber).toBe(first.body.data.order.orderNumber);
    expect(replay.body.data.guestToken).toBe(first.body.data.guestToken);
    expect(await fixtures.stockOf(product.id)).toBe(4);

    const changed = await guestCheckout({ ...body, items: [{ productId: product.id, quantity: 2 }] }, key);
    expect(changed.status).toBe(422);
  });

  it('concurrent same-key requests produce one order', async () => {
    const product = await fixtures.newActiveProduct(5, '10.00');
    const key = `key-${randomUUID()}`;
    const email = `g-${randomUUID()}@test.local`;
    const body = { email, shippingAddress: address, items: [{ productId: product.id, quantity: 1 }] };
    const [a, b] = await Promise.all([guestCheckout(body, key), guestCheckout(body, key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.order.orderNumber).toBe(b.body.data.order.orderNumber);
    expect(await prisma.order.count({ where: { customerEmail: email } })).toBe(1);
    expect(await fixtures.stockOf(product.id)).toBe(4);
  });

  it('two guests racing for the last unit: one order, no oversell', async () => {
    const product = await fixtures.newActiveProduct(1, '10.00');
    const results = await Promise.all(
      [1, 2].map(() =>
        guestCheckout({ email: `g-${randomUUID()}@test.local`, shippingAddress: address, items: [{ productId: product.id, quantity: 1 }] }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await fixtures.stockOf(product.id)).toBe(0);
    expect(await prisma.orderItem.count({ where: { productId: product.id } })).toBe(1);
  });

  it('requires an Idempotency-Key and a valid body', async () => {
    const product = await fixtures.newActiveProduct(5, '10.00');
    const noKey = await guestCheckout(
      { email: `g-${randomUUID()}@test.local`, shippingAddress: address, items: [{ productId: product.id, quantity: 1 }] },
      null,
    );
    expect(noKey.status).toBe(400);

    const invalid = await guestCheckout({ email: 'nope', items: [] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.data).toMatchObject({
      email: 'Must be a valid email address',
      shippingAddress: 'Shipping address is required',
      items: 'Your cart is empty',
    });
  });

  it('an inactive product fails the whole order and leaves stock untouched', async () => {
    const ok = await fixtures.newActiveProduct(5, '10.00');
    const inactive = await fixtures.newActiveProduct(5, '10.00');
    await prisma.product.update({ where: { id: inactive.id }, data: { status: 'INACTIVE' } });
    const res = await guestCheckout({
      email: `g-${randomUUID()}@test.local`,
      shippingAddress: address,
      items: [
        { productId: ok.id, quantity: 1 },
        { productId: inactive.id, quantity: 1 },
      ],
    });
    expect(res.status).toBe(409);
    expect(await fixtures.stockOf(ok.id)).toBe(5);
  });

  it('the guest token reads the order; a wrong token is a 404', async () => {
    const product = await fixtures.newActiveProduct(5, '10.00');
    const res = await guestCheckout({ email: `g-${randomUUID()}@test.local`, shippingAddress: address, items: [{ productId: product.id, quantity: 1 }] });
    const { order, guestToken } = res.body.data;
    const typed = order.orderNumber.replace('-', '').toLowerCase();

    const read = await request(app).get(`/api/checkout/orders/${typed}`).set('X-Order-Token', guestToken);
    expect(read.status).toBe(200);
    expect(read.body.data.id).toBe(order.id);

    expect((await request(app).get(`/api/checkout/orders/${order.orderNumber}`).set('X-Order-Token', 'wrong')).status).toBe(404);
    expect((await request(app).get(`/api/checkout/orders/${order.orderNumber}`)).status).toBe(404);
  });

  it('creates an account from the order, links it, and refuses a second time', async () => {
    const product = await fixtures.newActiveProduct(5, '10.00');
    const email = `g-${randomUUID()}@test.local`;
    const res = await guestCheckout({ email, marketingOptIn: true, shippingAddress: address, items: [{ productId: product.id, quantity: 1 }] });
    const { order, guestToken } = res.body.data;
    const url = `/api/checkout/orders/${order.orderNumber}/account`;

    expect((await request(app).post(url).set('X-Order-Token', guestToken).send({ password: 'short' })).status).toBe(400);

    const created = await request(app).post(url).set('X-Order-Token', guestToken).send({ password: 'newpass123' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ email, fullName: 'Guest Buyer', role: 'ROLE_CUSTOMER' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.marketingOptIn).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).userId).toBe(user.id);

    // The new account sees the order in its history.
    const mine = await request(app).get('/api/orders').set('Authorization', `Bearer ${created.body.data.accessToken}`);
    expect(mine.body.data.content.map((o: { id: string }) => o.id)).toEqual([order.id]);

    expect((await request(app).post(url).set('X-Order-Token', guestToken).send({ password: 'newpass123' })).status).toBe(409);
  });
});
