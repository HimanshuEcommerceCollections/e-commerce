import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VercelBlobStorage, keyUnder, type ObjectStorage } from '../src/storage/object-storage';
import { harness } from './support/harness';

/** Object storage in memory, served at https://img.test.local/<key>. */
class MemoryStorage implements ObjectStorage {
  readonly provider = 'memory';
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
    return `https://img.test.local/${key}`;
  }
  async delete(keys: string[]) {
    for (const k of keys) this.objects.delete(k);
  }
  keyOf(url: string) {
    return keyUnder(url, 'https://img.test.local');
  }
  urlFor(key: string) {
    return `https://img.test.local/${key}`;
  }
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
  /** Direct uploads: the test plays the browser and puts the file with `browserPut`. */
  async directUpload(key: string) {
    return { method: 'vercel-blob' as const, pathname: key, clientToken: `token-for-${key}` };
  }
  browserPut(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
}

/** The smallest buffer image-size reads as a PNG of this size: signature + IHDR. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 6, 0, 0, 0], 16);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

const storage = new MemoryStorage();
const { app, fixtures, prisma, container } = harness({ storage });
const off = harness();

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/photo.png')) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png(1600, 1200));
    if (req.url?.startsWith('/page')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>');
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const KEY = /^products\/\d{4}\/\d{2}\/[0-9a-f-]{36}-(\d+)x(\d+)\.(\w+)$/;

describe('product image uploads', () => {
  it('stores an uploaded image and returns its URL, key and size', async () => {
    const seller = await fixtures.registerUser('ROLE_MERCHANT');
    const res = await request(app).post('/api/catalog/images').set('Authorization', `Bearer ${seller}`).attach('file', png(1200, 900), 'shoe.png');

    expect(res.status).toBe(201);
    const img = res.body.data;
    expect(img).toMatchObject({ width: 1200, height: 900, contentType: 'image/png', fileSizeBytes: 33 });
    expect(img.storageKey).toMatch(KEY);
    expect(img.storageKey).toMatch(/-1200x900\.png$/);
    expect(img.url).toBe(`https://img.test.local/${img.storageKey}`);
    expect(storage.objects.get(img.storageKey)?.contentType).toBe('image/png');
  });

  it('refuses files that are not images, and customers', async () => {
    const staff = await fixtures.registerUser('ROLE_CATALOG');
    const text = await request(app).post('/api/catalog/images').set('Authorization', `Bearer ${staff}`).attach('file', Buffer.from('<svg/>'), 'x.svg');
    expect(text.status).toBe(415);
    expect(text.body.message).toBe('Upload a JPG, PNG, WebP or GIF image');

    const customer = await fixtures.registerUser('ROLE_CUSTOMER');
    const denied = await request(app).post('/api/catalog/images').set('Authorization', `Bearer ${customer}`).attach('file', png(10, 10), 'a.png');
    expect(denied.status).toBe(403);
  });

  it('answers 503 when no storage is configured', async () => {
    const staff = await off.fixtures.registerUser('ROLE_CATALOG');
    const cfg = await request(off.app).get('/api/catalog/images/config').set('Authorization', `Bearer ${staff}`);
    expect(cfg.body.data.enabled).toBe(false);
    const res = await request(off.app).post('/api/catalog/images').set('Authorization', `Bearer ${staff}`).attach('file', png(10, 10), 'a.png');
    expect(res.status).toBe(503);
  });

  it('copies an image from a link, and reports links that are not images', async () => {
    const seller = await fixtures.registerUser('ROLE_MERCHANT');
    const copy = (url: string) => request(app).post('/api/catalog/images/from-url').set('Authorization', `Bearer ${seller}`).send({ url });

    const res = await copy(`${base}/photo.png`);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ width: 1600, height: 1200, contentType: 'image/png' });
    expect(storage.objects.has(res.body.data.storageKey)).toBe(true);

    // Already ours: returned as is, nothing copied.
    const before = storage.objects.size;
    const again = await copy(res.body.data.url);
    expect(again.body.data).toMatchObject({ url: res.body.data.url, storageKey: res.body.data.storageKey, width: 1600 });
    expect(storage.objects.size).toBe(before);

    expect((await copy(`${base}/missing.png`)).body.message).toBe("Couldn't download the image: HTTP 404");
    expect((await copy(`${base}/page`)).status).toBe(415);
    expect((await copy('ftp://example.com/a.png')).status).toBe(400);
  });

  it('fills storage key, size and type on imported rows that use a stored image', async () => {
    const stored = await container.imageUploads.store(png(2000, 1500));
    const run = randomUUID().slice(0, 8).toUpperCase();
    const sku = `UP-${run}`;
    const csv = [
      'SKU_ID,Product_Name,Category,Product_Status,Selling_Price,Inventory_Qty,Image_1_URL,Image_2_URL',
      `${sku},Lamp,home-kitchen,ACTIVE,10,1,${stored.url},https://cdn.test.local/${sku}.jpg`,
    ].join('\n');
    const report = await container.catalogImport.importFile({ originalname: 'up.csv', buffer: Buffer.from(csv) }, randomUUID(), { staff: true });
    expect(report.errors).toEqual([]);

    const rows = await prisma.productImage.findMany({ where: { product: { sku } }, orderBy: { position: 'asc' } });
    expect(rows[0]).toMatchObject({ url: stored.url, storageKey: stored.storageKey, width: 2000, height: 1500, contentType: 'image/png' });
    expect(rows[0]!.fileSizeBytes).toBe(BigInt(stored.fileSizeBytes));
    expect(rows[1]).toMatchObject({ storageKey: null, width: null, height: null, fileSizeBytes: null });
  });

  it('records each upload with its size and uploader', async () => {
    const seller = await fixtures.registerUser('ROLE_MERCHANT');
    const res = await request(app).post('/api/catalog/images').set('Authorization', `Bearer ${seller}`).attach('file', png(1100, 1100), 'a.png');
    const row = await prisma.imageUpload.findUnique({ where: { storageKey: res.body.data.storageKey } });
    expect(row).toMatchObject({ url: res.body.data.url, width: 1100, height: 1100, contentType: 'image/png', fileSizeBytes: 33n, deletedAt: null });
    expect(row!.uploadedBy).not.toBeNull();
  });
});

describe('direct (browser-to-storage) uploads', () => {
  const start = (token: string, body: object) =>
    request(app).post('/api/catalog/images/direct').set('Authorization', `Bearer ${token}`).send(body);
  const complete = (token: string, storageKey: string) =>
    request(app).post('/api/catalog/images/direct/complete').set('Authorization', `Bearer ${token}`).send({ storageKey });

  it('issues a token for one path, then checks and records the uploaded file', async () => {
    const seller = await fixtures.registerUser('ROLE_MERCHANT');
    const cfg = await request(app).get('/api/catalog/images/config').set('Authorization', `Bearer ${seller}`);
    expect(cfg.body.data.directMaxFileSizeBytes).toBe(10 * 1024 * 1024);

    const body = png(3000, 2000);
    const res = await start(seller, { contentType: 'image/png', fileSizeBytes: 6 * 1024 * 1024, width: 3000, height: 2000 });
    expect(res.status).toBe(201);
    const { storageKey, pathname, clientToken, url } = res.body.data;
    expect(storageKey).toMatch(/-3000x2000\.png$/);
    expect(pathname).toBe(storageKey);
    expect(clientToken).toBe(`token-for-${storageKey}`);

    // Not uploaded yet.
    expect((await complete(seller, storageKey)).status).toBe(409);
    storage.browserPut(storageKey, body, 'image/png');
    const done = await complete(seller, storageKey);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ url, storageKey, width: 3000, height: 2000, contentType: 'image/png', fileSizeBytes: body.length });
    expect((await prisma.imageUpload.findUnique({ where: { storageKey } }))!.fileSizeBytes).toBe(BigInt(body.length));

    // Someone else can't finish it.
    const other = await fixtures.registerUser('ROLE_MERCHANT');
    expect((await complete(other, storageKey)).status).toBe(404);
  });

  it('refuses files over 10 MB and unsupported types, and removes a file that is not what was declared', async () => {
    const seller = await fixtures.registerUser('ROLE_MERCHANT');
    expect((await start(seller, { contentType: 'image/png', fileSizeBytes: 11 * 1024 * 1024, width: 10, height: 10 })).status).toBe(413);
    expect((await start(seller, { contentType: 'image/svg+xml', fileSizeBytes: 100, width: 10, height: 10 })).status).toBe(415);

    const res = await start(seller, { contentType: 'image/png', fileSizeBytes: 33, width: 1200, height: 1200 });
    const { storageKey } = res.body.data;
    storage.browserPut(storageKey, png(800, 800), 'image/png');
    const done = await complete(seller, storageKey);
    expect(done.status).toBe(400);
    expect(storage.objects.has(storageKey)).toBe(false);
    expect((await prisma.imageUpload.findUnique({ where: { storageKey } }))!.deletedAt).not.toBeNull();
  });
});

describe('copying from a link', () => {
  it('accepts images larger than the API upload limit', async () => {
    const big = Buffer.concat([png(1500, 1500), Buffer.alloc(5 * 1024 * 1024)]);
    const srv = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(big));
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
      const img = await container.imageUploads.storeFromUrl(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/big.png`);
      expect(img).toMatchObject({ width: 1500, fileSizeBytes: big.length });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('cleanup of unused image files', () => {
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const upload = async (w: number, aged = true) => {
    const img = await container.imageUploads.store(png(w, w));
    if (aged) await prisma.imageUpload.update({ where: { storageKey: img.storageKey }, data: { createdAt: longAgo } });
    return img;
  };

  it('removes old files nothing refers to, and keeps files in use or still recent', async () => {
    const run = randomUUID().slice(0, 8).toUpperCase();
    const onProduct = await upload(1001);
    const orphan = await upload(1002);
    const recent = await upload(1003, false);
    const inSubmission = await upload(1004);
    const lifestyle = await upload(1005);
    const removedFromProduct = await upload(1006);

    // On a SKU's gallery; a second SKU's image is then replaced (no longer referenced).
    const csv = (sku: string, url: string) =>
      ['SKU_ID,Product_Name,Category,Product_Status,Selling_Price,Inventory_Qty,Image_1_URL', `${sku},Lamp,home-kitchen,ACTIVE,10,1,${url}`].join('\n');
    const importCsv = (body: string) =>
      container.catalogImport.importFile({ originalname: 'c.csv', buffer: Buffer.from(body) }, randomUUID(), { staff: true });
    await importCsv(csv(`CL-${run}-A`, onProduct.url));
    await importCsv(csv(`CL-${run}-B`, removedFromProduct.url));
    await importCsv(csv(`CL-${run}-B`, `https://cdn.test.local/${run}.jpg`));

    // In an open submission's template rows.
    const seller = await fixtures.newCustomer();
    const parent = await prisma.parentProduct.create({
      data: { code: `CL-${run}-P`, name: 'Lamp', merchantId: seller.id, lifestyleImageUrl: lifestyle.url },
    });
    await prisma.productSubmission.create({
      data: {
        reference: `CL-${run}`,
        merchantId: seller.id,
        parentProductId: parent.id,
        kind: 'EDIT',
        status: 'SUBMITTED',
        source: 'FORM',
        submittedAt: new Date(),
        payload: { headers: ['Image_1_URL'], rows: [{ image_1_url: inSubmission.url }] },
      },
    });

    const dry = await container.imageUploads.cleanup({ dryRun: true, limit: 5000 });
    expect(dry.storageKeys).toEqual(expect.arrayContaining([orphan.storageKey, removedFromProduct.storageKey]));
    for (const kept of [onProduct, recent, inSubmission, lifestyle]) expect(dry.storageKeys).not.toContain(kept.storageKey);
    expect(storage.objects.has(orphan.storageKey)).toBe(true);

    const done = await container.imageUploads.cleanup({ limit: 5000 });
    expect(done.removed).toBeGreaterThanOrEqual(2);
    expect(storage.objects.has(orphan.storageKey)).toBe(false);
    expect(storage.objects.has(removedFromProduct.storageKey)).toBe(false);
    for (const kept of [onProduct, recent, inSubmission, lifestyle]) expect(storage.objects.has(kept.storageKey)).toBe(true);
    expect((await prisma.imageUpload.findUnique({ where: { storageKey: orphan.storageKey } }))!.deletedAt).not.toBeNull();

    // Already removed files are not picked again.
    expect((await container.imageUploads.cleanup({ dryRun: true, limit: 5000 })).storageKeys).not.toContain(orphan.storageKey);
  });
});

describe('Vercel Blob URLs', () => {
  it('maps public blob URLs, and a custom domain, back to their keys', () => {
    const blob = new VercelBlobStorage('token');
    expect(blob.keyOf('https://abc123.public.blob.vercel-storage.com/products/2026/11/x-10x10.png')).toBe('products/2026/11/x-10x10.png');
    expect(blob.keyOf('https://cdn.example.com/products/a.png')).toBeNull();
    const custom = new VercelBlobStorage('token', 'https://images.example.com');
    expect(custom.keyOf('https://images.example.com/products/a.png')).toBe('products/a.png');
  });
});
