import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { harness } from './support/harness';
import { SecretBox } from '../src/integrations/secret-box';

/** Admin › Settings › API integrations: CUSTOM vendors, sealed secrets, the generic connection test. */
const { app, prisma, fixtures, config } = harness();

const run = randomUUID().slice(0, 6);
const HOST = `vendor-${run}.test.local`;
const seen: Array<{ url: URL; headers: Record<string, string> }> = [];

const realFetch = globalThis.fetch;
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== HOST) return realFetch(input, init);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  seen.push({ url, headers });
  const authorised = headers.Authorization === 'Bearer sk_live_abcdef123456' || headers['X-Api-Key'] === 'sk_live_abcdef123456';
  return new Response('{}', { status: authorised ? 200 : 401, statusText: authorised ? 'OK' : 'Unauthorized' });
};

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body?: object) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  del: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
});

let admin: string;
let catalog: string;

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  admin = await fixtures.registerUser('ROLE_ADMIN');
  catalog = await fixtures.registerUser('ROLE_CATALOG');
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('API integrations', () => {
  it('seals secrets and opens them only with the same key', () => {
    const box = new SecretBox(config.integrations.encryptionKey);
    const sealed = box.seal({ API_KEY: 'secret-value' });
    expect(sealed).not.toContain('secret-value');
    expect(box.open(sealed)).toEqual({ API_KEY: 'secret-value' });
    expect(() => new SecretBox(Buffer.alloc(32, 7)).open(sealed)).toThrow();
  });

  it('lists the vendor types, admin only', async () => {
    expect((await as(catalog).get('/api/admin/integrations/providers')).status).toBe(403);
    expect((await as(catalog).get('/api/admin/integrations')).status).toBe(403);
    const res = await as(admin).get('/api/admin/integrations/providers');
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual(['GOOTEN', 'CUSTOM']);
  });

  let slug: string;

  it('adds a custom vendor with any secrets, showing only hints', async () => {
    const bad = await as(admin).post('/api/admin/integrations', {
      provider: 'CUSTOM',
      name: 'Printful',
      secrets: { 'api key': 'x' },
    });
    expect(bad.status).toBe(400);

    const res = await as(admin).post('/api/admin/integrations', {
      provider: 'CUSTOM',
      name: `Acme Supply ${run}`,
      baseUrl: `https://${HOST}/api/`,
      secrets: { API_KEY: 'sk_live_abcdef123456', SHORT: 'abc' },
      settings: { authType: 'bearer', authSecret: 'API_KEY', testPath: '/v1/ping' },
      notes: 'Wholesale apparel',
    });
    expect(res.status).toBe(201);
    slug = res.body.data.slug;
    expect(slug).toBe(`acme-supply-${run}`);
    expect(res.body.data).toMatchObject({
      provider: 'CUSTOM',
      baseUrl: `https://${HOST}/api`,
      enabled: true,
      secrets: [
        { name: 'API_KEY', hint: '••••••3456' },
        { name: 'SHORT', hint: '••••••' },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('sk_live');

    const unknownSetting = await as(admin).patch(`/api/admin/integrations/${slug}`, { settings: { colour: 'red' } });
    expect(unknownSetting.status).toBe(400);
    const badSelect = await as(admin).patch(`/api/admin/integrations/${slug}`, { settings: { authType: 'magic' } });
    expect(badSelect.status).toBe(400);
  });

  it('tests the connection with the configured credential', async () => {
    const ok = await as(admin).post(`/api/admin/integrations/${slug}/test`);
    expect(ok.body.data).toMatchObject({ ok: true, detail: { status: 200 } });
    expect(seen.at(-1)!.url.pathname).toBe('/api/v1/ping');

    await as(admin).patch(`/api/admin/integrations/${slug}`, { settings: { authType: 'header', authName: 'X-Api-Key' } });
    expect((await as(admin).post(`/api/admin/integrations/${slug}/test`)).body.data.ok).toBe(true);
    expect(seen.at(-1)!.headers['X-Api-Key']).toBe('sk_live_abcdef123456');

    // Replace one secret, remove another, keep the rest.
    const upd = await as(admin).patch(`/api/admin/integrations/${slug}`, { secrets: { API_KEY: 'wrong-key-000000', SHORT: null } });
    expect(upd.body.data.secrets).toEqual([{ name: 'API_KEY', hint: '••••••0000' }]);
    const failed = await as(admin).post(`/api/admin/integrations/${slug}/test`);
    expect(failed.body.data).toMatchObject({ ok: false, message: expect.stringContaining('401') });
  });

  it('shows enabled integrations as sidebar tabs and removes them', async () => {
    const nav = async () => (await as(catalog).get('/api/admin/integrations-nav')).body.data.map((n: { slug: string }) => n.slug);
    expect(await nav()).toContain(slug);
    await as(admin).patch(`/api/admin/integrations/${slug}`, { enabled: false });
    expect(await nav()).not.toContain(slug);

    expect((await as(admin).del(`/api/admin/integrations/${slug}`)).status).toBe(200);
    expect((await as(admin).get(`/api/admin/integrations/${slug}`)).status).toBe(404);
    expect(await prisma.integration.count({ where: { slug } })).toBe(0);
  });
});
