import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeOrderNumber, ORDER_NUMBER_PATTERN } from '../src/order/order-number';
import { harness } from './support/harness';

/**
 * Storefront read API (CONTRACT §4): the seeded taxonomy and its tree, PLP
 * summaries, the PDP by id and by slug, the store config, catalog-staff
 * access (FR-AD-08) and the EC- order number format.
 */
const { app, prisma, container, fixtures } = harness();

const run = randomUUID().slice(0, 8).toLowerCase();
const productType = `Tees ${run}`;
let parentId: string;
let blackM: { id: string; urlSlug: string };
let whiteS: { id: string };

beforeAll(async () => {
  const men = await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing-men' } });
  const merchantId = randomUUID();
  const parent = await prisma.parentProduct.create({
    data: {
      code: `GS-CL-MEN-${run}`,
      name: `Crew Tee ${run}`,
      brand: 'Basix',
      shortDescription: 'A soft everyday tee.',
      categoryId: men.parentId,
      subcategoryId: men.id,
      productType,
      keyFeatures: '- 100% cotton\n- Pre-shrunk\n\n',
      warranty: '30-day fit guarantee',
      attributes: { Fit: 'Regular', Material: 'Cotton', Occasion: ['Everyday', 'Travel'] },
      featured: true,
      merchantId,
    },
  });
  parentId = parent.id;
  const variant = (color: string, size: string, extra: Partial<Prisma.ProductUncheckedCreateInput>) =>
    prisma.product.create({
      data: {
        name: `Crew Tee ${run}`,
        sku: `GS-CL-MEN-${run}-${color.slice(0, 3).toUpperCase()}-${size}`,
        price: new Prisma.Decimal('15.00'),
        stockQuantity: 10,
        status: 'ACTIVE',
        categoryId: men.parentId,
        parentId: parent.id,
        merchantId,
        color,
        size,
        variantName: `${color} / ${size}`,
        version: 0n,
        ...extra,
        images: {
          create: [
            { url: `https://cdn.test.local/${run}-${color}-2.jpg`, position: 1, isPrimary: false },
            { url: `https://cdn.test.local/${run}-${color}-1.jpg`, position: 0, isPrimary: true },
          ],
        },
      },
    });
  const b = await variant('Black', 'M', {
    mrp: new Prisma.Decimal('20.00'),
    taxRate: new Prisma.Decimal('8.00'),
    urlSlug: `crew-tee-${run}`,
    seoTitle: null,
    searchKeywords: 'tee, t-shirt',
  });
  blackM = { id: b.id, urlSlug: b.urlSlug! };
  whiteS = await variant('White', 'S', { urlSlug: `crew-tee-${run}-white-s` });
  await variant('Grey', 'L', { status: 'DRAFT' });

  // Three units sold on a paid order, one on an unpaid one (not counted).
  const customer = await fixtures.newCustomer();
  for (const [status, quantity] of [['PAID', 3], ['PENDING_PAYMENT', 1]] as const) {
    await prisma.order.create({
      data: {
        userId: customer.id,
        orderNumber: `T-${randomUUID()}`,
        status,
        currency: 'USD',
        subtotal: new Prisma.Decimal(15 * quantity),
        taxTotal: new Prisma.Decimal(0),
        shippingTotal: new Prisma.Decimal(0),
        discountTotal: new Prisma.Decimal(0),
        grandTotal: new Prisma.Decimal(15 * quantity),
        shipRecipientName: 'Test',
        shipAddressLine1: '1 Test St',
        shipCity: 'Testville',
        shipState: 'TS',
        shipPostalCode: '12345',
        shipCountry: 'US',
        items: {
          create: {
            productId: b.id,
            merchantId,
            productName: b.name,
            sku: b.sku,
            unitPrice: b.price,
            quantity,
            lineTotal: b.price.mul(quantity),
          },
        },
      },
    });
  }
});

describe('taxonomy', () => {
  it('the migration seeds 9 departments with their sections, codes and positions', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    const clothing = res.body.data.find((c: { slug: string }) => c.slug === 'clothing');
    expect(clothing).toMatchObject({ name: 'Clothing', parentId: null, position: 0, code: 'CL' });
    const men = res.body.data.find((c: { slug: string }) => c.slug === 'clothing-men');
    expect(men).toMatchObject({ name: 'Men', parentId: clothing.id, position: 1, code: 'MEN' });
  });

  it('the tree nests sections under departments with live counts and product types', async () => {
    const res = await request(app).get('/api/categories/tree');
    expect(res.status).toBe(200);
    const seeded = res.body.data.filter((d: { code: string | null }) =>
      ['CL', 'EL', 'HK', 'GR', 'BP', 'BS', 'TK', 'SF', 'LS'].includes(d.code ?? ''),
    );
    expect(seeded.map((d: { slug: string }) => d.slug)).toEqual([
      'clothing', 'electronics', 'home-kitchen', 'grocery', 'beauty',
      'books-stationery', 'toys-kids', 'sports-fitness', 'lifestyle',
    ]);
    const clothing = seeded[0];
    expect(clothing.subcategories.map((s: { slug: string }) => s.slug)).toEqual(['clothing-women', 'clothing-men']);
    expect(clothing.productCount).toBeGreaterThanOrEqual(1);
    const men = clothing.subcategories[1];
    expect(men.productTypes).toContainEqual({ name: productType, productCount: 1 });
  });

  it('a catalog user can create a section; a customer cannot', async () => {
    const catalog = await fixtures.registerUser('ROLE_CATALOG');
    const dept = (await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'lifestyle' } })).id;
    const res = await request(app)
      .post('/api/categories')
      .set('Authorization', `Bearer ${catalog}`)
      .send({ name: 'Pets', slug: `pets-${run}`, parentId: dept, position: 5, code: 'pet' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ parentId: dept, position: 5, code: 'PET' });

    const customer = await fixtures.registerUser();
    const denied = await request(app)
      .post('/api/categories')
      .set('Authorization', `Bearer ${customer}`)
      .send({ name: 'X', slug: `x-${run}` });
    expect(denied.status).toBe(403);
  });
});

describe('products', () => {
  it('PLP summaries carry taxonomy, attributes, images, MRP and units sold', async () => {
    const res = await request(app).get('/api/products?size=2000');
    expect(res.status).toBe(200);
    const row = res.body.data.content.find((p: { id: string }) => p.id === blackM.id);
    expect(row).toMatchObject({
      price: 15,
      mrp: 20,
      discountPercent: 25,
      categorySlug: 'clothing',
      categoryName: 'Clothing',
      subcategorySlug: 'clothing-men',
      subcategoryName: 'Men',
      productType,
      parentId,
      parentName: `Crew Tee ${run}`,
      brand: 'Basix',
      featured: true,
      urlSlug: blackM.urlSlug,
      searchKeywords: 'tee, t-shirt',
      attributes: { Fit: 'Regular', Material: 'Cotton', Occasion: 'Everyday, Travel' },
      primaryImageUrl: `https://cdn.test.local/${run}-Black-1.jpg`,
      imageUrls: [`https://cdn.test.local/${run}-Black-1.jpg`, `https://cdn.test.local/${run}-Black-2.jpg`],
      unitsSold: 3,
      lowStockThreshold: null,
    });
    const white = res.body.data.content.find((p: { id: string }) => p.id === whiteS.id);
    expect(white).toMatchObject({ mrp: null, discountPercent: null, unitsSold: 0 });
  });

  it('the PDP has parent extras, SEO fallback and live variants with images', async () => {
    const res = await request(app).get(`/api/products/${blackM.id}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ mrp: 20, discountPercent: 25, taxRate: 8, sku: expect.stringContaining('BLA-M') });
    expect(d.seo).toEqual({
      title: `Crew Tee ${run}`,
      metaDescription: 'A soft everyday tee.',
      keywords: 'tee, t-shirt',
      urlSlug: blackM.urlSlug,
    });
    expect(d.category).toMatchObject({ slug: 'clothing', code: 'CL' });
    expect(d.parent).toMatchObject({
      productType,
      subcategory: { slug: 'clothing-men' },
      keyFeatures: ['100% cotton', 'Pre-shrunk'],
      warranty: '30-day fit guarantee',
      attributes: { Fit: 'Regular' },
    });
    expect(d.variants).toHaveLength(2); // the DRAFT one is hidden from the public
    const white = d.variants.find((v: { id: string }) => v.id === whiteS.id);
    expect(white).toMatchObject({ color: 'White', size: 'S', mrp: null, urlSlug: `crew-tee-${run}-white-s` });
    expect(white.imageUrls).toHaveLength(2);
  });

  it('the PDP resolves by URL slug, case-insensitively; unknown slugs are 404', async () => {
    const res = await request(app).get(`/api/products/slug/${blackM.urlSlug.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(blackM.id);
    expect((await request(app).get(`/api/products/slug/nope-${run}`)).status).toBe(404);
  });

  it('catalog staff see unpublished variants', async () => {
    const catalog = await fixtures.registerUser('ROLE_CATALOG');
    const res = await request(app).get(`/api/products/${blackM.id}`).set('Authorization', `Bearer ${catalog}`);
    expect(res.body.data.variants).toHaveLength(3);
  });
});

describe('store config', () => {
  it('exposes shipping, tax and payment settings', async () => {
    const res = await request(app).get('/api/store/config');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      storeName: 'Ecommerce Collections',
      currency: 'USD',
      pricesIncludeTax: false,
      freeShippingThreshold: 35,
      shippingOptions: [
        { method: 'STANDARD', label: 'Standard shipping', estimatedDelivery: '3–5 business days', minDays: 3, maxDays: 5, fee: 5.99 },
        { method: 'EXPRESS', label: 'Express shipping', estimatedDelivery: '1–2 business days', minDays: 1, maxDays: 2, fee: 9.99 },
      ],
      returnWindowDays: 30,
      lowStockThreshold: 5,
      paymentProvider: 'manual',
      stripePublishableKey: null,
    });
  });
});

describe('roles', () => {
  it('catalog staff reach admin catalog routes but not orders', async () => {
    const catalog = await fixtures.registerUser('ROLE_CATALOG');
    const auth = { Authorization: `Bearer ${catalog}` };
    expect((await request(app).get('/api/admin/products').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/admin/inventory').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/admin/orders').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/orders/stats').set(auth)).status).toBe(403);
  });
});

describe('order numbers', () => {
  it('new orders are EC- plus 7 digits', async () => {
    const user = await fixtures.newCustomer();
    const address = await fixtures.newAddress(user.id);
    const product = await fixtures.newActiveProduct(5, '9.99');
    await fixtures.addToCart(user.id, product.id, 1);
    const { order } = await container.orders.checkout(user.id, { addressId: address.id });
    expect(order.orderNumber).toMatch(ORDER_NUMBER_PATTERN);
  });

  it('typed variants normalise; legacy numbers pass through', () => {
    expect(normalizeOrderNumber('ec4821907')).toBe('EC-4821907');
    expect(normalizeOrderNumber(' #EC-4821907 ')).toBe('EC-4821907');
    expect(normalizeOrderNumber('EC 4821907')).toBe('EC-4821907');
    expect(normalizeOrderNumber('nx-mfx3k2a1-1a2b3')).toBe('NX-MFX3K2A1-1A2B3');
  });
});
