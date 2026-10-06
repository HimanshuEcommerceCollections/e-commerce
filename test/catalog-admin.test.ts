import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_COLUMNS } from '../src/product/importer/columns';
import { harness } from './support/harness';

/** Admin catalog API over HTTP (FR-AD-01/03/05, FR-IM-10/11, NFR-06) and the catalog role (FR-AD-08). */
const { app, prisma, fixtures } = harness();

let catalog: string;
let customer: string;
let merchant: string;
let run: string;
let menId: string;
let womenId: string;

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body?: object) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  upload: (url: string, name: string, text: string) =>
    request(app).post(url).set('Authorization', `Bearer ${token}`).attach('file', Buffer.from(text), name),
});

beforeAll(async () => {
  catalog = await fixtures.registerUser('ROLE_CATALOG');
  customer = await fixtures.registerUser('ROLE_CUSTOMER');
  merchant = await fixtures.registerUser('ROLE_MERCHANT');
  run = randomUUID().slice(0, 8).toUpperCase();
  menId = (await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing-men' } })).id;
  womenId = (await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing-women' } })).id;
});

const newProduct = (over: object = {}) => ({
  name: `Field Jacket ${run}`,
  brand: 'Northfold',
  subcategoryId: menId,
  productType: 'Jackets',
  shortDescription: 'Waxed cotton field jacket',
  status: 'DRAFT',
  featured: true,
  variants: [
    { color: 'Olive', size: 'M', price: 120, mrp: 150, taxRate: 8.25, stockQuantity: 12, imageUrls: ['https://cdn.test.local/j-1.jpg'] },
    { color: 'Black', size: 'L', price: 120, stockQuantity: 2, lowStockThreshold: 3, imageUrls: ['https://cdn.test.local/j-2.jpg'] },
  ],
  ...over,
});

describe('catalog role and files over HTTP', () => {
  it('catalog staff import, update and export the catalog, but get 403 on orders (FR-AD-08)', async () => {
    const csv = [
      'SKU_ID,Parent_Product_ID,Product_Name,Category,Subcategory,Product_Status,Color,Size,Selling_Price,Inventory_Qty,Image_1_URL,Fit',
      `H-${run}-1,H-${run},Chino ${run},clothing,Men,ACTIVE,Khaki,32,45,10,https://cdn.test.local/h1.jpg,Slim`,
      `H-${run}-2,H-${run},Chino ${run},clothing,Men,ACTIVE,Navy,32,45,4,https://cdn.test.local/h2.jpg,Slim`,
    ].join('\n');
    const imported = await as(catalog).upload('/api/catalog/import', 'chinos.csv', csv);
    expect(imported.status).toBe(200);
    expect(imported.body.data).toMatchObject({ importedRows: 2, createdRows: 2, ignoredColumns: [], imagesChecked: false });

    // Staff imports may update any SKU: re-import as another catalog user.
    const other = await fixtures.registerUser('ROLE_CATALOG');
    const again = await as(other).upload('/api/catalog/import', 'chinos.csv', csv);
    expect(again.body.data).toMatchObject({ updatedRows: 2, errors: [] });

    const updated = await as(catalog).upload('/api/catalog/updates', 'stock.csv', `SKU_ID,Inventory_Qty\nH-${run}-1,8\n`);
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ updatedRows: 1, columns: ['Inventory_Qty'] });

    const exported = await as(catalog).get('/api/catalog/export?format=csv');
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toMatch(/attachment; filename="catalog-.*\.csv"/);
    expect(exported.text).toContain(`H-${run}-1`);
    expect((await as(catalog).get('/api/catalog/export?format=pdf')).status).toBe(400);
    const xlsx = await as(catalog).get('/api/catalog/export?format=xlsx');
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');

    const template = await as(catalog).get('/api/catalog/import/template');
    const header = template.text.split(/\r?\n/)[0];
    for (const column of ALL_COLUMNS) expect(header).toContain(column.header);

    expect((await as(catalog).get('/api/admin/orders')).status).toBe(403);
    expect((await as(customer).get('/api/catalog/export')).status).toBe(403);
    expect((await as(merchant).upload('/api/catalog/updates', 'x.csv', 'SKU_ID,MRP\nA,1\n')).status).toBe(403);
    expect((await request(app).get('/api/catalog/export')).status).toBe(401);
  });
});

describe('admin products', () => {
  let parentId: string;
  let olive: { id: string; sku: string; urlSlug: string };
  let black: { id: string; sku: string };

  it('adds a product with generated SKUs (FR-AD-01)', async () => {
    const res = await as(catalog).post('/api/admin/products', newProduct());
    expect(res.status).toBe(201);
    const p = res.body.data;
    parentId = p.id;
    expect(p).toMatchObject({
      name: `Field Jacket ${run}`,
      brand: 'Northfold',
      category: { name: 'Clothing' },
      subcategory: { id: menId, name: 'Men' },
      productType: 'Jackets',
      featured: true,
      status: 'DRAFT',
      variantCount: 2,
      brokenImages: 0,
      shortDescription: 'Waxed cotton field jacket',
    });
    expect(p.code).toMatch(/^GS-CL-MEN-\d{3}$/);
    [black, olive] = p.variants; // by SKU
    expect(olive).toMatchObject({
      sku: `${p.code}-OLV-M`,
      variantName: 'Olive / M',
      price: 120,
      mrp: 150,
      taxRate: 8.25,
      stockQuantity: 12,
      lowStockThreshold: 5,
      ownLowStockThreshold: null,
      stockStatus: 'IN_STOCK',
      urlSlug: `field-jacket-${run.toLowerCase()}-olive-m`,
      images: [{ url: 'https://cdn.test.local/j-1.jpg', checkStatus: null, checkError: null }],
    });
    expect(black).toMatchObject({ sku: `${p.code}-BLK-L`, lowStockThreshold: 3, ownLowStockThreshold: 3, stockStatus: 'LOW_STOCK' });

    const movements = await as(catalog).get(`/api/admin/variants/${olive.id}/stock-movements`);
    expect(movements.body.data.content).toMatchObject([{ delta: 12, quantityAfter: 12, source: 'IMPORT' }]);

    // A second product of the same name is a new product, not a merge.
    const twin = await as(catalog).post('/api/admin/products', newProduct());
    expect(twin.status).toBe(201);
    expect(twin.body.data.id).not.toBe(parentId);
  });

  it('rejects invalid products without creating anything', async () => {
    const before = await prisma.parentProduct.count();
    const mrpBelow = await as(catalog).post(
      '/api/admin/products',
      newProduct({
        name: `Broken ${run}`,
        variants: [
          { color: 'Red', price: 10, stockQuantity: 1, imageUrls: ['https://cdn.test.local/r.jpg'] },
          { color: 'Blue', price: 10, mrp: 5, stockQuantity: 1, imageUrls: ['https://cdn.test.local/b.jpg'] },
        ],
      }),
    );
    expect(mrpBelow.status).toBe(400);
    expect(mrpBelow.body.data).toEqual({ 'variants[1]': 'MRP must not be less than Selling_Price' });

    const department = await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing' } });
    const notSection = await as(catalog).post('/api/admin/products', newProduct({ subcategoryId: department.id }));
    expect(notSection.status).toBe(400);
    const noImages = await as(catalog).post('/api/admin/products', newProduct({ variants: [{ price: 1, stockQuantity: 1, imageUrls: [] }] }));
    expect(noImages.status).toBe(400);
    expect(noImages.body.data['variants[0].imageUrls']).toBe('must have at least one image URL');
    expect(await prisma.parentProduct.count()).toBe(before);
  });

  it('lists and filters products by section', async () => {
    const res = await as(catalog).get(`/api/admin/products?subcategoryId=${menId}&search=${encodeURIComponent(`Field Jacket ${run}`)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalElements).toBe(2);
    expect(res.body.data.content[0]).toMatchObject({
      subcategory: { id: menId },
      featured: true,
      brokenImages: 0,
      productType: 'Jackets',
      lowStockVariants: 1,
    });
  });

  it('edits the product and its variants (FR-AD-01, FR-AD-05)', async () => {
    const edited = await as(catalog).patch(`/api/admin/products/${parentId}`, {
      productType: 'Coats',
      featured: false,
      subcategoryId: womenId,
      description: 'Long description',
      keyFeatures: ['Waxed cotton', 'Corduroy collar'],
      brand: '',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      productType: 'Coats',
      featured: false,
      subcategory: { id: womenId },
      description: 'Long description',
      keyFeatures: ['Waxed cotton', 'Corduroy collar'],
      brand: null,
    });

    const variant = await as(catalog).patch(`/api/admin/variants/${olive.id}`, {
      price: 99.5,
      mrp: 0,
      cost: 40,
      taxCode: 'CL-RED',
      taxRate: 5,
      lowStockThreshold: 20,
      urlSlug: `field-jacket-${run.toLowerCase()}`,
      seoTitle: 'Field jacket',
      metaDescription: 'A waxed field jacket',
      stockQuantity: 15,
    });
    expect(variant.status).toBe(200);
    expect(variant.body.data).toMatchObject({
      price: 99.5,
      mrp: null,
      taxRate: 5,
      stockQuantity: 15,
      lowStockThreshold: 20,
      ownLowStockThreshold: 20,
      stockStatus: 'LOW_STOCK',
    });
    const detail = (await as(catalog).get(`/api/admin/products/${parentId}`)).body.data;
    const v = detail.variants.find((x: { id: string }) => x.id === olive.id);
    expect(v).toMatchObject({ cost: 40, taxCode: 'CL-RED', urlSlug: `field-jacket-${run.toLowerCase()}`, seoTitle: 'Field jacket' });

    const cleared = await as(catalog).patch(`/api/admin/variants/${olive.id}`, { clearLowStockThreshold: true });
    expect(cleared.body.data).toMatchObject({ lowStockThreshold: 5, ownLowStockThreshold: null, stockStatus: 'IN_STOCK' });

    const taken = await as(catalog).patch(`/api/admin/variants/${black.id}`, { urlSlug: `field-jacket-${run.toLowerCase()}` });
    expect(taken.status).toBe(409);
    const below = await as(catalog).patch(`/api/admin/variants/${black.id}`, { mrp: 50 });
    expect(below.status).toBe(400);
    expect((await as(catalog).patch(`/api/admin/variants/${black.id}`, { taxRate: 101 })).status).toBe(400);
  });

  it('logs stock adjustments and uses per-SKU thresholds in inventory (FR-AD-03)', async () => {
    const adjusted = await as(catalog).post(`/api/admin/variants/${black.id}/stock-adjustments`, { delta: 4, reason: 'Cycle count' });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.data).toMatchObject({ stockQuantity: 6, lowStockThreshold: 3, stockStatus: 'IN_STOCK' });
    expect((await as(catalog).post(`/api/admin/variants/${black.id}/stock-adjustments`, { delta: -7 })).status).toBe(409);

    const movements = await as(catalog).get(`/api/admin/variants/${black.id}/stock-movements`);
    expect(movements.body.data.content[0]).toMatchObject({ delta: 4, quantityAfter: 6, source: 'ADJUSTMENT', reason: 'Cycle count' });
    expect(movements.body.data.content[0].actor).toMatch(/@test\.local$/);
    const olives = await as(catalog).get(`/api/admin/variants/${olive.id}/stock-movements`);
    expect(olives.body.data.content.map((m: { delta: number; source: string }) => [m.delta, m.source])).toEqual([
      [3, 'ADJUSTMENT'],
      [12, 'IMPORT'],
    ]);

    await as(catalog).patch(`/api/admin/variants/${black.id}`, { lowStockThreshold: 6 });
    const low = await as(catalog).get(`/api/admin/inventory?stock=low&search=${encodeURIComponent(black.sku)}`);
    expect(low.body.data.content).toEqual([
      expect.objectContaining({ sku: black.sku, stockStatus: 'LOW_STOCK', lowStockThreshold: 6, ownLowStockThreshold: 6, warehouseId: null }),
    ]);
    const stats = await as(catalog).get('/api/admin/inventory/stats');
    expect(stats.body.data).toMatchObject({ lowStockThreshold: 5 });
    expect(stats.body.data.lowStock).toBeGreaterThanOrEqual(1);
  });

  it('lists image issues and reports checks switched off', async () => {
    const issues = await as(catalog).get('/api/admin/images/issues?size=5');
    expect(issues.status).toBe(200);
    expect(issues.body.data).toMatchObject({ number: 0, size: 5 });
    expect(issues.body.data.uncheckedImages).toBeGreaterThan(0);
    const recheck = await as(catalog).post('/api/admin/images/recheck?scope=problems');
    expect(recheck.body.data).toEqual({ checked: 0, broken: 0, enabled: false });
    expect((await as(catalog).post('/api/admin/images/recheck?scope=some')).status).toBe(400);
  });
});
