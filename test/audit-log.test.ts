import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * Catalog audit log: catalog, seller and integration changes are recorded
 * after they commit, with who, where from and the previous value; the admin
 * API filters, pages and exports them; rows can't be changed or removed.
 */
const { app, prisma, container, fixtures } = harness();

let admin: string;
let catalog: string;
let seller: string;
let sellerId: string;
let customer: string;
let run: string;
let menId: string;

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
  upload: (url: string, name: string, text: string) =>
    request(app).post(url).set('Authorization', `Bearer ${token}`).attach('file', Buffer.from(text), name),
});

const HEADER = 'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Subcategory,Product_Status,Color,Size,Selling_Price,Inventory_Qty,Image_1_URL';
const row = (code: string, o: { price?: string; qty?: string } = {}) =>
  [`${code}-BLU`, code, `Audit Shirt ${code}`, 'Northfold', 'clothing', 'Men', 'ACTIVE', 'Blue', 'M', o.price ?? '40.00', o.qty ?? '10', `https://cdn.test.local/${code}.jpg`].join(',');

type Ev = { eventId: string; action: string; category: string; before: string; after: string; alert: string | null; actor: { type: string; email: string }; entity: { code: string }; seller: { id: string } | null };
const events = async (query: string) => {
  const res = await as(catalog).get(`/api/admin/audit-events?size=200&${query}`);
  expect(res.status).toBe(200);
  return res.body.data.content as Ev[];
};

beforeAll(async () => {
  admin = await fixtures.registerUser('ROLE_ADMIN');
  catalog = await fixtures.registerUser('ROLE_CATALOG');
  seller = await fixtures.registerUser('ROLE_MERCHANT');
  customer = await fixtures.registerUser('ROLE_CUSTOMER');
  sellerId = (await as(seller).get('/api/users/me')).body.data.id;
  run = randomUUID().slice(0, 8).toUpperCase();
  menId = (await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing-men' } })).id;
});

describe('admin catalog actions', () => {
  it('records create, price, stock, status and delete with before and after', async () => {
    const created = await as(catalog).post('/api/admin/products', {
      name: `Audit Jacket ${run}`,
      subcategoryId: menId,
      status: 'DRAFT',
      variants: [{ color: 'Olive', size: 'M', price: 100, stockQuantity: 10, imageUrls: ['https://cdn.test.local/a.jpg'] }],
    });
    expect(created.status).toBe(201);
    const product = created.body.data;
    const variant = product.variants[0];

    await as(catalog).patch(`/api/admin/variants/${variant.id}`, { price: 80 });
    await as(catalog).post(`/api/admin/variants/${variant.id}/stock-adjustments`, { delta: -10, reason: 'Damaged' });
    await as(catalog).post('/api/admin/products/status', { parentIds: [product.id], status: 'ACTIVE' });
    await as(catalog).patch(`/api/admin/products/${product.id}`, { brand: 'Northfold' });

    const mine = await events(`q=${encodeURIComponent(run)}`);
    const byAction = (a: string) => mine.filter((e) => e.action === a);
    expect(byAction('product.created')[0]).toMatchObject({ category: 'product', before: '—', after: 'DRAFT', actor: { type: 'team' } });
    expect(byAction('price.changed')[0]).toMatchObject({ category: 'price', before: '$100.00', after: '$80.00', entity: { code: variant.sku } });
    expect(byAction('stock.adjusted')[0]).toMatchObject({ category: 'stock', before: '10', after: '0', alert: 'Dropped to zero' });
    expect(byAction('product.status_changed')[0]).toMatchObject({ category: 'status', before: 'DRAFT', after: 'ACTIVE' });
    expect(byAction('product.updated')[0]).toMatchObject({ before: 'Brand: —', after: 'Brand: Northfold' });

    await as(catalog).post('/api/admin/products/delete', { parentIds: [product.id] });
    const deleted = await events(`entityType=product&entityId=${product.id}`);
    expect(deleted[0]).toMatchObject({ action: 'product.deleted', after: 'Deleted' });

    // Newest first, and filters narrow it down.
    const prices = await events(`category=price&q=${encodeURIComponent(variant.sku)}`);
    expect(prices.map((e) => e.action)).toEqual(['price.changed']);
    const alerts = await events(`alerts=true&q=${encodeURIComponent(variant.sku)}`);
    expect(alerts.map((e) => e.action)).toEqual(['stock.adjusted']);
  });

  it('records catalog imports', async () => {
    const res = await as(catalog).upload('/api/catalog/import', `audit-${run}.csv`, [HEADER, row(`AI-${run}`)].join('\n'));
    expect(res.status).toBe(200);
    const [e] = await events(`category=import&q=${encodeURIComponent(`audit-${run}`)}`);
    expect(e).toMatchObject({ action: 'catalog.imported', actor: { type: 'team' } });
  });
});

describe('seller and review actions', () => {
  it('records submissions, decisions and seller stock with alerts', async () => {
    const code = `AS-${run}`;
    const up = await as(seller).upload('/api/seller/submissions', 'audit.csv', [HEADER, row(code)].join('\n'));
    const ref = up.body.data.submissions[0].reference;
    await as(catalog).post(`/api/admin/submissions/${ref}/approve`, { note: 'Fine' });

    const flow = await events(`q=${ref}`);
    expect(flow.map((e) => e.action)).toEqual(['submission.approved', 'product.submitted']);
    expect(flow[1]).toMatchObject({ category: 'submit', actor: { type: 'seller' }, seller: { id: sellerId } });
    expect(flow[0]).toMatchObject({ category: 'decision', after: 'Approved', actor: { type: 'team' } });

    // A price edit is a pending price event; approving it is a price change.
    const edit = await as(seller).upload('/api/seller/submissions', 'edit.csv', [HEADER, row(code, { price: '20.00' })].join('\n'));
    const editRef = edit.body.data.submissions[0].reference;
    await as(catalog).post(`/api/admin/submissions/${editRef}/approve`);
    const prices = await events(`category=price&entityCode=${code}-BLU`);
    expect(prices.map((e) => [e.action, e.before, e.after])).toEqual([
      ['price.changed', '$40.00', '$20.00'],
      ['price.change_requested', '$40.00', '$20.00 (pending)'],
    ]);

    await as(seller).post('/api/seller/stock', { items: [{ sku: `${code}-BLU`, quantity: 1 }] });
    const [stock] = await events(`category=stock&sellerId=${sellerId}&actorType=seller`);
    expect(stock).toMatchObject({ before: '10', after: '1', alert: 'Fell 90% in one update', entity: { code: `${code}-BLU` } });
    expect((await as(catalog).get('/api/admin/audit-events/stats')).body.data).toMatchObject({
      last24h: { events: expect.any(Number) },
      sellers: expect.arrayContaining([expect.objectContaining({ id: sellerId })]),
    });
  });
});

describe('integrations', () => {
  it('records changes without secret values', async () => {
    const res = await as(admin).post('/api/admin/integrations', {
      provider: 'CUSTOM',
      name: `Audit Vendor ${run}`,
      baseUrl: 'https://vendor.test.local/api',
      secrets: { API_KEY: 'sk_live_supersecret_1234' },
    });
    expect(res.status).toBe(201);
    const slug = res.body.data.slug;
    await as(admin).patch(`/api/admin/integrations/${slug}`, { enabled: false });
    await as(admin).delete(`/api/admin/integrations/${slug}`);
    const list = await events(`category=integration&q=${slug}`);
    expect(list.map((e) => e.action)).toEqual(['integration.removed', 'integration.updated', 'integration.created']);
    expect(list[1]).toMatchObject({ before: 'enabled: true', after: 'enabled: false' });
    expect(JSON.stringify(list)).not.toContain('supersecret');
  });
});

describe('reading, export and integrity', () => {
  it('gets one event by number or id, exports CSV, and guards access', async () => {
    const [first] = await events(`q=${encodeURIComponent(run)}`);
    const byNumber = await as(catalog).get(`/api/admin/audit-events/${first.eventId}`);
    expect(byNumber.status).toBe(200);
    expect((await as(catalog).get(`/api/admin/audit-events/${byNumber.body.data.id}`)).body.data.eventId).toBe(first.eventId);
    expect((await as(catalog).get('/api/admin/audit-events/EV-999999999')).status).toBe(404);

    const csv = await as(catalog).get(`/api/admin/audit-events/export?q=${encodeURIComponent(run)}&days=1`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split(/\r?\n/);
    expect(lines[0]).toContain('event_id,time,action');
    expect(lines.length).toBeGreaterThan(5);
    expect(csv.text).toContain(first.eventId);

    expect((await as(catalog).get('/api/admin/audit-events?category=nope')).status).toBe(400);
    expect((await as(catalog).get('/api/admin/audit-events?from=yesterday')).status).toBe(400);
    expect((await as(seller).get('/api/admin/audit-events')).status).toBe(403);
    expect((await as(customer).get('/api/admin/audit-events')).status).toBe(403);
    expect((await request(app).get('/api/admin/audit-events')).status).toBe(401);
  });

  it('date range filters', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await events(`from=${tomorrow}&q=${encodeURIComponent(run)}`)).toEqual([]);
    expect((await events(`to=${tomorrow}&q=${encodeURIComponent(run)}`)).length).toBeGreaterThan(0);
  });

  it('rows are append-only, and a failed write never throws', async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE audit_events SET summary = 'x' WHERE summary LIKE '%${run}%'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE summary LIKE '%${run}%'`)).rejects.toThrow(/append-only/);
    await expect(
      container.audit.record({
        action: 'x'.repeat(10),
        category: 'stock',
        actor: { id: 'not-a-uuid', name: 'x', role: 'ROLE_ADMIN', email: 'x' },
        source: 'test',
        entity: { type: 'variant' },
        summary: 'bad',
      }),
    ).resolves.toBeUndefined();
  });
});
