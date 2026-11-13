import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { accountShopping } from './support/account-shopping';
import { harness } from './support/harness';

/**
 * Gooten over HTTP: connected through Settings › API integrations, then the
 * Gooten tab. Gooten itself is scripted (no network): the stub answers with
 * the shapes the live API returns.
 */
const h = harness();
const { app, prisma, fixtures } = h;
const shop = accountShopping(h);

const run = randomUUID().slice(0, 6);
const PRODUCT_ID = 900000 + Math.floor(Math.random() * 99999);
const SKUS = [`Mug11oz-White-${run}`, `Mug11oz-Black-${run}`];

const gootenCalls: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];
let rejectOrders = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const realFetch = globalThis.fetch;
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'api.print.io') return realFetch(input, init);
  const path = url.pathname.replace('/api/v/5/source/api/', '');
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  gootenCalls.push({ method: init?.method ?? 'GET', path, query: url.searchParams, body });
  if (path === 'products/') {
    return json({
      Products: [
        {
          Id: PRODUCT_ID,
          Name: `Accent Mug ${run}`,
          ShortDescription: 'Short Description',
          HasAvailableProductVariants: true,
          RetailPrice: { Price: 12.27, CurrencyCode: 'USD' },
          Info: [
            { Content: ['A colourful ceramic mug.'], ContentType: 'Text', Index: 1 },
            { Content: ['11 oz'], ContentType: 'List', Key: 'Sizes', Index: 1 },
          ],
          Images: [{ Url: 'https://cdn.gooten.test/mug.png', Index: 0 }],
          Categories: [{ Id: 1, Name: 'Drinkware' }],
        },
        { Id: 1, Name: 'Coming soon thing', IsComingSoon: true, HasAvailableProductVariants: true },
      ],
    });
  }
  if (path === 'productvariants/') {
    return json({
      ProductVariants: SKUS.map((Sku, i) => ({
        Sku,
        PriceInfo: { Price: i === 0 ? 10.3 : 11, CurrencyCode: 'USD' },
        Options: [
          { OptionId: 'a', ValueId: 'b', Name: 'Color', Value: i === 0 ? 'White' : 'Black', ImageUrl: `https://cdn.gooten.test/${i}.png` },
          { OptionId: 'c', ValueId: 'd', Name: 'Size', Value: '11 oz' },
          { OptionId: 'e', ValueId: 'f', Name: 'Print Area', Value: 'Regular' },
        ],
      })),
    });
  }
  if (path === 'shippingprices/') {
    return json({
      Result: [
        {
          SKUs: body.Items.map((i: { SKU: string }) => i.SKU),
          ShipOptions: [
            { Id: 1, MethodId: 3, MethodType: 'Standard', Name: 'Standard', Price: { Price: 7.29, CurrencyCode: 'USD' } },
            { Id: 2, MethodId: 5, MethodType: 'Expedited', Name: 'Expedited', Price: { Price: 16.99, CurrencyCode: 'USD' } },
          ],
        },
      ],
    });
  }
  if (path === 'orders/' && init?.method === 'POST') {
    if (rejectOrders) {
      return json({ HadError: true, Errors: [{ PropertyName: 'Order.ShipToAddress.PostalCode', ErrorMessage: 'Invalid postal code' }] }, 400);
    }
    return json({ Id: `GT-ORDER-${run}` });
  }
  if (path === 'orders/') {
    return json({ Id: url.searchParams.get('id'), Items: [{ Status: 'In Production', TrackingNumber: null }] });
  }
  return json({ HadError: true, Errors: [{ ErrorMessage: 'unknown path' }] }, 404);
};

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body?: object) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
});

let admin: string;
let catalog: string;
let subcategoryId: string;

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  admin = await fixtures.registerUser('ROLE_ADMIN');
  catalog = await fixtures.registerUser('ROLE_CATALOG');
  subcategoryId = (await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing-men' } })).id;
  // The database is shared between files: start without a Gooten connection.
  await prisma.integration.deleteMany({ where: { provider: 'GOOTEN' } });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const BASE = '/api/admin/vendors/gooten';

describe('Gooten vendor integration', () => {
  it('asks for the integration until one is added', async () => {
    const status = await as(catalog).get(`${BASE}/status`);
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ integration: null, connection: { ok: false } });
    expect((await as(catalog).get(`${BASE}/catalog`)).status).toBe(409);
  });

  it('connects through Settings › API integrations (admin only), keeping the keys sealed', async () => {
    const body = {
      provider: 'GOOTEN',
      name: 'Gooten',
      secrets: { RECIPE_ID: 'recipe-test-0001', PARTNER_BILLING_KEY: 'billing-key-test-9999' },
      settings: { testMode: true },
    };
    expect((await as(catalog).post('/api/admin/integrations', body)).status).toBe(403);
    const res = await as(admin).post('/api/admin/integrations', body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      slug: 'gooten',
      provider: 'GOOTEN',
      baseUrl: 'https://api.print.io/api/v/5/source/api',
      settings: { testMode: true },
      secrets: [
        { name: 'PARTNER_BILLING_KEY', hint: '••••••9999' },
        { name: 'RECIPE_ID', hint: '••••••0001' },
      ],
      missingSecrets: [],
    });
    expect(JSON.stringify(res.body)).not.toContain('billing-key-test');
    const stored = await prisma.integration.findUniqueOrThrow({ where: { slug: 'gooten' } });
    expect(stored.secrets).not.toContain('billing-key-test');

    // One Gooten connection: the adapter reads "the" Gooten integration.
    expect((await as(admin).post('/api/admin/integrations', body)).status).toBe(409);
    // Its secrets are Gooten's own names.
    const bad = await as(admin).patch('/api/admin/integrations/gooten', { secrets: { API_KEY: 'x' } });
    expect(bad.status).toBe(400);

    const test = await as(admin).post('/api/admin/integrations/gooten/test');
    expect(test.body.data).toMatchObject({ ok: true, detail: { products: 2, testMode: true } });

    const nav = await as(catalog).get('/api/admin/integrations-nav');
    expect(nav.body.data).toContainEqual({ slug: 'gooten', name: 'Gooten', provider: 'GOOTEN', providerLabel: 'Gooten' });
  });

  it('reports the connection on the Gooten tab', async () => {
    const res = await as(catalog).get(`${BASE}/status`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      integration: { slug: 'gooten' },
      recipeIdConfigured: true,
      billingKeyConfigured: true,
      testMode: true,
      connection: { ok: true, products: 1 },
    });
    expect(JSON.stringify(res.body)).not.toContain('billing-key-test');
    expect(gootenCalls.at(-1)!.query.get('recipeid')).toBe('recipe-test-0001');
  });

  it('lists and shows Gooten products, hiding coming-soon ones', async () => {
    const list = await as(catalog).get(`${BASE}/catalog`).query({ search: `mug ${run}` });
    expect(list.status).toBe(200);
    expect(list.body.data.products).toEqual([
      expect.objectContaining({ id: PRODUCT_ID, retailPrice: 12.27, categories: ['Drinkware'], importedParentId: null }),
    ]);
    const detail = await as(catalog).get(`${BASE}/catalog/${PRODUCT_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.shortDescription).toBe('A colourful ceramic mug.');
    expect(detail.body.data.variants[0]).toMatchObject({ sku: SKUS[0], ourSku: `GT-${SKUS[0]}`, cost: 10.3, color: 'White', size: '11 oz' });
  });

  let parentId: string;
  let linkId: string;

  it('imports a product as Gooten-supplied SKUs priced at cost plus markup', async () => {
    const res = await as(catalog).post(`${BASE}/catalog/${PRODUCT_ID}/import`, { subcategoryId, markupPercent: 50, status: 'ACTIVE' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ variants: 2 });
    parentId = res.body.data.parentId;

    const skus = await prisma.product.findMany({ where: { parentId }, orderBy: { sku: 'asc' } });
    expect(skus.map((s) => [s.sku, s.price.toFixed(2), s.cost?.toFixed(2), s.supplierId, s.stockQuantity, s.status])).toEqual([
      [`GT-${SKUS[1]}`, '16.50', '11.00', 'GOOTEN', 9999, 'ACTIVE'],
      [`GT-${SKUS[0]}`, '15.45', '10.30', 'GOOTEN', 9999, 'ACTIVE'],
    ]);

    const again = await as(catalog).post(`${BASE}/catalog/${PRODUCT_ID}/import`, { subcategoryId, markupPercent: 50 });
    expect(again.status).toBe(409);

    const links = await as(catalog).get(`${BASE}/products`);
    const link = links.body.data.find((l: { parentId: string }) => l.parentId === parentId);
    expect(link).toMatchObject({ vendorProductId: String(PRODUCT_ID), variants: 2, markupPercent: 50, printFileUrl: null });
    linkId = link.id;
  });

  it('keeps orders admin-only', async () => {
    expect((await as(catalog).get(`${BASE}/orders`)).status).toBe(403);
  });

  it('needs a print file, then sends the order in test mode with the billing key', async () => {
    const { userId } = await shop.shopper();
    const product = await prisma.product.findFirstOrThrow({ where: { parentId, sku: `GT-${SKUS[0]}` } });
    const order = await shop.newOrder(userId, [{ price: '15.45', qty: 2, product }], { status: 'PAID' });

    const listed = await as(admin).get(`${BASE}/orders`);
    expect(listed.body.data.find((o: { orderId: string }) => o.orderId === order.id)).toMatchObject({ submission: null });

    const noArt = await as(admin).post(`${BASE}/orders/${order.id}/submit`, { shipMethod: 'STANDARD' });
    expect(noArt.status).toBe(409);
    expect(noArt.body.message).toContain('print file');

    expect((await as(catalog).patch(`${BASE}/products/${linkId}`, { printFileUrl: 'not a url' })).status).toBe(400);
    expect((await as(catalog).patch(`${BASE}/products/${linkId}`, { printFileUrl: 'https://cdn.test.local/art.png' })).status).toBe(200);

    const sent = await as(admin).post(`${BASE}/orders/${order.id}/submit`, { shipMethod: 'STANDARD' });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ vendorOrderId: `GT-ORDER-${run}`, status: 'SUBMITTED', testMode: true });

    const call = gootenCalls.filter((c) => c.path === 'orders/' && c.method === 'POST').at(-1)!;
    expect(call.body).toMatchObject({
      IsInTestMode: true,
      SourceId: order.orderNumber,
      Payment: { PartnerBillingKey: 'billing-key-test-9999' },
      ShipToAddress: { FirstName: 'Jordan', LastName: 'Miller', City: 'Portland', State: 'OR', CountryCode: 'US', PostalCode: '97214' },
      Items: [{ SKU: SKUS[0], Quantity: 2, ShipCarrierMethodId: 1, Images: [{ Url: 'https://cdn.test.local/art.png', Index: 0 }] }],
    });

    const row = await prisma.vendorOrder.findFirstOrThrow({ where: { orderId: order.id } });
    expect(JSON.stringify(row.request)).not.toContain('billing-key-test');
    const event = await prisma.orderEvent.findFirst({ where: { orderId: order.id, note: { contains: 'Gooten' } } });
    expect(event?.note).toContain(`GT-ORDER-${run}`);

    expect((await as(admin).post(`${BASE}/orders/${order.id}/submit`, { shipMethod: 'STANDARD' })).status).toBe(409);

    const refreshed = await as(admin).post(`${BASE}/submissions/${row.id}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.status).toBe('In Production');
  });

  it('records a rejected order and answers 502 with Gooten’s reason', async () => {
    const { userId } = await shop.shopper();
    const product = await prisma.product.findFirstOrThrow({ where: { parentId, sku: `GT-${SKUS[1]}` } });
    const order = await shop.newOrder(userId, [{ price: '16.50', qty: 1, product }], { status: 'PAID' });
    rejectOrders = true;
    try {
      const res = await as(admin).post(`${BASE}/orders/${order.id}/submit`, { shipMethod: 'EXPEDITED' });
      expect(res.status).toBe(502);
      expect(res.body.message).toContain('Invalid postal code');
    } finally {
      rejectOrders = false;
    }
    const row = await prisma.vendorOrder.findFirstOrThrow({ where: { orderId: order.id } });
    expect(row).toMatchObject({ status: 'FAILED', vendorOrderId: null, shipMethod: 'EXPEDITED' });
  });
});
