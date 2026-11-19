import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { lastCutoff, nextPayoutDate, payoutDateOn } from '../src/seller/seller-orders.service';
import { harness } from './support/harness';

/**
 * Orders & earnings for sellers (designs/seller/seller-orders.html): tabs and
 * ship-by times, shipping with tracking, cancelling, approving a return,
 * commission, weekly payouts and statements. Sellers act only on orders whose
 * every line is theirs.
 */
const { app, prisma, fixtures, container } = harness();

let seller: string;
let otherSeller: string;
let reviewer: string;
let admin: string;
let run: string;

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
});

const HEADER = 'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Subcategory,Product_Status,Color,Size,Selling_Price,MRP,Inventory_Qty,Image_1_URL';

/** A live product of `token`'s seller with one SKU at $40. Returns the SKU. */
async function liveSku(token: string, code: string) {
  const line = [`${code}-BLU`, code, `Linen Shirt ${code}`, 'Northfold', 'clothing', 'Men', 'ACTIVE', 'Blue', 'M', '40.00', '60.00', '50', `https://cdn.test.local/${code}.jpg`].join(',');
  const res = await request(app)
    .post('/api/seller/submissions')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from([HEADER, line].join('\n')), 'new.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((await as(reviewer).post(`/api/admin/submissions/${res.body.data.submissions[0].reference}/approve`)).status).toBe(200);
  return `${code}-BLU`;
}

async function order(lines: { sku: string; qty: number }[], o: { status?: string; paidAgoHours?: number; deliveredAt?: Date } = {}) {
  const products = await prisma.product.findMany({ where: { sku: { in: lines.map((l) => l.sku) } } });
  const items = lines.map((l) => {
    const p = products.find((x) => x.sku === l.sku)!;
    return { productId: p.id, merchantId: p.merchantId, productName: p.name, sku: p.sku, unitPrice: p.price, quantity: l.qty, lineTotal: p.price.mul(l.qty) };
  });
  const total = items.reduce((s, i) => s.plus(i.lineTotal), new Prisma.Decimal(0));
  return prisma.order.create({
    data: {
      orderNumber: `SO-${randomUUID().slice(0, 13)}`,
      customerEmail: 'buyer@test.local',
      status: o.status ?? 'PAID',
      currency: 'USD',
      subtotal: total,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: total,
      paymentStatus: 'SUCCEEDED',
      paidAt: new Date(Date.now() - (o.paidAgoHours ?? 1) * 3_600_000),
      deliveredAt: o.deliveredAt ?? null,
      shipRecipientName: 'Jordan Buyer',
      shipPhone: '+15035550100',
      shipAddressLine1: '1 Private Street',
      shipCity: 'Portland',
      shipState: 'OR',
      shipPostalCode: '97201',
      shipCountry: 'US',
      items: { create: items },
    },
  });
}

let sku: string;
let otherSku: string;

beforeAll(async () => {
  seller = await fixtures.registerUser('ROLE_MERCHANT');
  otherSeller = await fixtures.registerUser('ROLE_MERCHANT');
  reviewer = await fixtures.registerUser('ROLE_CATALOG');
  admin = await fixtures.registerUser('ROLE_ADMIN');
  run = randomUUID().slice(0, 8).toUpperCase();
  sku = await liveSku(seller, `SO-${run}-A`);
  otherSku = await liveSku(otherSeller, `SO-${run}-B`);
});

describe('orders list and detail', () => {
  it('lists orders to ship with ship-by times, counts and the seller’s earnings after commission', async () => {
    const late = await order([{ sku, qty: 2 }], { paidAgoHours: 60 });
    const fresh = await order([{ sku, qty: 1 }], { paidAgoHours: 1 });
    const res = await as(seller).get('/api/seller/orders/list?tab=new');
    expect(res.status).toBe(200);
    const numbers = res.body.data.content.map((o: { orderNumber: string }) => o.orderNumber);
    // Most urgent first.
    expect(numbers.indexOf(late.orderNumber)).toBeLessThan(numbers.indexOf(fresh.orderNumber));
    expect(res.body.data.stats.late).toBeGreaterThanOrEqual(1);
    expect(res.body.data.counts.new).toBeGreaterThanOrEqual(2);
    expect(res.body.data.commissionRate).toBe(0.15);
    const row = res.body.data.content.find((o: { orderNumber: string }) => o.orderNumber === late.orderNumber);
    expect(row).toMatchObject({ state: 'new', statusLabel: 'To ship', sales: 80, commission: 12, net: 68, ownsAll: true, units: 2, shipToCity: 'Portland' });
    expect(new Date(row.shipBy).getTime()).toBe(late.paidAt!.getTime() + 48 * 3_600_000);

    const search = await as(seller).get(`/api/seller/orders/list?tab=all&q=${fresh.orderNumber}`);
    expect(search.body.data.content.map((o: { orderNumber: string }) => o.orderNumber)).toEqual([fresh.orderNumber]);
    expect((await as(otherSeller).get(`/api/seller/orders/${late.orderNumber}`)).status).toBe(404);
  });

  it('shows the full address only while the seller has the order to ship', async () => {
    const o = await order([{ sku, qty: 1 }]);
    const res = await as(seller).get(`/api/seller/orders/${o.orderNumber}`);
    expect(res.body.data.shipTo).toMatchObject({ name: 'Jordan Buyer', addressLine1: '1 Private Street', phone: '+15035550100', postalCode: '97201' });
    expect(res.body.data.actions).toEqual({ ship: true, cancel: true, approveReturn: false });

    await prisma.order.update({ where: { id: o.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    const after = await as(seller).get(`/api/seller/orders/${o.orderNumber}`);
    expect(after.body.data.shipTo.addressLine1).toBeUndefined();
    expect(after.body.data.state).toBe('delivered');
  });

  it('exports the orders of a tab as CSV', async () => {
    const o = await order([{ sku, qty: 3 }]);
    const res = await as(seller).get('/api/seller/orders/export?tab=new');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toBe('"order","placed","status","sku","product","qty","item_total","commission","you_earn","ship_to","carrier","tracking"');
    expect(res.text).toContain(`"${o.orderNumber}"`);
    expect(res.text).toContain('"120.00","18.00","102.00"');
  });
});

describe('seller actions', () => {
  it('ships an order with tracking; refuses a short tracking number', async () => {
    const o = await order([{ sku, qty: 1 }]);
    const bad = await as(seller).post(`/api/seller/orders/${o.orderNumber}/ship`, { carrier: 'UPS', trackingNumber: '123' });
    expect(bad.status).toBe(400);
    const res = await as(seller).post(`/api/seller/orders/${o.orderNumber}/ship`, { carrier: 'UPS', trackingNumber: '1Z 999 AA1 0123456784' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'shipped', shipment: { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }, actions: { ship: false } });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('SHIPPED');
    expect((await as(seller).post(`/api/seller/orders/${o.orderNumber}/ship`, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' })).status).toBe(409);
  });

  it('leaves orders shared with other sellers to our team', async () => {
    const o = await order([{ sku, qty: 1 }, { sku: otherSku, qty: 1 }]);
    const detail = await as(seller).get(`/api/seller/orders/${o.orderNumber}`);
    expect(detail.body.data).toMatchObject({ ownsAll: false, otherSellersLines: 1, actions: { ship: false, cancel: false } });
    expect(detail.body.data.lines).toHaveLength(1);
    const res = await as(seller).post(`/api/seller/orders/${o.orderNumber}/ship`, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
    expect(res.status).toBe(409);
  });

  it('cancels an order it can’t ship, with a reason', async () => {
    const o = await order([{ sku, qty: 1 }]);
    expect((await as(seller).post(`/api/seller/orders/${o.orderNumber}/cancel`, {})).status).toBe(400);
    const res = await as(seller).post(`/api/seller/orders/${o.orderNumber}/cancel`, { reason: 'Out of stock' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'cancelled', net: 0 });
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.status).toBe('CANCELLED');
    expect(row.cancellationReason).toBe('Seller cancelled: Out of stock');
  });

  it('approves a requested return', async () => {
    const o = await order([{ sku, qty: 1 }], { status: 'DELIVERED', deliveredAt: new Date() });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
    await prisma.orderReturn.create({
      data: { orderId: o.id, rmaNumber: `RMA-${randomUUID().slice(0, 12)}`, status: 'REQUESTED', reason: 'Wrong size', requestedBy: 'CUSTOMER', items: { create: [{ orderItemId: item.id, quantity: 1 }] } },
    });
    const list = await as(seller).get('/api/seller/orders/list?tab=return');
    expect(list.body.data.content.find((x: { orderNumber: string }) => x.orderNumber === o.orderNumber)).toMatchObject({ state: 'return', returnReason: 'Wrong size' });
    const res = await as(seller).post(`/api/seller/orders/${o.orderNumber}/return/approve`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.return.status).toBe('APPROVED');
    expect((await as(seller).post(`/api/seller/orders/${o.orderNumber}/return/approve`)).status).toBe(409);
  });
});

describe('payouts', () => {
  it('works out the Friday payout and the Sunday cutoff (UTC)', () => {
    const wed = new Date('2026-11-18T10:00:00Z');
    expect(lastCutoff(wed).toISOString()).toBe('2026-11-15T23:59:59.999Z');
    expect(payoutDateOn(wed).toISOString().slice(0, 10)).toBe('2026-11-20');
    expect(nextPayoutDate(wed).toISOString().slice(0, 10)).toBe('2026-11-20');
    const sun = new Date('2026-11-22T10:00:00Z');
    expect(lastCutoff(sun).toISOString()).toBe('2026-11-15T23:59:59.999Z');
  });

  it('closes delivered orders into one payout per seller, once; statements and marking paid', async () => {
    const lastWeek = new Date(Date.now() - 9 * 24 * 3_600_000);
    const delivered = await order([{ sku, qty: 2 }], { status: 'DELIVERED', deliveredAt: lastWeek });
    const recent = await order([{ sku, qty: 1 }], { status: 'DELIVERED', deliveredAt: new Date() });
    const before = await as(seller).get('/api/seller/payouts');
    expect(before.body.data.next.orders.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(expect.arrayContaining([delivered.orderNumber, recent.orderNumber]));

    const result = await container.sellerOrders.closeWeek();
    const mine = await prisma.sellerPayout.findFirstOrThrow({
      where: { reference: { in: result.payouts }, items: { some: { orderId: delivered.id } } },
      include: { items: true },
    });
    const item = mine.items.find((i) => i.orderId === delivered.id)!;
    expect(item).toMatchObject({ sales: new Prisma.Decimal('80'), commission: new Prisma.Decimal('12'), net: new Prisma.Decimal('68') });
    // Delivered after the cutoff: next week's payout.
    expect(mine.items.some((i) => i.orderId === recent.id)).toBe(false);
    expect(mine.status).toBe('SCHEDULED');

    // A second run pays nothing twice.
    const again = await container.sellerOrders.closeWeek();
    expect(await prisma.sellerPayoutItem.count({ where: { orderId: delivered.id } })).toBe(1);
    expect(again.payouts).not.toContain(mine.reference);

    const view = await as(seller).get('/api/seller/payouts');
    expect(view.body.data.history[0]).toMatchObject({ reference: mine.reference, status: 'SCHEDULED' });
    expect(view.body.data.next.orders.map((o: { orderNumber: string }) => o.orderNumber)).not.toContain(delivered.orderNumber);
    const detail = await as(seller).get(`/api/seller/orders/${delivered.orderNumber}`);
    expect(detail.body.data.payout).toMatchObject({ reference: mine.reference, status: 'SCHEDULED' });

    const stmt = await as(seller).get(`/api/seller/payouts/${mine.reference}/statement`);
    expect(stmt.status).toBe(200);
    expect(stmt.text).toContain(`${mine.reference},${delivered.orderNumber},`);
    expect((await as(otherSeller).get(`/api/seller/payouts/${mine.reference}/statement`)).status).toBe(404);

    expect((await as(seller).post(`/api/admin/payouts/${mine.reference}/paid`)).status).toBe(403);
    const paid = await as(admin).post(`/api/admin/payouts/${mine.reference}/paid`);
    expect(paid.status).toBe(200);
    expect((await as(admin).post(`/api/admin/payouts/${mine.reference}/paid`)).status).toBe(409);
    const list = await as(admin).get('/api/admin/payouts?status=PAID');
    expect(list.body.data.content.some((p: { reference: string }) => p.reference === mine.reference)).toBe(true);
  });
});
