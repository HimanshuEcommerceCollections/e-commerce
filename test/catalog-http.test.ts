import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * The import endpoint over HTTP (roles, multipart, error envelope), the variant
 * list on the PDP (FR-IM-02), and the JSON shapes the web client relies on.
 * (CatalogImportHttpIT + contract checks)
 */
const { app, fixtures } = harness();

const upload = (token: string, filename: string, content: string | Buffer) =>
  request(app)
    .post('/api/catalog/import')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(content), filename);

describe('catalog import over HTTP', () => {
  it('a merchant imports a file and the PDP lists only published variants publicly', async () => {
    const run = randomUUID().slice(0, 8).toUpperCase();
    const category = await fixtures.newCategory(`Home ${run}`, `home-${run.toLowerCase()}`);
    const merchant = await fixtures.registerUser('ROLE_MERCHANT');
    const parent = `GS-HK-${run}`;
    const p = `T-${run}`;
    const csv = [
      'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Product_Status,Variant_Name,Color,Selling_Price,Inventory_Qty,Image_1_URL',
      `${p}-RED,${parent},Mug,Nexus,${category.slug},ACTIVE,Red,Red,199,20,https://cdn.test.local/${p}-red.jpg`,
      `${p}-BLU,${parent},Mug,Nexus,${category.slug},DRAFT,Blue,Blue,199,20,https://cdn.test.local/${p}-blu.jpg`,
      `${p}-BAD,,Mug,Nexus,${category.slug},ACTIVE,,,abc,20,https://cdn.test.local/${p}-bad.jpg`,
    ].join('\n');

    const res = await upload(merchant, 'catalog.csv', csv);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Imported 2 of 3 rows');
    expect(res.body.data.parentProductsCreated).toBe(1);
    expect(res.body.data.errors).toEqual([{ row: 4, sku: `${p}-BAD`, reason: "Selling_Price 'abc' is not a number" }]);

    const page = (await request(app).get(`/api/products/category/${category.id}`)).body.data;
    const summary = page.content[0];
    expect(summary).toMatchObject({ parentCode: parent, brand: 'Nexus', sku: `${p}-RED` });

    const detail = (await request(app).get(`/api/products/${summary.id}`)).body.data;
    expect(detail.parent.code).toBe(parent);
    expect(detail.color).toBe('Red');
    expect(detail.variants).toHaveLength(1);

    // The owner sees the draft variant too.
    const owner = await request(app).get(`/api/products/${summary.id}`).set('Authorization', `Bearer ${merchant}`);
    expect(owner.body.data.variants).toHaveLength(2);
  });

  it('customers cannot import', async () => {
    const customer = await fixtures.registerUser();
    const res = await upload(customer, 'catalog.csv', 'SKU_ID\n');
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('bad uploads are 4xx in the API envelope', async () => {
    const merchant = await fixtures.registerUser('ROLE_MERCHANT');

    const wrongColumns = await upload(merchant, 'catalog.csv', 'SKU_ID\nA\n');
    expect(wrongColumns.status).toBe(400);
    expect(wrongColumns.body.message).toContain('Missing required columns');

    const noFile = await request(app)
      .post('/api/catalog/import')
      .set('Authorization', `Bearer ${merchant}`)
      .field('other', 'x');
    expect(noFile.status).toBe(400);
    expect(noFile.body.success).toBe(false);

    const json = await request(app).post('/api/catalog/import').set('Authorization', `Bearer ${merchant}`).send({});
    expect(json.status).toBe(415);
  });

  it('the template downloads as CSV', async () => {
    const merchant = await fixtures.registerUser('ROLE_MERCHANT');
    const res = await request(app).get('/api/catalog/import/template').set('Authorization', `Bearer ${merchant}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toContain('catalog-import-template.csv');
    expect(res.text.startsWith('SKU_ID,Parent_Product_ID,Product_Name')).toBe(true);
  });
});

describe('products API contract', () => {
  it('create, update and page JSON match the Java server', async () => {
    const run = randomUUID().slice(0, 8);
    const merchant = await fixtures.registerUser('ROLE_MERCHANT');
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

    const cat = await request(app).post('/api/categories').set(auth(admin)).send({ name: 'Toys', slug: `toys-${run}` });
    expect(cat.status).toBe(201);
    expect(cat.body.message).toBe('Category created successfully');

    const created = await request(app)
      .post('/api/products')
      .set(auth(merchant))
      .send({
        name: 'Robot',
        price: 1299,
        stockQuantity: 5,
        sku: `ROBOT-${run}-RED`,
        categoryId: cat.body.data.id,
        parentProductCode: `ROBOT-${run}`,
        brand: 'Botco',
        color: 'Red',
        images: [{ url: 'https://cdn.test.local/r1.jpg' }, { url: 'https://cdn.test.local/r2.jpg', primary: true }],
      });
    expect(created.status).toBe(201);
    // Money keeps two decimals, as Jackson wrote BigDecimal(12,2).
    expect(created.text).toContain('"price":1299.00');
    const product = created.body.data;
    expect(product).toMatchObject({ status: 'DRAFT', parent: { code: `ROBOT-${run}`, brand: 'Botco' } });
    expect(product.images.map((i: { primary: boolean }) => i.primary)).toEqual([false, true]);

    // A second variant under the same parent.
    const blue = await request(app)
      .post('/api/products')
      .set(auth(merchant))
      .send({ name: 'Robot', price: '1299.00', stockQuantity: 1, sku: `ROBOT-${run}-BLU`, parentProductCode: `ROBOT-${run}`, color: 'Blue' });
    expect(blue.status).toBe(201);
    expect(blue.body.data.category.id).toBe(cat.body.data.id); // inherited from the parent
    expect(blue.body.data.variants).toHaveLength(2);

    const updated = await request(app)
      .put(`/api/products/${product.id}`)
      .set(auth(merchant))
      .send({ status: 'ACTIVE', price: 999.5 });
    expect(updated.status).toBe(200);
    expect(updated.text).toContain('"price":999.50');

    const page = await request(app).get('/api/products?size=1&sort=createdAt,desc');
    expect(page.body.data).toMatchObject({
      size: 1,
      number: 0,
      first: true,
      numberOfElements: 1,
      pageable: { pageNumber: 0, pageSize: 1, paged: true },
      sort: { sorted: true },
    });

    const invalid = await request(app).post('/api/products').set(auth(merchant)).send({ price: -1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.data).toMatchObject({
      name: 'must not be blank',
      price: 'must be greater than 0',
      stockQuantity: 'must not be null',
      sku: 'must not be blank',
    });

    const dupe = await request(app)
      .post('/api/products')
      .set(auth(merchant))
      .send({ name: 'Robot', price: 1, stockQuantity: 1, sku: `ROBOT-${run}-RED` });
    expect(dupe.status).toBe(409);
    expect(dupe.body.message).toBe(`A product with SKU 'ROBOT-${run}-RED' already exists`);
  });
});
