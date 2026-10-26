import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * Storefront catalog (contract A1–A5): server-side search with facets, related
 * products, cart recommendations, suggestions and ratings. Everything is
 * scoped to a department created for this run (the database is shared).
 */
const { app, prisma, fixtures } = harness();

const run = randomUUID().slice(0, 8).toLowerCase();
const dept = `dept-${run}`;
const merchantId = randomUUID();
const ids: Record<string, { parentId: string; skuIds: string[] }> = {};

async function parent(
  key: string,
  data: { name: string; brand: string; type: string; section: string; attributes?: object; featured?: boolean; ratingAvg?: string; ratingCount?: number; createdAt?: Date },
  variants: { color?: string; size?: string; price: string; mrp?: string; stock: number; keywords?: string }[],
) {
  const p = await prisma.parentProduct.create({
    data: {
      code: `P-${run}-${key}`,
      name: data.name,
      brand: data.brand,
      productType: data.type,
      categoryId: deptId,
      subcategoryId: sections[data.section],
      attributes: data.attributes ?? {},
      featured: data.featured ?? false,
      ratingAvg: new Prisma.Decimal(data.ratingAvg ?? '0'),
      ratingCount: data.ratingCount ?? 0,
      merchantId,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
  const skuIds: string[] = [];
  for (const [i, v] of variants.entries()) {
    const sku = await prisma.product.create({
      data: {
        name: data.name,
        sku: `S-${run}-${key}-${i}`,
        price: new Prisma.Decimal(v.price),
        mrp: v.mrp ? new Prisma.Decimal(v.mrp) : null,
        stockQuantity: v.stock,
        status: 'ACTIVE',
        parentId: p.id,
        categoryId: deptId,
        merchantId,
        color: v.color ?? null,
        size: v.size ?? null,
        searchKeywords: v.keywords ?? null,
        urlSlug: `${key}-${run}-${i}`,
        version: 0n,
        images: { create: [{ url: `https://cdn.test.local/${run}/${key}-${i}.jpg`, position: 0, isPrimary: true }] },
      },
    });
    skuIds.push(sku.id);
  }
  ids[key] = { parentId: p.id, skuIds };
}

let deptId: string;
const sections: Record<string, string> = {};

beforeAll(async () => {
  deptId = (await fixtures.newCategory(`Dept ${run}`, dept)).id;
  for (const s of ['men', 'women']) {
    sections[s] = (await prisma.productCategory.create({ data: { name: s === 'men' ? 'Men' : 'Women', slug: `${dept}-${s}`, parentId: deptId } })).id;
  }
  const old = new Date(Date.now() - 90 * 86_400_000);
  await parent('tee', { name: `Crew Tee ${run}`, brand: 'Basix', type: 'T-shirts', section: 'men', attributes: { Fit: 'Regular', Material: 'Cotton' }, ratingAvg: '4.56', ratingCount: 9, createdAt: old }, [
    { color: 'Black', size: 'M', price: '15.00', mrp: '20.00', stock: 10, keywords: 'tshirt, crew' },
    { color: 'White', size: 'S', price: '15.00', stock: 0 },
  ]);
  await parent('jean', { name: `Slim Jeans ${run}`, brand: 'Denimco', type: 'Jeans', section: 'men', attributes: { Fit: 'Slim' }, createdAt: old }, [
    { color: 'Indigo', size: '32', price: '60.00', stock: 4 },
  ]);
  await parent('dress', { name: `Wrap Dress ${run}`, brand: 'Basix', type: 'Dresses', section: 'women', featured: true }, [
    { color: 'Red', size: 'M', price: '45.00', stock: 2 },
  ]);
  await parent('gone', { name: `Sold Out Tee ${run}`, brand: 'Basix', type: 'T-shirts', section: 'women', createdAt: old }, [
    { color: 'Black', size: 'L', price: '9.00', stock: 0 },
  ]);

  // Jeans sold 5 (paid), tee 1 (unpaid: not counted).
  const customer = await fixtures.newCustomer();
  for (const [key, status, quantity] of [['jean', 'PAID', 5], ['tee', 'PENDING_PAYMENT', 1]] as const) {
    await prisma.order.create({
      data: {
        userId: customer.id,
        orderNumber: `T${run}${key}`.slice(0, 40),
        status,
        currency: 'USD',
        subtotal: new Prisma.Decimal(10),
        taxTotal: new Prisma.Decimal(0),
        shippingTotal: new Prisma.Decimal(0),
        discountTotal: new Prisma.Decimal(0),
        grandTotal: new Prisma.Decimal(10),
        shipRecipientName: 'X',
        shipAddressLine1: '1 St',
        shipCity: 'C',
        shipState: 'OR',
        shipPostalCode: '97201',
        shipCountry: 'US',
        items: {
          create: [{
            productId: ids[key].skuIds[0], merchantId, productName: key, sku: 'x', unitPrice: new Prisma.Decimal(10),
            quantity, lineTotal: new Prisma.Decimal(10),
          }],
        },
      },
    });
  }
});

const searchApi = (query: string) => request(app).get(`/api/products/search?dept=${dept}&${query}`);

describe('GET /api/products/search', () => {
  it('lists one card per parent with prices, colours, stock, popularity and rating', async () => {
    const res = await searchApi('sort=pop');
    expect(res.status).toBe(200);
    const { items, total, search } = res.body.data;
    expect(total).toBe(4);
    expect(search).toBeNull();
    expect(items[0].parentId).toBe(ids.jean.parentId); // best seller first
    const tee = items.find((i: { parentId: string }) => i.parentId === ids.tee.parentId);
    expect(tee).toMatchObject({
      productId: ids.tee.skuIds[0], // first in-stock variant
      slug: `tee-${run}-0`,
      name: `Crew Tee ${run}`,
      brand: 'Basix',
      department: { slug: dept },
      section: { slug: `${dept}-men`, name: 'Men' },
      minPrice: 15,
      mrp: 20,
      discountPercent: 25,
      sizes: ['S', 'M'],
      stock: 10,
      unitsSold: 0,
      ratingAvg: 4.6,
      ratingCount: 9,
      variantCount: 2,
      isNew: false,
    });
    // Newest variant first, as the client grouped them.
    expect(tee.colors.map((c: { name: string }) => c.name)).toEqual(['White', 'Black']);
  });

  it('facets are disjunctive and filters combine', async () => {
    const res = await searchApi('brand=Basix&g=men');
    const { items, facets } = res.body.data;
    expect(items.map((i: { parentId: string }) => i.parentId)).toEqual([ids.tee.parentId]);
    // Brand counts ignore the brand selection but respect the section.
    expect(facets.brand).toEqual(
      expect.arrayContaining([{ value: 'Basix', label: 'Basix', count: 1 }, { value: 'Denimco', label: 'Denimco', count: 1 }]),
    );
    // Other departments in the shared database show up with 0 (dept is a facet too).
    expect(facets.g.filter((o: { value: string }) => o.value.startsWith(dept))).toEqual([
      { value: `${dept}-men`, label: 'Men', count: 1 },
      { value: `${dept}-women`, label: 'Women', count: 2 },
    ]);
    expect(facets.fit).toEqual(expect.arrayContaining([
      { value: 'Slim', label: 'Slim', count: 0 },
      { value: 'Regular', label: 'Regular', count: 1 },
    ]));
    expect(facets.price.map((p: { value: string }) => p.value)).toEqual(expect.arrayContaining(['u10', '10-25', '25-50', '50-100']));
  });

  it('repeatable values, toggles, price buckets and sorts', async () => {
    const both = await searchApi(`g=${dept}-men&g=${dept}-women&inStock=1&sort=asc`);
    expect(both.body.data.items.map((i: { parentId: string }) => i.parentId)).toEqual([
      ids.tee.parentId, ids.dress.parentId, ids.jean.parentId,
    ]);
    const sale = await searchApi('onSale=1');
    expect(sale.body.data.total).toBe(1);
    const bucket = await searchApi('price=25-50&price=50-100&sort=desc');
    expect(bucket.body.data.items.map((i: { parentId: string }) => i.parentId)).toEqual([ids.jean.parentId, ids.dress.parentId]);
    const fresh = await searchApi('new=1');
    expect(fresh.body.data.items.map((i: { parentId: string }) => i.parentId)).toEqual([ids.dress.parentId]);
    const rated = await searchApi('sort=rating&pageSize=1&page=0');
    expect(rated.body.data).toMatchObject({ total: 4, size: 1, page: 0 });
    expect(rated.body.data.items[0].parentId).toBe(ids.tee.parentId);
    const excl = await searchApi(`exclude=${ids.tee.parentId}&exclude=${ids.jean.skuIds[0]}`);
    expect(excl.body.data.total).toBe(2);
    expect((await searchApi('sort=nope')).status).toBe(400);
  });

  it('searches with AND matching, synonyms, SKUs and spelling correction', async () => {
    const tee = await searchApi(`q=${encodeURIComponent(`crew tee ${run}`)}`);
    expect(tee.body.data.search).toEqual({ mode: 'exact', query: `crew tee ${run}`, shown: `crew tee ${run}` });
    expect(tee.body.data.items.map((i: { parentId: string }) => i.parentId)).toEqual([ids.tee.parentId]);

    const sku = await searchApi(`q=S-${run}-jean-0`);
    expect(sku.body.data.items.map((i: { parentId: string }) => i.parentId)).toEqual([ids.jean.parentId]);

    const typo = await searchApi(`q=${encodeURIComponent(`denimko ${run}`)}`);
    expect(typo.body.data.search.mode).toBe('corrected');
    expect(typo.body.data.items.map((i: { parentId: string }) => i.parentId)).toEqual([ids.jean.parentId]);

    const strict = await searchApi(`q=${encodeURIComponent(`denimko ${run}`)}&exact=1`);
    expect(strict.body.data).toMatchObject({ total: 0, search: { mode: 'none', shown: null } });
  });
});

describe('related, recommendations, suggestions, ratings', () => {
  it('related: same section and type first, in stock, never itself', async () => {
    const res = await request(app).get(`/api/products/${ids.tee.skuIds[1]}/related?limit=24`);
    expect(res.status).toBe(200);
    const parents = res.body.data.map((c: { parentId: string }) => c.parentId);
    expect(parents[0]).toBe(ids.jean.parentId); // same section
    expect(parents).not.toContain(ids.tee.parentId);
    expect(parents).not.toContain(ids.gone.parentId); // out of stock
    expect((await request(app).get(`/api/products/${randomUUID()}/related`)).status).toBe(404);
  });

  it('recommendations: the cart department first, never the cart items', async () => {
    const res = await request(app).get(`/api/products/recommendations?exclude=${ids.tee.skuIds[0]}&limit=24`);
    expect(res.status).toBe(200);
    const parents = res.body.data.map((c: { parentId: string }) => c.parentId);
    expect(parents[0]).toBe(ids.jean.parentId);
    expect(parents).not.toContain(ids.tee.parentId);
  });

  it('suggest: completions, a scoped suggestion, products and popular searches', async () => {
    await request(app).post('/api/analytics/events').send({ events: [{ eventType: 'SEARCH', sessionId: 's-1', properties: { query: `wrap ${run}`, results: 1 } }] });
    const res = await request(app).get(`/api/search/suggest?q=${encodeURIComponent(`wrap dress ${run}`)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions[0]).toBe(`wrap dress ${run}`);
    expect(res.body.data.scoped).toMatchObject({ type: 'Dresses' });
    expect(res.body.data.products.map((c: { parentId: string }) => c.parentId)).toEqual([ids.dress.parentId]);
    const empty = await request(app).get('/api/search/suggest');
    expect(empty.body.data.suggestions).toEqual([]);
    expect(empty.body.data.popular.length).toBeGreaterThan(0);
  });

  it('product detail and summaries carry the rating', async () => {
    const detail = await request(app).get(`/api/products/${ids.tee.skuIds[0]}`);
    expect(detail.body.data).toMatchObject({ ratingAvg: 4.6, ratingCount: 9, ratingDistribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } });
    expect(detail.body.data.parent).toMatchObject({ ratingAvg: 4.6, ratingCount: 9 });
  });
});
