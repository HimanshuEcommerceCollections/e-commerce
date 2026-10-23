import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * Seller portal: submissions, automated checks, the review queue and its
 * decisions, live listings untouched until approval, and stock applied
 * without review.
 */
const { app, prisma, fixtures } = harness();

let seller: string;
let otherSeller: string;
let reviewer: string;
let admin: string;
let customer: string;
let run: string;

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  upload: (url: string, name: string, text: string, note?: string) => {
    const req = request(app).post(url).set('Authorization', `Bearer ${token}`);
    if (note) req.field('note', note);
    return req.attach('file', Buffer.from(text), name);
  },
});

const HEADER =
  'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Subcategory,Product_Status,Color,Size,Selling_Price,Inventory_Qty,Image_1_URL';
const row = (code: string, color: string, o: { price?: string; qty?: string; status?: string; name?: string } = {}) =>
  [
    `${code}-${color.slice(0, 3).toUpperCase()}`,
    code,
    o.name ?? `Linen Shirt ${code}`,
    'Northfold',
    'clothing',
    'Men',
    o.status ?? 'ACTIVE',
    color,
    'M',
    o.price ?? '40.00',
    o.qty ?? '10',
    `https://cdn.test.local/${code}-${color}.jpg`,
  ].join(',');
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

const product = (sku: string) => prisma.product.findUniqueOrThrow({ where: { sku } });

/** Submits one new product and approves it: the starting point of the edit tests. */
async function liveProduct(code: string) {
  const res = await as(seller).upload('/api/seller/submissions', 'new.csv', csv(row(code, 'Blue'), row(code, 'White')));
  expect(res.status).toBe(200);
  const ref = res.body.data.submissions[0].reference;
  expect((await as(reviewer).post(`/api/admin/submissions/${ref}/approve`)).status).toBe(200);
  return ref as string;
}

beforeAll(async () => {
  seller = await fixtures.registerUser('ROLE_MERCHANT');
  otherSeller = await fixtures.registerUser('ROLE_MERCHANT');
  reviewer = await fixtures.registerUser('ROLE_CATALOG');
  admin = await fixtures.registerUser('ROLE_ADMIN');
  customer = await fixtures.registerUser('ROLE_CUSTOMER');
  run = randomUUID().slice(0, 8).toUpperCase();
});

describe('new products', () => {
  it('rejects bad rows at upload, keeps the rest as hidden drafts and queues them for review', async () => {
    const code = `SP-${run}-A`;
    const res = await as(seller).upload(
      '/api/seller/submissions',
      'shirts.csv',
      csv(row(code, 'Blue'), row(code, 'Green'), row(`SP-${run}-BAD`, 'Red', { price: 'abc' })),
      'Summer range',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalRows: 3,
      acceptedRows: 2,
      failedRows: 1,
      errors: [{ row: 4, sku: `SP-${run}-BAD-RED`, reason: "Selling_Price 'abc' is not a number" }],
      submissions: [{ kind: 'NEW_PRODUCT', status: 'SUBMITTED', parentProductCode: code, skus: [`${code}-BLU`, `${code}-GRE`] }],
    });

    // Written as drafts: codes reserved, nothing on sale.
    const blue = await product(`${code}-BLU`);
    expect(blue.status).toBe('DRAFT');
    expect((await request(app).get(`/api/products/${blue.id}`)).status).toBe(404);

    const mine = await as(seller).get('/api/seller/products');
    expect(mine.body.data.content.find((p: { code: string }) => p.code === code)).toMatchObject({ state: 'SUBMITTED' });

    const ref = res.body.data.submissions[0].reference;
    const queue = await as(reviewer).get('/api/admin/submissions?size=200');
    expect(queue.body.data.content.map((s: { reference: string }) => s.reference)).toContain(ref);

    const detail = await as(reviewer).get(`/api/admin/submissions/${ref}`);
    expect(detail.body.data).toMatchObject({ sellerNote: 'Summer range', events: [{ status: 'SUBMITTED' }] });
    expect(detail.body.data.changes[0]).toMatchObject({ sku: `${code}-BLU`, action: 'ADD' });
    expect(detail.body.data.changes[0].fields).toContainEqual({ column: 'Product_Status', before: '', after: 'ACTIVE' });

    const approved = await as(reviewer).post(`/api/admin/submissions/${ref}/approve`, { note: 'Looks good' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', reviewNote: 'Looks good' });
    expect((await product(`${code}-BLU`)).status).toBe('ACTIVE');
    expect((await request(app).get(`/api/products/${blue.id}`)).status).toBe(200);

    const mail = await prisma.notification.findFirst({ where: { template: 'SUBMISSION_UPDATE', subject: { contains: ref } } });
    expect(mail?.body).toContain('Looks good');

    // A decision is final: approving again is a conflict.
    expect((await as(reviewer).post(`/api/admin/submissions/${ref}/approve`)).status).toBe(409);
  });

  it('a DRAFT row is saved without being submitted, until the seller submits it', async () => {
    const code = `SP-${run}-D`;
    const res = await as(seller).upload('/api/seller/submissions', 'draft.csv', csv(row(code, 'Blue', { status: 'DRAFT' })));
    expect(res.body.data).toMatchObject({ submissions: [], draftsSaved: [`${code}-BLU`] });
    const parent = await prisma.parentProduct.findUniqueOrThrow({ where: { code } });

    const submitted = await as(seller).post(`/api/seller/products/${parent.id}/submit`, { note: 'Ready now' });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data).toMatchObject({ kind: 'NEW_PRODUCT', skus: [`${code}-BLU`] });
    expect((await as(seller).post(`/api/seller/products/${parent.id}/submit`)).status).toBe(409);
  });

  it('changes requested go back to the seller; a re-upload resubmits the same submission', async () => {
    const code = `SP-${run}-C`;
    const first = await as(seller).upload('/api/seller/submissions', 'c.csv', csv(row(code, 'Blue', { name: 'shirt' })));
    const ref = first.body.data.submissions[0].reference;

    expect((await as(reviewer).post(`/api/admin/submissions/${ref}/claim`)).body.data).toMatchObject({ status: 'IN_REVIEW' });
    // In review: the seller waits for the decision.
    const blocked = await as(seller).upload('/api/seller/submissions', 'c.csv', csv(row(code, 'Blue')));
    expect(blocked.body.data.errors[0].reason).toBe(`Product ${code} is in review (${ref}); wait for the decision before changing it`);

    expect((await as(reviewer).post(`/api/admin/submissions/${ref}/request-changes`, {})).status).toBe(400);
    const returned = await as(reviewer).post(`/api/admin/submissions/${ref}/request-changes`, { note: 'Use a proper product name' });
    expect(returned.body.data).toMatchObject({ status: 'CHANGES_REQUESTED', reviewNote: 'Use a proper product name' });
    const mine = await as(seller).get(`/api/seller/submissions/${ref}`);
    expect(mine.body.data).toMatchObject({ status: 'CHANGES_REQUESTED', reviewNote: 'Use a proper product name' });

    const again = await as(seller).upload('/api/seller/submissions', 'c.csv', csv(row(code, 'Blue', { name: `Linen Shirt ${code}` })));
    expect(again.body.data.submissions).toMatchObject([{ reference: ref, status: 'SUBMITTED' }]);
    expect((await product(`${code}-BLU`)).name).toBe(`Linen Shirt ${code}`);
  });

  it('a rejected product is closed: its drafts are archived', async () => {
    const code = `SP-${run}-R`;
    const res = await as(seller).upload('/api/seller/submissions', 'r.csv', csv(row(code, 'Blue')));
    const ref = res.body.data.submissions[0].reference;
    const rejected = await as(reviewer).post(`/api/admin/submissions/${ref}/reject`, { note: 'Counterfeit brand' });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', reviewNote: 'Counterfeit brand' });
    expect((await product(`${code}-BLU`)).status).toBe('ARCHIVED');
    expect((await as(seller).post(`/api/seller/submissions/${ref}/withdraw`)).status).toBe(409);
  });
});

describe('edits to a live product', () => {
  it('never touch the live listing until approved; stock applies at once', async () => {
    const code = `SP-${run}-E`;
    await liveProduct(code);

    const res = await as(seller).upload(
      '/api/seller/submissions',
      'edit.csv',
      csv(row(code, 'Blue', { price: '35.00', qty: '4' }), row(code, 'White'), row(code, 'Black')),
    );
    expect(res.body.data).toMatchObject({
      unchangedRows: 1,
      stockUpdates: [{ sku: `${code}-BLU`, from: 10, to: 4 }],
      submissions: [{ kind: 'EDIT', status: 'SUBMITTED', skus: [`${code}-BLU`, `${code}-BLA`] }],
    });
    const ref = res.body.data.submissions[0].reference;

    // Live: the old price, the new stock.
    const live = await product(`${code}-BLU`);
    expect(live.price.toFixed(2)).toBe('40.00');
    expect(live.stockQuantity).toBe(4);
    expect(await prisma.product.findUnique({ where: { sku: `${code}-BLA` } })).toBeNull();
    const movement = await prisma.stockMovement.findFirst({ where: { productId: live.id, source: 'SELLER' } });
    expect(movement).toMatchObject({ delta: -6, quantityAfter: 4 });

    const mine = await as(seller).get('/api/seller/products');
    expect(mine.body.data.content.find((p: { code: string }) => p.code === code)).toMatchObject({ state: 'CHANGE_PENDING' });

    const detail = await as(reviewer).get(`/api/admin/submissions/${ref}`);
    expect(detail.body.data.changes).toEqual([
      { sku: `${code}-BLU`, action: 'UPDATE', fields: [{ column: 'Selling_Price', before: '40.00', after: '35.00' }] },
      expect.objectContaining({ sku: `${code}-BLA`, action: 'ADD' }),
    ]);

    // A checkout between submission and approval must not be undone by the approval.
    await prisma.product.update({ where: { id: live.id }, data: { stockQuantity: 3 } });
    expect((await as(admin).post(`/api/admin/submissions/${ref}/approve`)).status).toBe(200);
    const after = await product(`${code}-BLU`);
    expect(after.price.toFixed(2)).toBe('35.00');
    expect(after.stockQuantity).toBe(3);
    expect((await product(`${code}-BLA`)).status).toBe('ACTIVE');
  });

  it('a second upload while waiting merges into the open submission', async () => {
    const code = `SP-${run}-M`;
    await liveProduct(code);
    const first = await as(seller).upload('/api/seller/submissions', 'a.csv', csv(row(code, 'Blue', { price: '30.00' })));
    const second = await as(seller).upload('/api/seller/submissions', 'b.csv', csv(row(code, 'White', { price: '31.00' })));
    expect(second.body.data.submissions[0].reference).toBe(first.body.data.submissions[0].reference);
    expect(second.body.data.submissions[0].skus).toEqual([`${code}-BLU`, `${code}-WHI`]);
  });

  it('delisting needs approval too', async () => {
    const code = `SP-${run}-X`;
    await liveProduct(code);
    const parent = await prisma.parentProduct.findUniqueOrThrow({ where: { code } });
    expect((await as(seller).post(`/api/seller/products/${parent.id}/delist`, {})).status).toBe(400);
    const res = await as(seller).post(`/api/seller/products/${parent.id}/delist`, { note: 'Discontinued' });
    expect(res.status).toBe(201);
    expect((await product(`${code}-BLU`)).status).toBe('ACTIVE');

    // Not someone else's to delist, or to see.
    expect((await as(otherSeller).post(`/api/seller/products/${parent.id}/delist`, { note: 'x' })).status).toBe(404);
    expect((await as(otherSeller).get(`/api/seller/submissions/${res.body.data.reference}`)).status).toBe(404);

    await as(reviewer).post(`/api/admin/submissions/${res.body.data.reference}/approve`);
    expect((await product(`${code}-BLU`)).status).toBe('ARCHIVED');
  });
});

describe('stock', () => {
  it('applies only to the seller’s own SKUs, and a drop to zero raises an alert', async () => {
    const code = `SP-${run}-S`;
    await liveProduct(code);
    const res = await as(seller).post('/api/seller/stock', {
      items: [{ sku: `${code}-BLU`, quantity: 0 }, { sku: 'NOT-MINE', quantity: 5 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      updated: [{ sku: `${code}-BLU`, from: 10, to: 0 }],
      errors: [{ sku: 'NOT-MINE', reason: 'Unknown SKU' }],
    });
    const theirs = await as(otherSeller).post('/api/seller/stock', { items: [{ sku: `${code}-WHI`, quantity: 1 }] });
    expect(theirs.body.data.errors).toEqual([{ sku: `${code}-WHI`, reason: 'Unknown SKU' }]);
    expect((await as(seller).post('/api/seller/stock', { items: [{ sku: `${code}-BLU`, quantity: -1 }] })).status).toBe(400);

    const alerts = await as(reviewer).get('/api/admin/seller-stock-alerts?days=1');
    expect(alerts.body.data).toContainEqual(expect.objectContaining({ sku: `${code}-BLU`, from: 10, to: 0 }));
  });
});

describe('access', () => {
  it('the portal is for sellers, the queue for catalog staff', async () => {
    expect((await as(customer).get('/api/seller/products')).status).toBe(403);
    expect((await as(reviewer).get('/api/seller/products')).status).toBe(403);
    expect((await as(seller).get('/api/admin/submissions')).status).toBe(403);
    expect((await request(app).get('/api/seller/products')).status).toBe(401);
    expect((await as(reviewer).get('/api/admin/submissions/counts')).body.data).toHaveProperty('SUBMITTED');
    expect((await as(reviewer).get('/api/admin/submissions/nope')).status).toBe(400);
  });
});
