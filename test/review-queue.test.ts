import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { businessHoursSince, slaState } from '../src/seller/review-queue.service';
import { harness } from './support/harness';

/**
 * Review queue: tabs, automatic checks (required fields, duplicates,
 * restricted brands, size of a price change, margin floor), structured
 * decisions, bulk approval and price history.
 */
const { app, prisma, fixtures } = harness({
  env: { REVIEW_RESTRICTED_BRANDS: 'ReplicaCo, Fakeworks', REVIEW_MARGIN_FLOOR_PERCENT: '20', REVIEW_BIG_PRICE_CHANGE_PERCENT: '30' },
});

let seller: string;
let reviewer: string;
let otherReviewer: string;
let run: string;

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  upload: (url: string, name: string, text: string) =>
    request(app).post(url).set('Authorization', `Bearer ${token}`).attach('file', Buffer.from(text), name),
});

const HEADER = 'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Subcategory,Product_Status,Color,Size,Selling_Price,Cost,Inventory_Qty,Image_1_URL';
const row = (code: string, o: { price?: string; cost?: string; brand?: string; name?: string; qty?: string } = {}) =>
  [
    `${code}-BLU`, code, o.name ?? `Queue Shirt ${code}`, o.brand ?? 'Northfold', 'clothing', 'Men', 'ACTIVE', 'Blue', 'M',
    o.price ?? '40.00', o.cost ?? '', o.qty ?? '10', `https://cdn.test.local/${code}.jpg`,
  ].join(',');
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

async function submit(code: string, o: Parameters<typeof row>[1] = {}, file = 'q.csv') {
  const res = await as(seller).upload('/api/seller/submissions', file, csv(row(code, o)));
  expect(res.status).toBe(200);
  expect(res.body.data.failedRows).toBe(0);
  return res.body.data.submissions[0].reference as string;
}

type Check = { key: string; status: string; detail: string };
type Item = { reference: string; type: string; flagged: boolean; blocked: boolean; checks: Check[]; priceChange: { percent: number } | null; assignedToMe: boolean };
const queue = async (view: string, q: string, token = reviewer) => {
  const res = await as(token).get(`/api/admin/review-queue?view=${view}&q=${encodeURIComponent(q)}&size=100`);
  expect(res.status).toBe(200);
  return res.body.data.content as Item[];
};
const check = (item: Item, key: string) => item.checks.find((c) => c.key === key);

beforeAll(async () => {
  seller = await fixtures.registerUser('ROLE_MERCHANT');
  reviewer = await fixtures.registerUser('ROLE_CATALOG');
  otherReviewer = await fixtures.registerUser('ROLE_ADMIN');
  run = randomUUID().slice(0, 8).toUpperCase();
});

describe('automatic checks', () => {
  it('passes a clean new product', async () => {
    const ref = await submit(`RQ-${run}-OK`, { cost: '20.00' });
    const [item] = await queue('all', ref);
    expect(item).toMatchObject({ reference: ref, type: 'new', flagged: false, blocked: false });
    expect(item.checks.map((c) => [c.key, c.status])).toEqual([
      ['required', 'pass'],
      ['duplicates', 'pass'],
      ['brand', 'pass'],
      ['margin', 'pass'],
    ]);
  });

  it('fails a restricted brand and a thin margin; approval is refused until fixed', async () => {
    const ref = await submit(`RQ-${run}-BR`, { brand: 'replicaco', price: '10.00', cost: '9.00' });
    const [item] = await queue('flagged', ref);
    expect(item).toMatchObject({ flagged: true, blocked: true });
    expect(check(item, 'brand')).toMatchObject({ status: 'fail', detail: '“replicaco” is on the restricted brands list' });
    expect(check(item, 'margin')).toMatchObject({ status: 'fail', detail: expect.stringContaining('10% margin. Floor: 20%') });

    const approve = await as(reviewer).post(`/api/admin/review-queue/${ref}/decision`, { decision: 'approve' });
    expect(approve.status).toBe(409);
    expect(approve.body.message).toContain('Restricted brands');

    // A reject needs one of the fixed reasons.
    expect((await as(reviewer).post(`/api/admin/review-queue/${ref}/decision`, { decision: 'reject' })).status).toBe(400);
    expect((await as(reviewer).post(`/api/admin/review-queue/${ref}/decision`, { decision: 'reject', reason: 'Because' })).status).toBe(400);
    const rejected = await as(reviewer).post(`/api/admin/review-queue/${ref}/decision`, {
      decision: 'reject',
      reason: 'Restricted or counterfeit brand',
      note: 'We can’t list this brand.',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: 'REJECTED',
      reviewNote: 'Reason: Restricted or counterfeit brand\n\nWe can’t list this brand.',
    });
    const audit = await prisma.auditEvent.findFirst({ where: { action: 'submission.rejected', entityId: ref } });
    expect(audit?.details).toMatchObject({ reason: 'Restricted or counterfeit brand' });
  });

  it('warns about a possible duplicate', async () => {
    const name = `Twin Tee ${run}`;
    await submit(`RQ-${run}-T1`, { name });
    const ref = await submit(`RQ-${run}-T2`, { name });
    const [item] = await queue('all', ref);
    expect(check(item, 'duplicates')).toMatchObject({ status: 'warn', detail: `Same title as RQ-${run}-T1 (same seller)` });
    expect(item).toMatchObject({ flagged: true, blocked: false });
  });
});

describe('price changes', () => {
  it('flags a big change, shows it in the price tab and keeps a price history', async () => {
    const code = `RQ-${run}-P`;
    const first = await submit(code);
    expect((await as(reviewer).post(`/api/admin/review-queue/${first}/decision`, { decision: 'approve' })).status).toBe(200);

    const small = await submit(code, { price: '38.00' }, 'small.csv');
    let [item] = await queue('price', small);
    expect(item).toMatchObject({ type: 'price', priceChange: { percent: -5 } });
    expect(check(item, 'price_change')).toMatchObject({ status: 'pass' });
    expect((await as(reviewer).post(`/api/admin/review-queue/${small}/decision`, { decision: 'approve' })).status).toBe(200);

    const big = await submit(code, { price: '20.00' }, 'big.csv');
    [item] = await queue('price', big);
    expect(item).toMatchObject({ type: 'price', flagged: true, blocked: false, priceChange: { percent: -47.4 } });
    expect(check(item, 'price_change')).toMatchObject({ status: 'warn', detail: expect.stringContaining('−47.4%') });

    const detail = await as(reviewer).get(`/api/admin/review-queue/${big}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.priceHistory.map((h: { action: string; before: string; after: string }) => [h.action, h.before, h.after])).toEqual([
      ['price.change_requested', '$38.00', '$20.00 (pending)'],
      ['price.changed', '$40.00', '$38.00'],
      ['price.change_requested', '$40.00', '$38.00 (pending)'],
    ]);
    // Warnings don't block a single approval.
    expect((await as(reviewer).post(`/api/admin/review-queue/${big}/decision`, { decision: 'approve' })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { sku: `${code}-BLU` } })).price.toFixed(2)).toBe('20.00');
  });
});

describe('tabs and decisions', () => {
  it('assigned to me, request changes with a checklist, reviewed by me', async () => {
    const ref = await submit(`RQ-${run}-A`);
    expect((await queue('mine', ref)).length).toBe(0);
    await as(reviewer).post(`/api/admin/submissions/${ref}/claim`);
    expect((await queue('mine', ref))[0]).toMatchObject({ assignedToMe: true });
    expect((await queue('mine', ref, otherReviewer)).length).toBe(0);

    const bad = await as(reviewer).post(`/api/admin/review-queue/${ref}/decision`, { decision: 'request-changes', note: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.data).toMatchObject({ fixes: 'choose what needs fixing', note: 'add a note the seller can act on' });
    const sent = await as(reviewer).post(`/api/admin/review-queue/${ref}/decision`, {
      decision: 'request-changes',
      fixes: ['Photos', 'Title'],
      note: 'Main photo is 800 px. Upload one at least 1000 px.',
    });
    expect(sent.status).toBe(200);
    expect(sent.body.data).toMatchObject({
      status: 'CHANGES_REQUESTED',
      reviewNote: 'What needs fixing: Photos, Title\n\nMain photo is 800 px. Upload one at least 1000 px.',
    });
    expect((await queue('all', ref)).length).toBe(0);
    expect((await queue('reviewed', ref))[0]).toMatchObject({ reference: ref });

    const counts = await as(reviewer).get('/api/admin/review-queue/counts');
    expect(counts.body.data).toMatchObject({ reviewed: expect.any(Number), reviewedToday: expect.any(Number), flagged: expect.any(Number) });
    expect(counts.body.data.reviewedToday).toBeGreaterThanOrEqual(1);
  });

  it('a delisting with stock left is flagged in the delisting tab', async () => {
    const code = `RQ-${run}-D`;
    const first = await submit(code);
    await as(reviewer).post(`/api/admin/review-queue/${first}/decision`, { decision: 'approve' });
    const parent = await prisma.parentProduct.findUniqueOrThrow({ where: { code } });
    const res = await as(seller).post(`/api/seller/products/${parent.id}/delist`, { note: 'Discontinued' });
    const [item] = await queue('delist', res.body.data.reference);
    expect(item).toMatchObject({ type: 'delist', flagged: true, blocked: false });
    expect(item.checks).toEqual([
      expect.objectContaining({ key: 'delist_request', status: 'pass', detail: 'Reason: Discontinued' }),
      expect.objectContaining({ key: 'stock_on_hand', status: 'warn', detail: '10 unit(s) · 0 sold in the last 30 days' }),
    ]);
  });

  it('bulk approves clean items and skips flagged ones', async () => {
    const a = await submit(`RQ-${run}-B1`);
    const b = await submit(`RQ-${run}-B2`);
    const flagged = await submit(`RQ-${run}-B3`, { brand: 'Fakeworks' });
    const res = await as(reviewer).post('/api/admin/review-queue/bulk-approve', { references: [a, b, flagged] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ approved: 2, skipped: 1 });
    expect(res.body.data.results[2]).toMatchObject({ reference: flagged, approved: false, error: expect.stringContaining('Restricted brands') });
    expect((await prisma.product.findUniqueOrThrow({ where: { sku: `RQ-${run}-B1-BLU` } })).status).toBe('ACTIVE');
    expect((await as(reviewer).post('/api/admin/review-queue/bulk-approve', { references: [] })).status).toBe(400);
  });

  it('item detail links to its neighbours; only catalog staff see the queue', async () => {
    const ref = await submit(`RQ-${run}-N`);
    const detail = await as(reviewer).get(`/api/admin/review-queue/${ref}`);
    expect(detail.body.data).toMatchObject({ reference: ref, sla: { state: 'on_track' } });
    expect(detail.body.data.previous).toEqual(expect.any(String));
    expect((await as(seller).get('/api/admin/review-queue')).status).toBe(403);
    expect((await as(reviewer).get('/api/admin/review-queue?view=nope')).status).toBe(400);
    expect((await as(reviewer).get('/api/admin/review-queue/reasons')).body.data.fixOptions).toContain('Photos');
  });
});

describe('business-hours clock', () => {
  it('counts weekdays only', () => {
    // Friday 12:00 → Monday 12:00 UTC is 24 business hours.
    expect(businessHoursSince(new Date('2026-11-06T12:00:00Z'), new Date('2026-11-09T12:00:00Z'))).toBe(24);
    expect(slaState(new Date('2026-11-02T00:00:00Z'), new Date('2026-11-04T01:00:00Z')).state).toBe('overdue');
    expect(slaState(new Date('2026-11-02T00:00:00Z'), new Date('2026-11-03T01:00:00Z')).state).toBe('due_soon');
  });
});
