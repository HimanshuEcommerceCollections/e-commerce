import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Promotions admin CRUD (contract D3). Applying codes at checkout is tested with the cart. */
const { app, prisma, container } = harness();

let admin: string;

async function tokenFor(role: 'ROLE_ADMIN' | 'ROLE_CATALOG') {
  const user = await prisma.user.create({
    data: { email: `staff-${randomUUID()}@test.local`, password: 'x', fullName: 'Staff Member', role },
  });
  return container.jwt.generateToken(user.email);
}

const as = (token = admin) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
});

const code = () => `T${randomUUID().slice(0, 8)}`;

async function orderWith(promotionId: string, status: string) {
  await prisma.order.create({
    data: {
      customerEmail: `p-${randomUUID()}@test.local`,
      orderNumber: `T-${randomUUID()}`,
      status,
      currency: 'USD',
      subtotal: 50,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 5,
      grandTotal: 45,
      shippingMethod: 'STANDARD',
      shipRecipientName: 'Pat Doe',
      shipAddressLine1: '1 Test Street',
      shipCity: 'Testville',
      shipState: 'TS',
      shipPostalCode: '12345',
      shipCountry: 'US',
      promotionId,
    },
  });
}

beforeAll(async () => {
  admin = await tokenFor('ROLE_ADMIN');
});

describe('promotions admin', () => {
  it('creates a code (upper-cased) and rejects a duplicate', async () => {
    const c = code();
    const res = await as().post('/api/admin/promotions', {
      code: c.toLowerCase(),
      description: '10% off',
      type: 'PERCENT',
      value: 10,
      minSubtotal: 25,
      firstOrderOnly: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: c.toUpperCase(),
      type: 'PERCENT',
      value: 10,
      minSubtotal: 25,
      firstOrderOnly: true,
      active: true,
      state: 'ACTIVE',
      timesUsed: 0,
      usageLimit: null,
    });
    const dup = await as().post('/api/admin/promotions', { code: c, description: 'again', type: 'FIXED', value: 5 });
    expect(dup.status).toBe(409);
  });

  it('validates the fields and the value for the type', async () => {
    const res = await as().post('/api/admin/promotions', { code: 'bad code!', type: 'BOGO' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.data).sort()).toEqual(['code', 'description', 'type']);
    const pct = await as().post('/api/admin/promotions', { code: code(), description: 'x', type: 'PERCENT', value: 150 });
    expect(pct.body.data).toEqual({ value: 'Enter a percentage between 1 and 100' });
    const fixed = await as().post('/api/admin/promotions', { code: code(), description: 'x', type: 'FIXED' });
    expect(fixed.body.data).toEqual({ value: 'Enter an amount greater than 0' });
    const window = await as().post('/api/admin/promotions', {
      code: code(),
      description: 'x',
      type: 'FREE_SHIPPING',
      startsAt: '2026-12-01T00:00:00Z',
      endsAt: '2026-11-01T00:00:00Z',
    });
    expect(window.body.data).toEqual({ endsAt: 'must be after the start date' });
    const badDate = await as().post('/api/admin/promotions', { code: code(), description: 'x', type: 'FREE_SHIPPING', endsAt: 'soon' });
    expect(badDate.body.data).toEqual({ endsAt: 'must be a valid date' });
  });

  it('updates, clears limits, counts usage and deactivates', async () => {
    const c = code();
    const created = await as().post('/api/admin/promotions', {
      code: c,
      description: '$5 off',
      type: 'FIXED',
      value: '5.00',
      usageLimit: 2,
    });
    const id = created.body.data.id;
    await orderWith(id, 'PAID');
    await orderWith(id, 'CANCELLED');

    const one = await as().get(`/api/admin/promotions/${id}`);
    expect(one.body.data).toMatchObject({ timesUsed: 1, state: 'ACTIVE' });
    await orderWith(id, 'DELIVERED');
    expect((await as().get(`/api/admin/promotions/${id}`)).body.data).toMatchObject({ timesUsed: 2, state: 'EXPIRED' });

    const patched = await as().patch(`/api/admin/promotions/${id}`, { usageLimit: null, description: '$5 off everything' });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ usageLimit: null, description: '$5 off everything', value: 5, state: 'ACTIVE' });

    // Switching to free shipping drops the amount.
    const ship = await as().patch(`/api/admin/promotions/${id}`, { type: 'FREE_SHIPPING' });
    expect(ship.body.data).toMatchObject({ type: 'FREE_SHIPPING', value: 0 });
    expect((await as().patch(`/api/admin/promotions/${id}`, { type: 'PERCENT' })).status).toBe(400);

    const later = await as().patch(`/api/admin/promotions/${id}`, { startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(later.body.data.state).toBe('SCHEDULED');

    const list = await as().get(`/api/admin/promotions?q=${c.toLowerCase()}`);
    expect(list.body.data.totalElements).toBe(1);
    expect(list.body.data.content[0]).toMatchObject({ id, timesUsed: 2 });

    const off = await as().delete(`/api/admin/promotions/${id}`);
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ active: false, state: 'INACTIVE' });
    expect((await prisma.promotion.findUnique({ where: { id } }))?.active).toBe(false);
    expect((await as().get(`/api/admin/promotions?q=${c}&active=true`)).body.data.totalElements).toBe(0);
    expect((await as().get(`/api/admin/promotions?q=${c}&active=false`)).body.data.totalElements).toBe(1);
    expect((await as().delete(`/api/admin/promotions/${randomUUID()}`)).status).toBe(404);
  });

  it('is admin only', async () => {
    const catalog = await tokenFor('ROLE_CATALOG');
    expect((await as(catalog).get('/api/admin/promotions')).status).toBe(403);
    expect((await as(catalog).post('/api/admin/promotions', {})).status).toBe(403);
    expect((await request(app).get('/api/admin/promotions')).status).toBe(401);
  });
});
