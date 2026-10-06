import { randomUUID } from 'node:crypto';
import { Prisma, type Product, type User } from '@prisma/client';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { harness } from './support/harness';
import { RecordingPaymentGateway } from './support/recording-gateway';

/**
 * Admin operations (FR-AD-02/04/06/07/08, FR-IN-03/04/05): fulfilment,
 * shipping, admin cancellation, returns and refunds, customers, reports.
 */
const gateway = new RecordingPaymentGateway();
const { app, prisma, container, fixtures } = harness({ gateway });

let admin: string;
let adminUser: User;
const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
});

type OrderState = 'PENDING_PAYMENT' | 'PAID' | 'SHIPPED' | 'DELIVERED';

/**
 * An order written straight to the database, as checkout would leave it
 * (stock already taken): independent of the checkout code under test elsewhere.
 */
async function newOrder(
  lines: { price: string; qty: number; stockLeft?: number }[],
  options: { state?: OrderState; user?: User | null; email?: string; paidAt?: Date; city?: string } = {},
) {
  const state = options.state ?? 'PAID';
  const products: Product[] = [];
  for (const l of lines) products.push(await fixtures.newActiveProduct(l.stockLeft ?? 8, l.price));
  const total = lines.reduce((s, l) => s.add(new Prisma.Decimal(l.price).mul(l.qty)), new Prisma.Decimal(0));
  const paid = state !== 'PENDING_PAYMENT';
  const user = options.user === undefined ? await fixtures.newCustomer() : options.user;
  const paidAt = paid ? (options.paidAt ?? new Date()) : null;
  const order = await prisma.order.create({
    data: {
      userId: user?.id ?? null,
      customerEmail: options.email ?? user?.email ?? `guest-${randomUUID()}@test.local`,
      orderNumber: `T-${randomUUID()}`,
      status: state,
      currency: 'USD',
      subtotal: total,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: total,
      paymentStatus: paid ? 'SUCCEEDED' : 'PENDING',
      paymentReference: `TEST-${randomUUID()}`,
      paymentIntentId: `TEST-${randomUUID()}`,
      shippingMethod: 'STANDARD',
      fulfilmentStatus: state === 'PAID' ? 'UNFULFILLED' : state === 'PENDING_PAYMENT' ? null : state,
      paidAt,
      shippedAt: state === 'SHIPPED' || state === 'DELIVERED' ? new Date() : null,
      deliveredAt: state === 'DELIVERED' ? new Date() : null,
      shipRecipientName: user?.fullName ?? 'Guest Shopper',
      shipAddressLine1: '1 Test Street',
      shipCity: options.city ?? 'Testville',
      shipState: 'TS',
      shipPostalCode: '12345',
      shipCountry: 'US',
      items: {
        create: lines.map((l, i) => ({
          productId: products[i].id,
          merchantId: products[i].merchantId,
          productName: products[i].name,
          sku: products[i].sku,
          unitPrice: new Prisma.Decimal(l.price),
          quantity: l.qty,
          lineTotal: new Prisma.Decimal(l.price).mul(l.qty),
        })),
      },
    },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });
  return { order, products, user };
}

const reload = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  admin = await fixtures.registerUser('ROLE_ADMIN');
  adminUser = (await prisma.user.findFirstOrThrow({ where: { role: 'ROLE_ADMIN' }, orderBy: { createdAt: 'desc' } }));
});

beforeEach(() => gateway.reset());

describe('access (FR-AD-08)', () => {
  it('keeps catalog staff and customers out of operations', async () => {
    const catalog = await fixtures.registerUser('ROLE_CATALOG');
    const customer = await fixtures.registerUser('ROLE_CUSTOMER');
    const { order } = await newOrder([{ price: '10.00', qty: 1 }]);
    for (const url of [
      '/api/admin/orders',
      '/api/admin/orders/stats',
      '/api/admin/orders/export',
      `/api/admin/orders/${order.id}`,
      '/api/admin/returns',
      '/api/admin/customers',
      '/api/admin/reports/sales?days=7',
      '/api/admin/analytics/summary',
      '/api/admin/settings',
    ]) {
      expect((await as(catalog).get(url)).status, url).toBe(403);
      expect((await as(customer).get(url)).status, url).toBe(403);
      expect((await request(app).get(url)).status, url).toBe(401);
    }
    expect((await as(catalog).post(`/api/admin/orders/${order.id}/fulfilment`, { status: 'PICKED' })).status).toBe(403);
    expect((await as(catalog).post(`/api/admin/orders/${order.id}/cancel`)).status).toBe(403);
    // Catalog routes still answer catalog staff.
    expect((await as(catalog).get('/api/admin/products')).status).toBe(200);
  });
});

describe('fulfilment and shipping (FR-AD-02, FR-IN-03/04)', () => {
  it('moves fulfilment forward only, on paid orders only', async () => {
    const { order } = await newOrder([{ price: '10.00', qty: 1 }]);
    const url = `/api/admin/orders/${order.id}/fulfilment`;

    const picked = await as(admin).post(url, { status: 'PICKED' });
    expect(picked.status).toBe(200);
    expect(picked.body.data).toEqual({ id: order.id, status: 'CONFIRMED', fulfilmentStatus: 'PICKED' });

    const again = await as(admin).post(url, { status: 'PICKED' });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe("Fulfilment can't go from PICKED to PICKED");

    expect((await as(admin).post(url, { status: 'PACKED', note: 'Box 3' })).body.data.fulfilmentStatus).toBe('PACKED');
    expect((await as(admin).post(url, { status: 'PICKED' })).status).toBe(409);
    expect((await as(admin).post(url, { status: 'SHIPPED' })).status).toBe(400);

    const pending = await newOrder([{ price: '10.00', qty: 1 }], { state: 'PENDING_PAYMENT' });
    const notPaid = await as(admin).post(`/api/admin/orders/${pending.order.id}/fulfilment`, { status: 'PICKED' });
    expect(notPaid.status).toBe(409);

    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.status, e.fulfilmentStatus])).toEqual([
      ['CONFIRMED', 'PICKED'],
      [null, 'PACKED'],
    ]);
    expect(events[1].note).toBe('Box 3');
    expect(events[0].actor).toMatch(/^ADMIN:/);
  });

  it('ships through the provider, then delivers on the carrier scan', async () => {
    const { order } = await newOrder([{ price: '10.00', qty: 2 }]);
    const shipped = await as(admin).post(`/api/admin/orders/${order.id}/shipments`, {
      carrier: 'ups',
      trackingNumber: '1Z999AA10123456784',
      service: 'Ground',
    });
    expect(shipped.status).toBe(201);
    expect(shipped.body.data).toMatchObject({
      provider: 'manual',
      carrier: 'UPS',
      service: 'Ground',
      trackingNumber: '1Z999AA10123456784',
      trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      status: 'LABEL_CREATED',
      events: [{ status: 'LABEL_CREATED' }],
    });
    const afterShip = await reload(order.id);
    expect(afterShip).toMatchObject({ status: 'SHIPPED', fulfilmentStatus: 'SHIPPED' });
    expect(afterShip.shippedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'ORDER_SHIPPED' } })).toBe(1);

    // Can't ship twice or step back.
    expect((await as(admin).post(`/api/admin/orders/${order.id}/shipments`, {})).status).toBe(409);
    expect((await as(admin).post(`/api/admin/orders/${order.id}/fulfilment`, { status: 'PACKED' })).status).toBe(409);

    const shipmentId = shipped.body.data.id;
    const transit = await as(admin).post(`/api/admin/shipments/${shipmentId}/events`, { status: 'IN_TRANSIT', location: 'Portland, OR' });
    expect(transit.body.data).toMatchObject({ status: 'IN_TRANSIT', events: [{ status: 'IN_TRANSIT' }, { status: 'LABEL_CREATED' }] });
    expect((await reload(order.id)).status).toBe('SHIPPED');

    const at = new Date(Date.now() - 60_000).toISOString();
    const delivered = await as(admin).post(`/api/admin/shipments/${shipmentId}/events`, { status: 'DELIVERED', occurredAt: at });
    expect(delivered.body.data).toMatchObject({ status: 'DELIVERED', deliveredAt: at });
    const done = await reload(order.id);
    expect(done).toMatchObject({ status: 'DELIVERED', fulfilmentStatus: 'DELIVERED' });
    expect(done.deliveredAt?.toISOString()).toBe(at);
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'ORDER_DELIVERED' } })).toBe(1);

    expect((await as(admin).post(`/api/admin/shipments/${shipmentId}/events`, { status: 'IN_TRANSIT' })).status).toBe(409);
    expect((await as(admin).post(`/api/admin/shipments/${shipmentId}/events`, { status: 'LABEL_CREATED' })).status).toBe(400);

    const detail = await as(admin).get(`/api/admin/orders/${order.id}`);
    expect(detail.body.data.shipments).toHaveLength(1);
    expect(detail.body.data.timeline.map((t: { status: string }) => t.status)).toEqual(['SHIPPED', 'DELIVERED']);
    expect(detail.body.data.notifications.map((n: { template: string }) => n.template)).toEqual([
      'ORDER_DELIVERED',
      'ORDER_SHIPPED',
    ]);
  });

  it('generates a MAN- reference when no tracking number is given', async () => {
    const { order } = await newOrder([{ price: '10.00', qty: 1 }]);
    const res = await as(admin).post(`/api/admin/orders/${order.id}/shipments`, {});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ carrier: 'Manual', trackingUrl: null });
    expect(res.body.data.trackingNumber).toMatch(/^MAN-\d{10}$/);

    const usps = await newOrder([{ price: '10.00', qty: 1 }]);
    const detected = await as(admin).post(`/api/admin/orders/${usps.order.id}/shipments`, {
      trackingNumber: '9400 1000 0000 0000 0000 00',
    });
    expect(detected.body.data).toMatchObject({ carrier: 'USPS', trackingNumber: '9400100000000000000000' });
    expect(detected.body.data.trackingUrl).toContain('tools.usps.com');
  });
});

describe('orders list, stats, detail, export', () => {
  it('filters by fulfilment status and search, and exports what it lists', async () => {
    const guestEmail = `guest-${randomUUID()}@test.local`;
    const { order } = await newOrder([{ price: '12.50', qty: 2 }], { user: null, email: guestEmail });

    const list = await as(admin).get(`/api/admin/orders?search=${guestEmail}&fulfilmentStatus=UNFULFILLED`);
    expect(list.status).toBe(200);
    expect(list.body.data.content).toEqual([
      expect.objectContaining({
        id: order.id,
        fulfilmentStatus: 'UNFULFILLED',
        shippingMethod: 'STANDARD',
        itemCount: 2,
        grandTotal: 25,
        tracking: [],
        customer: { name: 'Guest Shopper', email: guestEmail, city: 'Testville', state: 'TS' },
      }),
    ]);
    expect((await as(admin).get(`/api/admin/orders?search=${guestEmail}&fulfilmentStatus=PACKED`)).body.data.content).toEqual([]);
    expect((await as(admin).get('/api/admin/orders?fulfilmentStatus=NOPE')).status).toBe(400);

    const detail = await as(admin).get(`/api/admin/orders/${order.id}`);
    expect(detail.body.data.customer).toEqual({
      id: null,
      fullName: 'Guest Shopper',
      email: guestEmail,
      phoneNumber: null,
      orders: 1,
      guest: true,
    });
    expect(detail.body.data.paymentReference).toBe(order.paymentReference);

    const stats = await as(admin).get('/api/admin/orders/stats');
    expect(stats.body.data.awaitingFulfilment.UNFULFILLED).toBeGreaterThanOrEqual(1);
    expect(stats.body.data).toHaveProperty('returnsByStatus');

    const csv = await as(admin).get(`/api/admin/orders/export?search=${guestEmail}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="orders-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Order number,Created,Status/);
    expect(lines[1]).toContain(order.orderNumber);
    expect(lines[1]).toContain('25.00');
  });

  it('marks a manual-gateway order paid', async () => {
    const { order } = await newOrder([{ price: '10.00', qty: 1 }], { state: 'PENDING_PAYMENT' });
    const res = await as(admin).post(`/api/admin/orders/${order.id}/pay`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'PAID', fulfilmentStatus: 'UNFULFILLED', paymentStatus: 'SUCCEEDED' });
    expect((await as(admin).post(`/api/admin/orders/${order.id}/pay`)).status).toBe(409);
  });
});

describe('admin cancellation (FR-AD-04, NFR-08)', () => {
  it('refunds a paid order and restocks exactly once under concurrent cancels', async () => {
    const { order, products } = await newOrder([{ price: '15.00', qty: 2, stockLeft: 8 }]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => as(admin).post(`/api/admin/orders/${order.id}/cancel`, { reason: 'Customer called' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await fixtures.stockOf(products[0].id)).toBe(10);
    expect(gateway.refunds).toHaveLength(1);
    expect(gateway.refunds[0].amount.toFixed(2)).toBe('30.00');

    const cancelled = await reload(order.id);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'ADMIN', cancellationReason: 'Customer called' });
    expect(cancelled.refundedTotal.toFixed(2)).toBe('30.00');
    const movements = await prisma.stockMovement.findMany({ where: { productId: products[0].id } });
    expect(movements.map((m) => [m.source, m.delta, m.quantityAfter])).toEqual([['CANCELLATION', 2, 10]]);
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'ORDER_CANCELLED' } })).toBe(1);
  });

  it('cancels an unpaid order without a refund, and never a shipped one', async () => {
    const pending = await newOrder([{ price: '15.00', qty: 1, stockLeft: 4 }], { state: 'PENDING_PAYMENT' });
    const res = await as(admin).post(`/api/admin/orders/${pending.order.id}/cancel`, {});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Cancelled by admin' });
    expect(gateway.refunds).toHaveLength(0);
    expect(await fixtures.stockOf(pending.products[0].id)).toBe(5);

    const shipped = await newOrder([{ price: '15.00', qty: 1 }], { state: 'SHIPPED' });
    expect((await as(admin).post(`/api/admin/orders/${shipped.order.id}/cancel`, {})).status).toBe(409);
  });
});

describe('returns and refunds (FR-AD-07)', () => {
  it('approves, receives with restock, refunds partially, then fully', async () => {
    // 2 × 10.00 + 1 × 5.00 = 25.00
    const { order, products } = await newOrder(
      [
        { price: '10.00', qty: 2, stockLeft: 3 },
        { price: '5.00', qty: 1, stockLeft: 3 },
      ],
      { state: 'DELIVERED' },
    );
    const [lineA, lineB] = order.items;
    const open = (items: { orderItemId: string; quantity: number }[]) =>
      as(admin).post(`/api/admin/orders/${order.id}/returns`, { items, reason: 'Wrong size' });
    const act = (id: string, body: object) => as(admin).post(`/api/admin/returns/${id}/actions`, body);

    const first = await open([{ orderItemId: lineA.id, quantity: 1 }]);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: 'REQUESTED', requestedBy: 'ADMIN', estimatedRefund: 10 });
    expect(first.body.data.rmaNumber).toMatch(/^RMA-\d{6}$/);
    const r1 = first.body.data.id;

    // Only one more A is left to return while this one is open.
    expect((await open([{ orderItemId: lineA.id, quantity: 2 }])).status).toBe(400);

    expect((await act(r1, { action: 'APPROVE' })).body.data.status).toBe('APPROVED');
    expect((await act(r1, { action: 'APPROVE' })).status).toBe(409);
    const received = await act(r1, { action: 'RECEIVE', restock: true, note: 'Unworn' });
    expect(received.body.data).toMatchObject({ status: 'RECEIVED', restocked: true, adminNote: 'Unworn', refundDue: 10 });
    expect(await fixtures.stockOf(products[0].id)).toBe(4);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } })).returnedQuantity).toBe(1);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { productId: products[0].id } });
    expect(movement).toMatchObject({ source: 'RETURN', delta: 1, quantityAfter: 4 });

    // Partial refund: less than the line's value.
    const partial = await act(r1, { action: 'REFUND', refundAmount: 4 });
    expect(partial.status).toBe(200);
    expect(partial.body.data).toMatchObject({ status: 'REFUNDED', refundAmount: 4, refundDue: 0 });
    expect(partial.body.data.order).toMatchObject({ status: 'DELIVERED', refundedTotal: 4 });
    expect(gateway.refunds.map((r) => r.amount.toFixed(2))).toEqual(['4.00']);
    expect((await reload(order.id)).paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect((await act(r1, { action: 'REFUND' })).status).toBe(409);

    // Second return: the rest of the order, refunded in full without receiving.
    const second = await open([
      { orderItemId: lineA.id, quantity: 1 },
      { orderItemId: lineB.id, quantity: 1 },
    ]);
    const r2 = second.body.data.id;
    await act(r2, { action: 'APPROVE' });
    const detail = await as(admin).get(`/api/admin/returns/${r2}`);
    expect(detail.body.data).toMatchObject({ refundDue: 15, lines: [{ quantity: 1, unitPrice: 10 }, { quantity: 1, unitPrice: 5 }] });
    expect((await act(r2, { action: 'REFUND', refundAmount: 21.01 })).status).toBe(400);

    const full = await act(r2, { action: 'REFUND', refundAmount: 21 });
    expect(full.status).toBe(200);
    const done = await reload(order.id);
    expect(done).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
    expect(done.refundedTotal.toFixed(2)).toBe('25.00');
    expect(gateway.refunds).toHaveLength(2);
    expect(await prisma.notification.count({ where: { orderId: order.id, template: 'REFUND_ISSUED' } })).toBe(2);

    // The provider's charge.refunded echo of our own refunds changes nothing.
    await container.orders.recordRefundByIntent(order.paymentIntentId!, 2500n, 'usd');
    const echoed = await reload(order.id);
    expect(echoed.refundedTotal.toFixed(2)).toBe('25.00');
    expect(echoed.status).toBe('REFUNDED');

    const list = await as(admin).get('/api/admin/returns?status=REFUNDED&size=200');
    expect(list.body.data.content.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([r1, r2]));
  });

  it('rejects a return and only returns shipped orders', async () => {
    const { order } = await newOrder([{ price: '10.00', qty: 1 }], { state: 'DELIVERED' });
    const opened = await as(admin).post(`/api/admin/orders/${order.id}/returns`, {
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
      reason: 'Changed mind',
    });
    const rejected = await as(admin).post(`/api/admin/returns/${opened.body.data.id}/actions`, { action: 'REJECT', note: 'Outside policy' });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', adminNote: 'Outside policy', refundDue: 0 });
    expect((await as(admin).post(`/api/admin/returns/${opened.body.data.id}/actions`, { action: 'RECEIVE' })).status).toBe(409);

    const paid = await newOrder([{ price: '10.00', qty: 1 }]);
    const early = await as(admin).post(`/api/admin/orders/${paid.order.id}/returns`, {
      items: [{ orderItemId: paid.order.items[0].id, quantity: 1 }],
      reason: 'x',
    });
    expect(early.status).toBe(409);
  });

  it('records a provider partial refund it did not issue', async () => {
    const { order } = await newOrder([{ price: '50.00', qty: 1 }], { state: 'DELIVERED' });
    await container.orders.recordRefundByIntent(order.paymentIntentId!, 1000n, 'usd');
    const after = await reload(order.id);
    expect(after.refundedTotal.toFixed(2)).toBe('10.00');
    expect(after).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PARTIALLY_REFUNDED' });
    await container.orders.recordRefundByIntent(order.paymentIntentId!, 1000n, 'usd'); // redelivery
    expect((await reload(order.id)).refundedTotal.toFixed(2)).toBe('10.00');
  });
});

describe('customers and staff (FR-AD-06/08)', () => {
  it('lists customers with spend, sorted and searched', async () => {
    const tag = randomUUID().slice(0, 8);
    const make = (name: string) =>
      prisma.user.create({
        data: { email: `${name}-${tag}@test.local`, password: 'x', fullName: `${name} ${tag}`, role: 'ROLE_CUSTOMER', marketingOptIn: name === 'Big' },
      });
    const small = await make('Small');
    const big = await make('Big');
    const none = await make('None');
    await newOrder([{ price: '10.00', qty: 1 }], { user: small });
    await newOrder([{ price: '40.00', qty: 2 }], { user: big, city: 'Portland' });
    await newOrder([{ price: '5.00', qty: 1 }], { user: big, state: 'PENDING_PAYMENT', city: 'Salem' });

    const res = await as(admin).get(`/api/admin/customers?search=${tag}&sort=totalSpent,desc`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalElements).toBe(3);
    expect(res.body.data.content.map((c: { id: string }) => c.id)).toEqual([big.id, small.id, none.id]);
    expect(res.body.data.content[0]).toMatchObject({
      orders: 2,
      totalSpent: 80,
      marketingOptIn: true,
      location: 'Salem, TS', // the latest order's
      role: 'ROLE_CUSTOMER',
    });
    expect(res.body.data.content[2]).toMatchObject({ orders: 0, totalSpent: 0, lastOrderAt: null, location: null });

    const byName = await as(admin).get(`/api/admin/customers?search=${tag}&sort=fullName,asc`);
    expect(byName.body.data.content.map((c: { id: string }) => c.id)).toEqual([big.id, none.id, small.id]);
    const one = await as(admin).get(`/api/admin/customers?search=small-${tag}`);
    expect(one.body.data.content.map((c: { id: string }) => c.id)).toEqual([small.id]);
    expect((await as(admin).get(`/api/admin/customers?search=${tag}&role=ROLE_ADMIN`)).body.data.totalElements).toBe(0);
    expect((await as(admin).get('/api/admin/customers?sort=password')).status).toBe(400);

    const detail = await as(admin).get(`/api/admin/customers/${big.id}`);
    expect(detail.body.data).toMatchObject({ email: big.email, totalSpent: 80 });
    expect(detail.body.data.orders).toHaveLength(2);

    const csv = await as(admin).get(`/api/admin/customers/export?search=${tag}&sort=totalSpent,desc`);
    const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^Name,Email/);
    expect(lines[1]).toContain(big.email);
    expect(lines[1]).toContain('80.00');
  });

  it('changes staff roles, but not your own', async () => {
    const user = await fixtures.newCustomer();
    const res = await as(admin).patch(`/api/admin/users/${user.id}/role`, { role: 'ROLE_CATALOG' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, role: 'ROLE_CATALOG' });
    expect((await as(admin).patch(`/api/admin/users/${user.id}/role`, { role: 'ROLE_GOD' })).status).toBe(400);
    const self = await as(admin).patch(`/api/admin/users/${adminUser.id}/role`, { role: 'ROLE_CUSTOMER' });
    expect(self.status).toBe(409);
  });
});

describe('reports, analytics, settings', () => {
  it('adds a paid order to the sales report, net of refunds', async () => {
    const before = (await as(admin).get('/api/admin/reports/sales?days=7')).body.data;
    const { order, products } = await newOrder([{ price: '30.00', qty: 3 }]);
    await prisma.order.update({ where: { id: order.id }, data: { refundedTotal: 10 } });
    const after = (await as(admin).get('/api/admin/reports/sales?days=7')).body.data;

    expect(after.daily).toHaveLength(7);
    expect(after.totals.orders - before.totals.orders).toBe(1);
    expect(Math.round((after.totals.revenue - before.totals.revenue) * 100)).toBe(8000);
    expect(after.totals.units - before.totals.units).toBe(3);
    const dailySum = after.daily.reduce((s: number, d: { revenue: number }) => s + d.revenue, 0);
    expect(Math.round(dailySum * 100)).toBe(Math.round(after.totals.revenue * 100));
    expect(after.topProducts.find((p: { productId: string }) => p.productId === products[0].id)).toMatchObject({
      units: 3,
      revenue: 90,
      stockLeft: 8,
    });
    expect((await as(admin).get('/api/admin/reports/sales?days=9')).status).toBe(400);
  });

  it('summarises analytics events and paid orders', async () => {
    const product = await fixtures.newActiveProduct(5, '9.99');
    // An explicit date-only `to` covers the whole day: no race with the DB clock.
    const url = `/api/admin/analytics/summary?to=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}`;
    const before = (await as(admin).get(url)).body.data;
    const session = randomUUID();
    await prisma.analyticsEvent.createMany({
      data: [
        { eventType: 'PRODUCT_VIEW', sessionId: session, productId: product.id },
        { eventType: 'PRODUCT_VIEW', sessionId: session, productId: product.id },
        { eventType: 'ADD_TO_CART', sessionId: session, productId: product.id },
      ],
    });
    const after = (await as(admin).get(url)).body.data;
    expect(after.events.PRODUCT_VIEW.events - before.events.PRODUCT_VIEW.events).toBe(2);
    expect(after.events.PRODUCT_VIEW.sessions - before.events.PRODUCT_VIEW.sessions).toBe(1);
    expect(after.events.ADD_TO_CART.events - before.events.ADD_TO_CART.events).toBe(1);
    expect(after.topViewedProducts).toEqual(
      expect.arrayContaining([expect.objectContaining({ productId: product.id, sku: product.sku, count: 2 })]),
    );
    expect(after.conversionRate).not.toBeNull();
    expect((await as(admin).get('/api/admin/analytics/summary?from=nope')).status).toBe(400);
  });

  it('reports the server settings', async () => {
    const res = await as(admin).get('/api/admin/settings');
    expect(res.body.data).toMatchObject({
      currency: 'USD',
      paymentProvider: 'manual',
      manualPaymentConfirmation: true,
      shippingProvider: 'manual',
      pricesIncludeTax: false,
      shipping: [
        { method: 'STANDARD', fee: '5.99' },
        { method: 'EXPRESS', fee: '9.99' },
      ],
      freeShippingThreshold: '35.00',
      lowStockThreshold: 5,
      returnWindowDays: 30,
      email: 'log-only',
    });
  });
});
