import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountShopping } from './support/account-shopping';
import { harness } from './support/harness';
import { RecordingPaymentGateway } from './support/recording-gateway';

/** Customer returns: logistics fields, the returns list, drop-off, refund to store credit (contract C3). */
const gateway = new RecordingPaymentGateway();
const h = harness({ gateway });
const { prisma, fixtures } = h;
const { shopper, newOrder, as } = accountShopping(h);

let admin: ReturnType<typeof as>;
beforeAll(async () => {
  admin = as(await fixtures.registerUser('ROLE_ADMIN'));
});
beforeEach(() => gateway.reset());

describe('return requests', () => {
  it('a drop-off return gets a code, a drop-off deadline and the line details', async () => {
    const me = await shopper();
    const order = await newOrder(me.userId, [{ price: '20.00', qty: 2 }]);
    const res = await me.post(`/api/orders/${order.id}/returns`, {
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
      reason: 'Too big',
      method: 'DROPOFF',
    });
    expect(res.status).toBe(201);
    const ret = res.body.data;
    expect(ret).toMatchObject({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: 'REQUESTED',
      method: 'DROPOFF',
      refundTo: 'ORIGINAL',
      carrier: 'UPS',
      step: 0,
      pickupDate: null,
      pickupWindow: null,
      droppedOffAt: null,
      estimatedRefund: 20,
      items: [{ orderItemId: order.items[0].id, productId: order.items[0].productId, productName: 'Test Product', color: 'Indigo', size: 'M', quantity: 1, amount: 20 }],
    });
    expect(ret.dropoffCode).toMatch(new RegExp(`^${ret.rmaNumber}-[A-Z2-9]{6}$`));
    const days = (new Date(ret.dropoffBy).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('a pickup gets the next business day (or a chosen weekday) and the 9–7 window', async () => {
    const me = await shopper();
    const order = await newOrder(me.userId, [{ price: '20.00', qty: 3 }]);
    const url = `/api/orders/${order.id}/returns`;
    const line = { orderItemId: order.items[0].id, quantity: 1 };

    const auto = await me.post(url, { items: [line], reason: 'Broken', method: 'PICKUP', refundTo: 'STORE_CREDIT' });
    expect(auto.status).toBe(201);
    expect(auto.body.data).toMatchObject({ method: 'PICKUP', refundTo: 'STORE_CREDIT', pickupWindow: '9 AM – 7 PM' });
    const day = new Date(`${auto.body.data.pickupDate}T00:00:00Z`);
    expect([0, 6]).not.toContain(day.getUTCDay());
    expect(day.getTime()).toBeGreaterThan(Date.now() - 86_400_000);

    // A weekday 3–9 days out.
    const chosen = new Date(Date.now() + 3 * 86_400_000);
    while ([0, 6].includes(chosen.getUTCDay())) chosen.setUTCDate(chosen.getUTCDate() + 1);
    const iso = chosen.toISOString().slice(0, 10);
    const picked = await me.post(url, { items: [line], reason: 'Broken', method: 'PICKUP', pickupDate: iso });
    expect(picked.body.data.pickupDate).toBe(iso);

    const past = await me.post(url, { items: [line], reason: 'Broken', method: 'PICKUP', pickupDate: '2020-01-06' });
    expect(past.status).toBe(400);
    expect(past.body.data).toEqual({ pickupDate: 'Choose a weekday in the next 2 weeks.' });
    expect((await me.post(url, { items: [line], reason: 'x', refundTo: 'CASH' })).status).toBe(400);
  });
});

describe('returns list and tracking steps', () => {
  it('lists the customer’s returns newest first and moves through the steps', async () => {
    const me = await shopper();
    const order = await newOrder(me.userId, [{ price: '15.00', qty: 1 }, { price: '5.00', qty: 1 }]);
    const first = await me.post(`/api/orders/${order.id}/returns`, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], reason: 'Too big' });
    const second = await me.post(`/api/orders/${order.id}/returns`, { items: [{ orderItemId: order.items[1].id, quantity: 1 }], reason: 'Too big' });

    const list = await me.get('/api/users/me/returns');
    expect(list.status).toBe(200);
    expect(list.body.data.totalElements).toBe(2);
    expect(list.body.data.content.map((r: { id: string }) => r.id)).toEqual([second.body.data.id, first.body.data.id]);
    expect(list.body.data.content[1]).toMatchObject({ orderNumber: order.orderNumber, estimatedRefund: 15, step: 0 });

    const id = first.body.data.id;
    const dropped = await admin.post(`/api/admin/returns/${id}/dropped-off`);
    expect(dropped.status).toBe(200);
    expect(dropped.body.data).toMatchObject({ step: 1, status: 'REQUESTED' });
    expect(dropped.body.data.droppedOffAt).not.toBeNull();
    expect((await admin.post(`/api/admin/returns/${id}/dropped-off`)).status).toBe(409);
    expect((await me.post(`/api/admin/returns/${id}/dropped-off`)).status).toBe(403);

    await admin.post(`/api/admin/returns/${id}/actions`, { action: 'RECEIVE' });
    const after = (await me.get('/api/users/me/returns')).body.data.content.find((r: { id: string }) => r.id === id);
    expect(after).toMatchObject({ status: 'RECEIVED', step: 2 });

    // Someone else sees none of them.
    expect((await (await shopper()).get('/api/users/me/returns')).body.data.totalElements).toBe(0);
  });
});

describe('refund to store credit', () => {
  it('credits the balance with a RETURN_REFUND entry instead of the gateway', async () => {
    const me = await shopper();
    await prisma.user.update({ where: { id: me.userId }, data: { storeCreditBalance: '5.00' } });
    const order = await newOrder(me.userId, [{ price: '30.00', qty: 1 }]);
    const ret = await me.post(`/api/orders/${order.id}/returns`, {
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
      reason: 'Changed my mind',
      refundTo: 'STORE_CREDIT',
    });
    const id = ret.body.data.id;
    await admin.post(`/api/admin/returns/${id}/actions`, { action: 'RECEIVE' });
    const refunded = await admin.post(`/api/admin/returns/${id}/actions`, { action: 'REFUND' });
    expect(refunded.status).toBe(200);
    expect(refunded.body.data).toMatchObject({ status: 'REFUNDED', refundTo: 'STORE_CREDIT', refundAmount: 30, step: 3 });
    expect(refunded.body.data.refundReference).toMatch(/^STORE-CREDIT-/);
    expect(gateway.refunds).toHaveLength(0);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: me.userId } });
    expect(user.storeCreditBalance.toFixed(2)).toBe('35.00');
    const entries = await prisma.storeCreditEntry.findMany({ where: { userId: me.userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'RETURN_REFUND', orderId: order.id, returnId: id });
    expect(entries[0].amount.toFixed(2)).toBe('30.00');
    expect(entries[0].balanceAfter.toFixed(2)).toBe('35.00');

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
    const mail = await prisma.notification.findFirstOrThrow({ where: { orderId: order.id, template: 'REFUND_ISSUED' } });
    expect(mail.body).toContain('store credit');
  });

  it('an ORIGINAL refund still goes through the gateway', async () => {
    const me = await shopper();
    const order = await newOrder(me.userId, [{ price: '30.00', qty: 1 }]);
    const ret = await me.post(`/api/orders/${order.id}/returns`, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], reason: 'x' });
    await admin.post(`/api/admin/returns/${ret.body.data.id}/actions`, { action: 'APPROVE' });
    const refunded = await admin.post(`/api/admin/returns/${ret.body.data.id}/actions`, { action: 'REFUND' });
    expect(refunded.body.data.refundTo).toBe('ORIGINAL');
    expect(gateway.refunds).toHaveLength(1);
    expect(await prisma.storeCreditEntry.count({ where: { userId: me.userId } })).toBe(0);
  });
});
