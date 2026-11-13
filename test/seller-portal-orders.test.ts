import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * Seller portal screens: the catalog overview, the upload check (a dry run),
 * price requests, the review team's activity, stock history, and orders and
 * earnings derived from the order lines of the seller's products.
 */
const { app, prisma, fixtures } = harness();

let seller: string;
let otherSeller: string;
let reviewer: string;
let run: string;

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  upload: (url: string, name: string, text: string) =>
    request(app).post(url).set('Authorization', `Bearer ${token}`).attach('file', Buffer.from(text), name),
});

const HEADER = 'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Subcategory,Product_Status,Color,Size,Selling_Price,MRP,Inventory_Qty,Image_1_URL';
const row = (code: string, color: string, o: { price?: string; qty?: string } = {}) =>
  [
    `${code}-${color.slice(0, 3).toUpperCase()}`,
    code,
    `Linen Shirt ${code}`,
    'Northfold',
    'clothing',
    'Men',
    'ACTIVE',
    color,
    'M',
    o.price ?? '40.00',
    '60.00',
    o.qty ?? '10',
    `https://cdn.test.local/${code}-${color}.jpg`,
  ].join(',');
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

/** A new product, approved and live. Returns its parent id. */
async function liveProduct(code: string) {
  const res = await as(seller).upload('/api/seller/submissions', 'new.csv', csv(row(code, 'Blue'), row(code, 'White')));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const ref = res.body.data.submissions[0].reference;
  expect((await as(reviewer).post(`/api/admin/submissions/${ref}/approve`)).status).toBe(200);
  return (await prisma.parentProduct.findUniqueOrThrow({ where: { code } })).id;
}

async function order(lines: { sku: string; qty: number }[], o: { status?: string; paid?: boolean } = {}) {
  const products = await prisma.product.findMany({ where: { sku: { in: lines.map((l) => l.sku) } } });
  const items = lines.map((l) => {
    const p = products.find((x) => x.sku === l.sku)!;
    return {
      productId: p.id,
      merchantId: p.merchantId,
      productName: p.name,
      sku: p.sku,
      unitPrice: p.price,
      quantity: l.qty,
      lineTotal: p.price.mul(l.qty),
    };
  });
  const total = items.reduce((s, i) => s.plus(i.lineTotal), new Prisma.Decimal(0));
  const paid = o.paid ?? true;
  return prisma.order.create({
    data: {
      orderNumber: `T-${randomUUID()}`,
      customerEmail: 'buyer@test.local',
      status: o.status ?? (paid ? 'PAID' : 'PENDING_PAYMENT'),
      currency: 'USD',
      subtotal: total,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: total,
      paymentStatus: paid ? 'SUCCEEDED' : 'PENDING',
      paidAt: paid ? new Date() : null,
      shipRecipientName: 'Buyer Name',
      shipAddressLine1: '1 Private Street',
      shipCity: 'Portland',
      shipState: 'OR',
      shipPostalCode: '97201',
      shipCountry: 'US',
      items: { create: items },
    },
  });
}

beforeAll(async () => {
  seller = await fixtures.registerUser('ROLE_MERCHANT');
  otherSeller = await fixtures.registerUser('ROLE_MERCHANT');
  reviewer = await fixtures.registerUser('ROLE_CATALOG');
  run = randomUUID().slice(0, 8).toUpperCase();
});

describe('catalog and stock history', () => {
  it('lists the seller’s products with state, prices and stock; not other sellers’', async () => {
    const code = `PO-${run}-A`;
    const id = await liveProduct(code);
    const res = await as(seller).get('/api/seller/catalog');
    expect(res.status).toBe(200);
    const p = res.body.data.find((x: { code: string }) => x.code === code);
    expect(p).toMatchObject({ id, state: 'LIVE', category: expect.any(String), openSubmission: null });
    expect(p.imageUrl).toContain(code);
    expect(p.variants[0]).toMatchObject({ sku: `${code}-BLU`, price: 40, mrp: 60, stockQuantity: 10, lowStockThreshold: expect.any(Number) });
    expect((await as(otherSeller).get('/api/seller/catalog')).body.data.some((x: { code: string }) => x.code === code)).toBe(false);

    await as(seller).post('/api/seller/stock', { items: [{ sku: `${code}-BLU`, quantity: 3 }] });
    const history = await as(seller).get(`/api/seller/products/${id}/stock-history`);
    expect(history.body.data[0]).toMatchObject({ sku: `${code}-BLU`, from: 10, to: 3, source: 'SELLER' });
    expect((await as(otherSeller).get(`/api/seller/products/${id}/stock-history`)).status).toBe(404);

    const rows = await as(seller).get(`/api/seller/products/${id}/rows`);
    expect(rows.body.data).toHaveLength(2);
    expect(rows.body.data[0]).toMatchObject({ SKU_ID: `${code}-BLU`, Selling_Price: '40.00', Product_Status: 'ACTIVE' });
  });
});

describe('upload check', () => {
  it('reports every row without writing or submitting anything', async () => {
    const code = `PO-${run}-C`;
    const res = await as(seller).upload(
      '/api/seller/submissions/check',
      'check.csv',
      csv(row(code, 'Blue'), row(`${code}X`, 'Red', { price: 'abc' })),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 2, ready: 1, toFix: 1 });
    expect(res.body.data.rows[0]).toMatchObject({ row: 2, sku: `${code}-BLU`, status: 'OK', name: `Linen Shirt ${code}` });
    expect(res.body.data.rows[1]).toMatchObject({ row: 3, status: 'FIX', issues: [{ level: 'error', message: "Selling_Price 'abc' is not a number" }] });
    expect(await prisma.product.findUnique({ where: { sku: `${code}-BLU` } })).toBeNull();

    // A SKU the seller already sells goes through as an update, with a note.
    const liveCode = `PO-${run}-D`;
    await liveProduct(liveCode);
    const again = await as(seller).upload('/api/seller/submissions/check', 'again.csv', csv(row(liveCode, 'Blue', { price: '35.00' })));
    expect(again.body.data.rows[0]).toMatchObject({ status: 'NOTE' });
  });
});

describe('price changes and activity', () => {
  it('a price request is an edit for review; it shows as a price change until and after the decision', async () => {
    const code = `PO-${run}-P`;
    const id = await liveProduct(code);
    expect((await as(seller).post(`/api/seller/products/${id}/price`, { items: [{ sku: `${code}-XXX`, price: 1 }] })).status).toBe(400);

    const res = await as(seller).post(`/api/seller/products/${id}/price`, { items: [{ sku: `${code}-BLU`, price: '32.50' }], note: 'Matching a competitor' });
    expect(res.status).toBe(200);
    const ref = res.body.data.submissions[0].reference;
    expect(res.body.data.submissions[0]).toMatchObject({ kind: 'EDIT', status: 'SUBMITTED' });
    // Live price untouched until approval.
    expect((await prisma.product.findUniqueOrThrow({ where: { sku: `${code}-BLU` } })).price.toFixed(2)).toBe('40.00');

    const open = await as(seller).get('/api/seller/price-changes');
    expect(open.body.data).toContainEqual(expect.objectContaining({ reference: ref, sku: `${code}-BLU`, from: 40, to: 32.5, status: 'SUBMITTED' }));

    expect((await as(reviewer).post(`/api/admin/submissions/${ref}/reject`, { note: 'Please confirm the price' })).status).toBe(200);
    const decided = await as(seller).get('/api/seller/price-changes');
    expect(decided.body.data).toContainEqual(
      expect.objectContaining({ reference: ref, from: 40, to: 32.5, status: 'REJECTED', reviewNote: 'Please confirm the price' }),
    );

    const activity = await as(seller).get('/api/seller/activity?limit=50');
    expect(activity.body.data).toContainEqual(expect.objectContaining({ reference: ref, status: 'REJECTED', note: 'Please confirm the price', parentProductId: id }));
    // The seller's own steps aren't notifications.
    expect(activity.body.data.some((e: { reference: string; status: string }) => e.reference === ref && e.status === 'SUBMITTED')).toBe(false);
    expect((await as(seller).get('/api/seller/activity?limit=0')).status).toBe(400);
  });
});

describe('orders and earnings', () => {
  it('shows paid orders with only the seller’s lines, and monthly gross, refunds and net', async () => {
    const code = `PO-${run}-O`;
    await liveProduct(code);
    const theirCode = `PO-${run}-T`;
    {
      const res = await as(otherSeller).upload('/api/seller/submissions', 't.csv', csv(row(theirCode, 'Blue')));
      await as(reviewer).post(`/api/admin/submissions/${res.body.data.submissions[0].reference}/approve`);
    }
    const before = (await as(seller).get('/api/seller/earnings?months=1')).body.data;

    const mixed = await order([
      { sku: `${code}-BLU`, qty: 2 },
      { sku: `${theirCode}-BLU`, qty: 1 },
    ]);
    await order([{ sku: `${code}-WHI`, qty: 1 }], { status: 'CANCELLED' });
    await order([{ sku: `${code}-WHI`, qty: 5 }], { paid: false });

    const list = await as(seller).get('/api/seller/orders?size=50');
    expect(list.status).toBe(200);
    const mine = list.body.data.content.find((o: { orderNumber: string }) => o.orderNumber === mixed.orderNumber);
    expect(mine).toMatchObject({ status: 'PAID', shipTo: 'Portland, OR', subtotal: 80, refunded: 0 });
    expect(mine.items).toEqual([expect.objectContaining({ sku: `${code}-BLU`, quantity: 2, lineTotal: 80 })]);
    expect(JSON.stringify(mine)).not.toContain('Private Street');
    expect(list.body.data.content.some((o: { status: string }) => o.status === 'PENDING_PAYMENT')).toBe(false);

    const toShip = await as(seller).get('/api/seller/orders?status=TO_SHIP&size=50');
    expect(toShip.body.data.content.every((o: { status: string }) => o.status === 'PAID' || o.status === 'CONFIRMED')).toBe(true);
    expect((await as(seller).get('/api/seller/orders?status=NOPE')).status).toBe(400);

    const after = (await as(seller).get('/api/seller/earnings?months=1')).body.data;
    expect(after.payoutSchedule).toBeNull();
    expect(after.periods).toHaveLength(1);
    expect(after.totals.gross - before.totals.gross).toBeCloseTo(120);
    expect(after.totals.refunds - before.totals.refunds).toBeCloseTo(40);
    expect(after.totals.net - before.totals.net).toBeCloseTo(80);
    expect(after.openOrders - before.openOrders).toBe(1);

    const theirs = (await as(otherSeller).get('/api/seller/orders?size=50')).body.data.content;
    expect(theirs.find((o: { orderNumber: string }) => o.orderNumber === mixed.orderNumber).items).toEqual([
      expect.objectContaining({ sku: `${theirCode}-BLU` }),
    ]);
  });

  it('is for sellers only', async () => {
    const customer = await fixtures.registerUser();
    expect((await as(customer).get('/api/seller/orders')).status).toBe(403);
    expect((await request(app).get('/api/seller/earnings')).status).toBe(401);
  });
});
