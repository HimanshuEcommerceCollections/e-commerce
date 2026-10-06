import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Account orders, payment bookkeeping, guest tracking and return requests (FR-ST-12, FR-IN-04/05, FR-AD-07). */
const { app, prisma, container, fixtures } = harness();

const DAY = 86_400_000;

/** A signed-in customer's order of 2 × $25.00, placed over HTTP. */
async function placeOrder() {
  const token = await fixtures.registerUser();
  const user = await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  const product = await fixtures.newActiveProduct(10, '25.00');
  const address = await fixtures.newAddress(user.id);
  await request(app).post('/api/cart/items').set('Authorization', `Bearer ${token}`).send({ productId: product.id, quantity: 2 });
  const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`).send({ addressId: address.id });
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${res.text}`);
  return { token, user, product, order: res.body.data.order as { id: string; orderNumber: string; items: { id: string }[] } };
}

async function deliver(orderId: string, deliveredAt = new Date()) {
  await container.orders.markPaid(orderId);
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'DELIVERED', fulfilmentStatus: 'DELIVERED', shippedAt: deliveredAt, deliveredAt },
  });
}

describe('payment bookkeeping', () => {
  it('marking paid stamps paidAt, starts fulfilment, logs the timeline, emails and records PURCHASE once', async () => {
    const { order } = await placeOrder();
    const paid = JSON.parse(JSON.stringify(await container.orders.markPaid(order.id)));
    expect(paid).toMatchObject({ status: 'PAID', paymentStatus: 'SUCCEEDED', fulfilmentStatus: 'UNFULFILLED' });
    expect(paid.paidAt).not.toBeNull();
    expect(paid.timeline.map((e: { status: string }) => e.status)).toEqual(['PENDING_PAYMENT', 'PAID']);
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'PAYMENT_RECEIVED' } })).toBe(1);
    const purchases = await prisma.analyticsEvent.findMany({ where: { orderId: order.id, eventType: 'PURCHASE' } });
    expect(purchases).toHaveLength(1);
    expect(purchases[0].value?.toFixed(2)).toBe('50.00');

    await expect(container.orders.markPaid(order.id)).rejects.toThrow(/Only a PENDING_PAYMENT order/);
    expect(await prisma.analyticsEvent.count({ where: { orderId: order.id, eventType: 'PURCHASE' } })).toBe(1);
  });

  it('cancelling restocks with a CANCELLATION movement and a timeline entry', async () => {
    const { token, order, product } = await placeOrder();
    const res = await request(app).post(`/api/orders/${order.orderNumber}/cancel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.data.timeline.at(-1)).toMatchObject({ status: 'CANCELLED', actor: 'CUSTOMER' });
    expect(await fixtures.stockOf(product.id)).toBe(10);
    const movements = await prisma.stockMovement.findMany({ where: { productId: product.id }, orderBy: { createdAt: 'asc' } });
    expect(movements.map((m) => [m.source, m.delta, m.quantityAfter])).toEqual([
      ['ORDER', -2, 8],
      ['CANCELLATION', 2, 10],
    ]);
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'ORDER_CANCELLED' } })).toBe(1);
  });
});

describe('account orders', () => {
  it('lists summaries with open/done filters and reads by id or number', async () => {
    const { token, order } = await placeOrder();
    const auth = { Authorization: `Bearer ${token}` };

    const open = await request(app).get('/api/orders?status=open').set(auth);
    expect(open.body.data.content).toHaveLength(1);
    expect(open.body.data.content[0]).toMatchObject({
      id: order.id,
      itemCount: 2,
      shipToName: 'Test Customer',
      latestShipment: null,
      items: [expect.objectContaining({ quantity: 2, productName: 'Test Product' })],
    });
    expect((await request(app).get('/api/orders?status=done').set(auth)).body.data.content).toHaveLength(0);
    expect((await request(app).get('/api/orders?status=bogus').set(auth)).status).toBe(400);

    const byNumber = await request(app).get(`/api/orders/${order.orderNumber.replace('-', '')}`).set(auth);
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.data).toMatchObject({ id: order.id, shipments: [], returns: [], returnableUntil: null });

    // Someone else's order is a 404.
    const other = await fixtures.registerUser();
    expect((await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${other}`)).status).toBe(404);
  });
});

describe('guest tracking', () => {
  async function guestOrder() {
    const product = await fixtures.newActiveProduct(5, '10.00');
    const email = `track-${randomUUID()}@test.local`;
    const res = await request(app)
      .post('/api/checkout/guest')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({
        email,
        shippingAddress: { recipientName: 'Tracy', addressLine1: '9 Elm St', city: 'Denver', state: 'CO', postalCode: '80202-5555' },
        items: [{ productId: product.id, quantity: 1 }],
      });
    return { email, orderNumber: res.body.data.order.orderNumber as string };
  }

  it('finds the order by email (any case) or 5-digit ZIP, showing the city only', async () => {
    const { email, orderNumber } = await guestOrder();
    const byEmail = await request(app).post('/api/orders/track').send({ orderNumber: orderNumber.replace('-', '').toLowerCase(), emailOrZip: email.toUpperCase() });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data).toMatchObject({
      orderNumber,
      status: 'PENDING_PAYMENT',
      shipTo: { city: 'Denver', state: 'CO', postalCode5: '80202' },
      items: [expect.objectContaining({ productName: 'Test Product', quantity: 1 })],
      shipments: [],
    });
    expect(byEmail.body.data.items[0]).not.toHaveProperty('productId');
    expect(byEmail.body.data).not.toHaveProperty('shippingAddress');

    const byZip = await request(app).post('/api/orders/track').send({ orderNumber, emailOrZip: '80202' });
    expect(byZip.status).toBe(200);
  });

  it('a mismatch is the same 404 as an unknown order', async () => {
    const { orderNumber } = await guestOrder();
    for (const body of [
      { orderNumber, emailOrZip: '99999' },
      { orderNumber, emailOrZip: 'someone@else.test' },
      { orderNumber: 'EC-0000000', emailOrZip: '80202' },
    ]) {
      const res = await request(app).post('/api/orders/track').send(body);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("We couldn't find an order with those details");
    }
    expect((await request(app).post('/api/orders/track').send({})).status).toBe(400);
  });
});

describe('return requests', () => {
  it('only delivered orders inside the window; quantities never exceed what is left', async () => {
    const { token, order } = await placeOrder();
    const auth = { Authorization: `Bearer ${token}` };
    const url = `/api/orders/${order.id}/returns`;
    const itemId = order.items[0].id;

    const notDelivered = await request(app).post(url).set(auth).send({ items: [{ orderItemId: itemId, quantity: 1 }], reason: 'Too small' });
    expect(notDelivered.status).toBe(409);

    await deliver(order.id);
    const first = await request(app).post(url).set(auth).send({ items: [{ orderItemId: itemId, quantity: 1 }], reason: 'Too small', method: 'DROPOFF' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      status: 'REQUESTED',
      requestedBy: 'CUSTOMER',
      method: 'DROPOFF',
      refundAmount: null,
      estimatedRefund: 25,
      items: [{ orderItemId: itemId, quantity: 1 }],
    });
    expect(first.body.data.rmaNumber).toMatch(/^RMA-\d{7}$/);
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'RETURN_REQUESTED' } })).toBe(1);

    // 2 bought, 1 already requested: 2 more is too many, 1 is fine.
    const tooMany = await request(app).post(url).set(auth).send({ items: [{ orderItemId: itemId, quantity: 2 }], reason: 'Changed my mind' });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toMatch(/Only 1/);
    expect((await request(app).post(url).set(auth).send({ items: [{ orderItemId: randomUUID(), quantity: 1 }], reason: 'x' })).status).toBe(400);
    expect((await request(app).post(url).set(auth).send({ items: [{ orderItemId: itemId, quantity: 1 }], reason: 'Changed my mind' })).status).toBe(201);

    const detail = await request(app).get(`/api/orders/${order.id}`).set(auth);
    expect(detail.body.data.returns).toHaveLength(2);
    expect(detail.body.data.returnableUntil).not.toBeNull();
  });

  it('a rejected request frees its units; the window closes after RETURN_WINDOW_DAYS', async () => {
    const { token, order } = await placeOrder();
    const auth = { Authorization: `Bearer ${token}` };
    const url = `/api/orders/${order.id}/returns`;
    const itemId = order.items[0].id;
    await deliver(order.id);

    const all = await request(app).post(url).set(auth).send({ items: [{ orderItemId: itemId, quantity: 2 }], reason: 'Defective' });
    expect(all.status).toBe(201);
    await prisma.orderReturn.update({ where: { id: all.body.data.id }, data: { status: 'REJECTED' } });
    expect((await request(app).post(url).set(auth).send({ items: [{ orderItemId: itemId, quantity: 2 }], reason: 'Defective' })).status).toBe(201);

    const late = await placeOrder();
    await deliver(late.order.id, new Date(Date.now() - 31 * DAY));
    const closed = await request(app)
      .post(`/api/orders/${late.order.id}/returns`)
      .set('Authorization', `Bearer ${late.token}`)
      .send({ items: [{ orderItemId: late.order.items[0].id, quantity: 1 }], reason: 'Too late' });
    expect(closed.status).toBe(409);
    expect(closed.body.message).toMatch(/return window/);
  });
});
