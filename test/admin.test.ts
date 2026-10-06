import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** The admin panel API (FR-AD-01/02/03, FR-IM-11) over HTTP. */
const { app, prisma, container, fixtures } = harness();

let admin: string;
let run: string;
let categoryId: string;
let parentId: string;
const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
});

beforeAll(async () => {
  admin = await fixtures.registerUser('ROLE_ADMIN');
  run = randomUUID().slice(0, 8).toUpperCase();
  const category = await fixtures.newCategory(`Admin ${run}`, `admin-${run.toLowerCase()}`);
  categoryId = category.id;
  const csv = [
    'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Product_Status,Color,Size,Selling_Price,Inventory_Qty,Image_1_URL',
    `A-${run}-BLK,P-${run},Tee ${run},Nexus,${category.slug},ACTIVE,Black,M,20,40,https://cdn.test.local/a.jpg`,
    `A-${run}-WHT,P-${run},Tee ${run},Nexus,${category.slug},DRAFT,White,M,25,3,https://cdn.test.local/b.jpg`,
    `B-${run},,Mug ${run},Acme,${category.slug},DRAFT,,,9.5,0,https://cdn.test.local/c.jpg`,
  ].join('\n');
  const report = await container.catalogImport.importFile(
    { originalname: 'admin.csv', buffer: Buffer.from(csv) },
    randomUUID(),
  );
  expect(report.errors).toEqual([]);
  parentId = (await prisma.parentProduct.findUniqueOrThrow({ where: { code: `P-${run}` } })).id;
});

describe('admin API', () => {
  it('is for admins only', async () => {
    const merchant = await fixtures.registerUser('ROLE_MERCHANT');
    expect((await as(merchant).get('/api/admin/products')).status).toBe(403);
    expect((await request(app).get('/api/admin/products')).status).toBe(401);
  });

  it('lists products with their variants, whatever the status or owner', async () => {
    const res = await as(admin).get(`/api/admin/products?categoryId=${categoryId}&sort=code`);
    expect(res.status).toBe(200);
    const [mug, tee] = res.body.data.content; // by code: B- before P-
    expect(tee).toMatchObject({
      code: `P-${run}`,
      brand: 'Nexus',
      variantCount: 2,
      minPrice: 20,
      maxPrice: 25,
      totalStock: 43,
      lowStockVariants: 1,
      status: 'MIXED',
      category: { id: categoryId },
    });
    expect(mug).toMatchObject({ code: `B-${run}`, status: 'DRAFT', totalStock: 0 });

    const drafts = await as(admin).get(`/api/admin/products?categoryId=${categoryId}&status=DRAFT`);
    expect(drafts.body.data.totalElements).toBe(2);
    const search = await as(admin).get(`/api/admin/products?search=a-${run.toLowerCase()}-wht`);
    expect(search.body.data.content.map((p: { code: string }) => p.code)).toEqual([`P-${run}`]);

    const counts = await as(admin).get(`/api/admin/products/status-counts?categoryId=${categoryId}`);
    expect(counts.body.data).toMatchObject({ ALL: 2, ACTIVE: 1, DRAFT: 2, INACTIVE: 0 });
  });

  it('bulk publishes and edits products and variants', async () => {
    const mugId = (await prisma.parentProduct.findUniqueOrThrow({ where: { code: `B-${run}` } })).id;
    const bulk = await as(admin).post('/api/admin/products/status', { parentIds: [parentId, mugId], status: 'ACTIVE' });
    expect(bulk.body.data).toEqual({ products: 2, variantsUpdated: 3, status: 'ACTIVE' });

    const edited = await as(admin).patch(`/api/admin/products/${parentId}`, { name: `Crew Tee ${run}`, status: 'INACTIVE' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ name: `Crew Tee ${run}`, status: 'INACTIVE' });
    expect(edited.body.data.variants.map((v: { sku: string }) => v.sku)).toEqual([`A-${run}-BLK`, `A-${run}-WHT`]);

    const variantId = edited.body.data.variants[0].id;
    const variant = await as(admin).patch(`/api/admin/variants/${variantId}`, { price: '22.50', status: 'ACTIVE' });
    expect(variant.body.data).toMatchObject({ price: 22.5, status: 'ACTIVE', productName: `Crew Tee ${run}` });

    const bad = await as(admin).post('/api/admin/products/status', { parentIds: [], status: 'LIVE' });
    expect(bad.status).toBe(400);
  });

  it('adjusts stock atomically and never below zero', async () => {
    const white = await prisma.product.findUniqueOrThrow({ where: { sku: `A-${run}-WHT` } });
    const up = await as(admin).post(`/api/admin/variants/${white.id}/stock-adjustments`, { delta: 7, reason: 'Stock received' });
    expect(up.body.data).toMatchObject({ stockQuantity: 10, stockStatus: 'IN_STOCK' });

    const tooMany = await as(admin).post(`/api/admin/variants/${white.id}/stock-adjustments`, { delta: -11 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.message).toBe("Only 10 in stock; can't remove 11");
    expect(await fixtures.stockOf(white.id)).toBe(10);

    const low = await as(admin).get(`/api/admin/inventory?categoryId=${categoryId}&stock=low`);
    expect(low.body.data.content.map((r: { sku: string }) => r.sku)).toEqual([`B-${run}`]);
    expect(low.body.data.content[0]).toMatchObject({ stockStatus: 'OUT_OF_STOCK', lowStockThreshold: 5 });

    const stats = await as(admin).get('/api/admin/inventory/stats');
    expect(stats.body.data.skus).toBeGreaterThanOrEqual(3);
  });

  it('lists every order with its customer', async () => {
    const user = await fixtures.newCustomer();
    const product = await fixtures.newActiveProduct(10, '12.00');
    await fixtures.addToCart(user.id, product.id, 3);
    const address = await fixtures.newAddress(user.id);
    const placed = await container.orders.checkout(user.id, { addressId: address.id }, null);

    const list = await as(admin).get(`/api/admin/orders?search=${placed.order.orderNumber}`);
    expect(list.body.data.content).toEqual([
      expect.objectContaining({
        orderNumber: placed.order.orderNumber,
        itemCount: 3,
        customer: expect.objectContaining({ email: user.email, city: 'Testville' }),
      }),
    ]);

    const detail = await as(admin).get(`/api/admin/orders/${placed.order.id}`);
    expect(detail.body.data).toMatchObject({ customer: { email: user.email, orders: 1 }, items: [{ quantity: 3 }] });

    const stats = await as(admin).get('/api/admin/orders/stats');
    expect(stats.body.data.total).toBeGreaterThanOrEqual(1);
    expect((await as(admin).get('/api/admin/orders?status=NOPE')).status).toBe(400);
  });
});
