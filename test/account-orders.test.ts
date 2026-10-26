import { describe, expect, it } from 'vitest';
import { accountShopping } from './support/account-shopping';
import { harness } from './support/harness';

/** Account orders list: tabs, search, period, counts, return-by, invoice email, account summary (contract C1/C2). */
const h = harness();
const { prisma } = h;
const { shopper, newOrder } = accountShopping(h);

const DAY = 86_400_000;

describe('order list filters and counts', () => {
  it('splits orders into open, delivered, returned and cancelled tabs, with counts', async () => {
    const me = await shopper();
    const open = await newOrder(me.userId, [{ price: '10.00', qty: 1 }], { status: 'SHIPPED' });
    const delivered = await newOrder(me.userId, [{ price: '12.00', qty: 2 }], { name: 'Linen Shirt' });
    const returned = await newOrder(me.userId, [{ price: '8.00', qty: 1 }]);
    await me.post(`/api/orders/${returned.id}/returns`, { items: [{ orderItemId: returned.items[0].id, quantity: 1 }], reason: 'Too big' });
    const refunded = await newOrder(me.userId, [{ price: '5.00', qty: 1 }], { status: 'REFUNDED' });
    const cancelled = await newOrder(me.userId, [{ price: '5.00', qty: 1 }], { status: 'CANCELLED' });
    // A rejected return doesn't make an order "returned".
    const rejected = await newOrder(me.userId, [{ price: '9.00', qty: 1 }]);
    const r = await me.post(`/api/orders/${rejected.id}/returns`, { items: [{ orderItemId: rejected.items[0].id, quantity: 1 }], reason: 'Meh' });
    await prisma.orderReturn.update({ where: { id: r.body.data.id }, data: { status: 'REJECTED' } });

    const ids = async (query: string) => ((await me.get(`/api/orders?${query}`)).body.data.content as { id: string }[]).map((o) => o.id).sort();
    expect(await ids('status=open')).toEqual([open.id]);
    expect(await ids('status=delivered')).toEqual([delivered.id, rejected.id].sort());
    expect(await ids('status=returned')).toEqual([returned.id, refunded.id].sort());
    expect(await ids('status=cancelled')).toEqual([cancelled.id]);
    expect((await me.get('/api/orders?status=done')).body.data.totalElements).toBe(5);

    const counts = await me.get('/api/orders/counts');
    expect(counts.status).toBe(200);
    expect(counts.body.data).toEqual({ all: 6, open: 1, delivered: 2, returned: 2, cancelled: 1 });

    // Search by item name or order number (typed any way).
    expect(await ids('q=linen')).toEqual([delivered.id]);
    expect(await ids(`q=${delivered.orderNumber.replace('-', '').toLowerCase()}`)).toEqual([delivered.id]);
    expect((await me.get('/api/orders/counts?q=linen')).body.data).toMatchObject({ all: 1, delivered: 1, open: 0 });

    expect((await me.get('/api/orders?status=bogus')).status).toBe(400);
    expect((await me.get('/api/orders?period=1w')).body.data).toEqual({ period: 'must be one of 30d, 3m, 6m or a year (YYYY)' });
  });

  it('filters by period: last 30 days, months, or a calendar year', async () => {
    const me = await shopper();
    const recent = await newOrder(me.userId, [{ price: '10.00', qty: 1 }]);
    const old = await newOrder(me.userId, [{ price: '10.00', qty: 1 }], { createdAt: new Date(Date.now() - 100 * DAY) });
    const lastYear = await newOrder(me.userId, [{ price: '10.00', qty: 1 }], { createdAt: new Date(Date.UTC(2024, 5, 1)) });

    const ids = async (period: string) =>
      ((await me.get(`/api/orders?period=${period}`)).body.data.content as { id: string }[]).map((o) => o.id).sort();
    expect(await ids('30d')).toEqual([recent.id]);
    expect(await ids('6m')).toEqual([recent.id, old.id].sort());
    expect(await ids('2024')).toEqual([lastYear.id]);
    expect((await me.get('/api/orders/counts?period=2024')).body.data.all).toBe(1);
  });

  it('summaries carry returnBy, hasReturnableItems and the returns', async () => {
    const me = await shopper();
    const order = await newOrder(me.userId, [{ price: '10.00', qty: 1 }, { price: '4.00', qty: 1 }]);
    const late = await newOrder(me.userId, [{ price: '10.00', qty: 1 }], { deliveredAt: new Date(Date.now() - 40 * DAY) });
    const ret = await me.post(`/api/orders/${order.id}/returns`, { items: [{ orderItemId: order.items[0].id, quantity: 1 }], reason: 'Too big' });

    const rows = (await me.get('/api/orders')).body.data.content as Record<string, unknown>[];
    const row = rows.find((o) => o.id === order.id)!;
    expect(row).toMatchObject({ hasReturnableItems: true, returns: [{ id: ret.body.data.id, rmaNumber: ret.body.data.rmaNumber, status: 'REQUESTED' }] });
    expect(new Date(row.returnBy as string).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(rows.find((o) => o.id === late.id)).toMatchObject({ hasReturnableItems: false, returnBy: null, returns: [] });

    // Once every unit is on its way back, nothing is left to return.
    await me.post(`/api/orders/${order.id}/returns`, { items: [{ orderItemId: order.items[1].id, quantity: 1 }], reason: 'Too big' });
    const after = ((await me.get('/api/orders')).body.data.content as Record<string, unknown>[]).find((o) => o.id === order.id);
    expect(after).toMatchObject({ hasReturnableItems: false, returnBy: null });
  });
});

describe('invoice email', () => {
  it('logs an ORDER_INVOICE notification and answers 202', async () => {
    const me = await shopper();
    const order = await newOrder(me.userId, [{ price: '10.00', qty: 2 }]);
    const res = await me.post(`/api/orders/${order.orderNumber}/invoice/email`);
    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Invoice sent');
    const mail = await prisma.notification.findFirstOrThrow({ where: { orderId: order.id, template: 'ORDER_INVOICE' } });
    expect(mail.body).toContain('Total: 20.00 USD');

    const other = await shopper();
    expect((await other.post(`/api/orders/${order.id}/invoice/email`)).status).toBe(404);
  });
});

describe('account summary', () => {
  it('counts orders, open returns, saved items and features the latest open order', async () => {
    const me = await shopper();
    const empty = await me.get('/api/users/me/summary');
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ orders: { total: 0, open: 0 }, openReturns: 0, savedItems: 0, storeCreditBalance: 0, latestOrder: null });

    const shipped = await newOrder(me.userId, [{ price: '10.00', qty: 1 }], { status: 'SHIPPED', createdAt: new Date(Date.now() - 5 * DAY) });
    const delivered = await newOrder(me.userId, [{ price: '10.00', qty: 1 }]);
    await me.post(`/api/orders/${delivered.id}/returns`, { items: [{ orderItemId: delivered.items[0].id, quantity: 1 }], reason: 'Too big' });
    await me.post('/api/users/me/saved-items', { productId: delivered.items[0].productId });
    await prisma.user.update({ where: { id: me.userId }, data: { storeCreditBalance: '12.50' } });

    const res = await me.get('/api/users/me/summary');
    expect(res.body.data).toMatchObject({
      orders: { total: 2, open: 1 },
      openReturns: 1,
      savedItems: 1,
      storeCreditBalance: 12.5,
      latestOrder: { id: shipped.id, status: 'SHIPPED' },
    });
    expect(res.body.data.memberSince).toBeTruthy();
  });
});
