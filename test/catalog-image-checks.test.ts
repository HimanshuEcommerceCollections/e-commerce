import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** FR-IM-08: image URLs are checked; a broken image is flagged, the product still imports. */
const { prisma, container } = harness({ env: { IMAGE_CHECKS_ENABLED: 'true', IMAGE_CHECK_TIMEOUT_MS: '500' } });

let server: Server;
let base: string;
let missingFixed = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '';
    if (path.startsWith('/ok')) return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end();
    if (path.startsWith('/missing')) {
      return missingFixed ? res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end() : res.writeHead(404).end();
    }
    if (path.startsWith('/page')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>');
    if (path.startsWith('/nohead')) {
      return req.method === 'HEAD' ? res.writeHead(405).end() : res.writeHead(200, { 'Content-Type': 'image/png' }).end('png');
    }
    if (path.startsWith('/slow')) return void setTimeout(() => res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(), 2000);
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('image URL checks', () => {
  it('imports products with broken images, flags them and reports them', async () => {
    const run = randomUUID().slice(0, 8).toUpperCase();
    const header = 'SKU_ID,Product_Name,Category,Product_Status,Selling_Price,Inventory_Qty,Image_1_URL,Image_2_URL,Lifestyle_Image_URL';
    const csv = [
      header,
      `I-${run}-A,Lamp A,home-kitchen,ACTIVE,10,1,${base}/ok-a.jpg,${base}/missing-a.jpg,${base}/missing-life.jpg`,
      `I-${run}-B,Lamp B,home-kitchen,ACTIVE,10,1,${base}/nohead-b.jpg,${base}/page-b.html,`,
      `I-${run}-C,Lamp C,home-kitchen,ACTIVE,10,1,${base}/slow-c.jpg,,`,
    ].join('\n');

    const report = await container.catalogImport.importFile(
      { originalname: 'images.csv', buffer: Buffer.from(csv) },
      randomUUID(),
      { staff: true },
    );

    expect(report.errors).toEqual([]);
    expect(report.importedRows).toBe(3);
    expect(report.imagesChecked).toBe(true);
    expect(report.imageErrors).toEqual([
      { row: 2, sku: `I-${run}-A`, column: 'Image_2_URL', url: `${base}/missing-a.jpg`, reason: 'HTTP 404' },
      { row: 2, sku: `I-${run}-A`, column: 'Lifestyle_Image_URL', url: `${base}/missing-life.jpg`, reason: 'HTTP 404' },
      {
        row: 3,
        sku: `I-${run}-B`,
        column: 'Image_2_URL',
        url: `${base}/page-b.html`,
        reason: 'Not an image (Content-Type text/html)',
      },
      { row: 4, sku: `I-${run}-C`, column: 'Image_1_URL', url: `${base}/slow-c.jpg`, reason: 'Timed out after 500 ms' },
    ]);

    const images = await prisma.productImage.findMany({
      where: { product: { sku: { startsWith: `I-${run}-` } } },
      orderBy: [{ product: { sku: 'asc' } }, { position: 'asc' }],
    });
    expect(images.map((i) => [i.url.replace(base, ''), i.checkStatus])).toEqual([
      ['/ok-a.jpg', 'OK'],
      ['/missing-a.jpg', 'BROKEN'],
      ['/nohead-b.jpg', 'OK'],
      ['/page-b.html', 'BROKEN'],
      ['/slow-c.jpg', 'BROKEN'],
    ]);
    expect(images.every((i) => i.checkedAt !== null)).toBe(true);

    const issues = await container.catalogAdmin.imageIssues({ page: 0, size: 50, sort: [] });
    const ours = issues.content.filter((i) => i.sku.startsWith(`I-${run}-`));
    expect(ours.map((i) => [i.sku, i.error])).toEqual(
      expect.arrayContaining([
        [`I-${run}-A`, 'HTTP 404'],
        [`I-${run}-B`, 'Not an image (Content-Type text/html)'],
        [`I-${run}-C`, 'Timed out after 500 ms'],
      ]),
    );

    // The CDN gets the missing file; a re-check of the problems clears it.
    missingFixed = true;
    // (Limited to this server's URLs: the shared test database holds other files' unchecked images.)
    const recheck = await container.imageChecks.recheck('problems', { url: { startsWith: base } });
    expect(recheck.enabled).toBe(true);
    expect(recheck.checked).toBeGreaterThanOrEqual(3);
    const fixed = await prisma.productImage.findFirstOrThrow({ where: { url: `${base}/missing-a.jpg` } });
    expect(fixed).toMatchObject({ checkStatus: 'OK', checkError: null });
  });
});
