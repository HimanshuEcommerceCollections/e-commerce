import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Admin inbox (contract D1): support messages, seller applications, badge counts, form hardening. */
const { app, prisma, container, fixtures } = harness();

let admin: string;
let adminEmail: string;

/** A staff token without going through registration. */
async function tokenFor(role: 'ROLE_ADMIN' | 'ROLE_CATALOG' | 'ROLE_CUSTOMER') {
  const user = await prisma.user.create({
    data: { email: `staff-${randomUUID()}@test.local`, password: 'x', fullName: 'Staff Member', role },
  });
  return { token: container.jwt.generateToken(user.email), email: user.email };
}

const as = (token = admin) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
});

beforeAll(async () => {
  ({ token: admin, email: adminEmail } = await tokenFor('ROLE_ADMIN'));
});

const message = (over: Record<string, unknown> = {}) => ({
  name: 'Pat Doe',
  email: `help-${randomUUID()}@test.local`,
  topic: 'Where is my order?',
  message: 'My parcel has not arrived yet.',
  ...over,
});

const application = (over: Record<string, unknown> = {}) => ({
  fullName: 'Sam Seller',
  email: `sell-${randomUUID()}@test.local`,
  phone: '(503) 555-0199',
  categories: ['Home & Kitchen'],
  products: 'Handmade ceramics',
  street: '1 Kiln Rd',
  city: 'Portland',
  state: 'Oregon',
  postalCode: '97214',
  consent: true,
  ...over,
});

describe('public form validation', () => {
  it('accepts only the help center topics', async () => {
    const ok = await request(app).post('/api/support/messages').send(message({ topic: 'returns and refunds' }));
    expect(ok.status).toBe(201);
    const row = await prisma.supportMessage.findUniqueOrThrow({ where: { ticketNumber: ok.body.data.ticketNumber } });
    expect(row.topic).toBe('Returns and refunds');

    const bad = await request(app).post('/api/support/messages').send(message({ topic: 'Order' }));
    expect(bad.status).toBe(400);
    expect(bad.body.data).toEqual({ topic: 'Choose a topic.' });
  });

  it('normalises state and phone and records consent', async () => {
    const res = await request(app).post('/api/seller-applications').send(application({ phone: '+1 503.555.0199' }));
    expect(res.status).toBe(201);
    const row = await prisma.sellerApplication.findUniqueOrThrow({ where: { reference: res.body.data.reference } });
    expect(row).toMatchObject({ state: 'OR', phone: '(503) 555-0199', postalCode: '97214' });
    expect(row.consentAt).toBeInstanceOf(Date);
  });

  it("reports the tightened checks with the form's own messages", async () => {
    const res = await request(app)
      .post('/api/seller-applications')
      .send(application({ postalCode: '9721', state: 'Ontario', phone: '555-0199', products: 'ab' }));
    expect(res.status).toBe(400);
    expect(res.body.data).toEqual({
      postalCode: 'Enter a 5-digit ZIP',
      state: 'Select a state',
      phone: 'Enter a 10-digit US phone number',
      products: 'Tell us which products you want to sell',
    });
  });

  it('reports a bad category under categories[i] and categories', async () => {
    const res = await request(app).post('/api/seller-applications').send(application({ categories: ['Toys', ' '] }));
    expect(res.status).toBe(400);
    expect(res.body.data).toEqual({ 'categories[1]': 'Category must not be blank', categories: 'Category must not be blank' });
  });
});

describe('support messages inbox', () => {
  const tag = randomUUID().slice(0, 8);
  let ids: string[] = [];

  beforeAll(async () => {
    const order = await prisma.order.create({
      data: {
        customerEmail: `o-${tag}@test.local`,
        orderNumber: `EC-${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
        status: 'PAID',
        currency: 'USD',
        subtotal: 10,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 10,
        shippingMethod: 'STANDARD',
        shipRecipientName: 'Pat Doe',
        shipAddressLine1: '1 Test Street',
        shipCity: 'Testville',
        shipState: 'TS',
        shipPostalCode: '12345',
        shipCountry: 'US',
      },
    });
    ids = [];
    for (const [i, extra] of [{}, { orderNumber: order.orderNumber }, { name: `Lee ${tag}` }].entries()) {
      const res = await request(app)
        .post('/api/support/messages')
        .send(message({ email: `inbox-${i}-${tag}@test.local`, ...extra }));
      expect(res.status).toBe(201);
      ids.push((await prisma.supportMessage.findUniqueOrThrow({ where: { ticketNumber: res.body.data.ticketNumber } })).id);
    }
  });

  it('lists newest first, searches and paginates', async () => {
    const res = await as().get(`/api/admin/support-messages?q=${tag}&size=2`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalElements: 3, totalPages: 2, size: 2, number: 0 });
    expect(res.body.data.content.map((m: { id: string }) => m.id)).toEqual([ids[2], ids[1]]);
    expect(res.body.data.content[0]).toMatchObject({
      status: 'OPEN',
      adminNote: null,
      handledBy: null,
      updatedAt: null,
      name: `Lee ${tag}`,
      topic: 'Where is my order?',
    });
    const page2 = await as().get(`/api/admin/support-messages?q=${tag}&size=2&page=1`);
    expect(page2.body.data.content.map((m: { id: string }) => m.id)).toEqual([ids[0]]);

    const ticket = res.body.data.content[1].ticketNumber;
    const byTicket = await as().get(`/api/admin/support-messages?q=${ticket.toLowerCase()}`);
    expect(byTicket.body.data.content.map((m: { id: string }) => m.id)).toEqual([ids[1]]);
  });

  it('shows the detail with the quoted order', async () => {
    const res = await as().get(`/api/admin/support-messages/${ids[1]}`);
    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toEqual(expect.any(String));
    expect(res.body.data.message).toBe('My parcel has not arrived yet.');
    expect((await as().get(`/api/admin/support-messages/${ids[0]}`)).body.data.orderId).toBeNull();
    expect((await as().get(`/api/admin/support-messages/${randomUUID()}`)).status).toBe(404);
    expect((await as().get('/api/admin/support-messages/nope')).status).toBe(400);
  });

  it('updates status and note, recording who and when', async () => {
    const res = await as().patch(`/api/admin/support-messages/${ids[0]}`, { status: 'IN_PROGRESS', adminNote: 'Asked the carrier' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'IN_PROGRESS', adminNote: 'Asked the carrier', handledBy: adminEmail });
    expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const noteOnly = await as().patch(`/api/admin/support-messages/${ids[0]}`, { adminNote: '  ' });
    expect(noteOnly.body.data).toMatchObject({ status: 'IN_PROGRESS', adminNote: null });

    const filtered = await as().get(`/api/admin/support-messages?q=${tag}&status=IN_PROGRESS`);
    expect(filtered.body.data.content.map((m: { id: string }) => m.id)).toEqual([ids[0]]);

    expect((await as().patch(`/api/admin/support-messages/${ids[0]}`, { status: 'DONE' })).body.data).toEqual({
      status: 'must be one of OPEN, IN_PROGRESS, CLOSED',
    });
    expect((await as().patch(`/api/admin/support-messages/${ids[0]}`, {})).status).toBe(400);
    expect((await as().get('/api/admin/support-messages?status=DONE')).status).toBe(400);
    expect((await as().patch(`/api/admin/support-messages/${randomUUID()}`, { status: 'CLOSED' })).status).toBe(404);
  });
});

describe('seller applications inbox', () => {
  const tag = randomUUID().slice(0, 8);
  let id: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/seller-applications').send(application({ fullName: `Ceramics ${tag}` }));
    id = (await prisma.sellerApplication.findUniqueOrThrow({ where: { reference: res.body.data.reference } })).id;
  });

  it('lists, shows and updates applications', async () => {
    const list = await as().get(`/api/admin/seller-applications?q=${tag}&status=NEW`);
    expect(list.status).toBe(200);
    expect(list.body.data.totalElements).toBe(1);
    expect(list.body.data.content[0]).toMatchObject({
      id,
      fullName: `Ceramics ${tag}`,
      state: 'OR',
      categories: ['Home & Kitchen'],
      status: 'NEW',
      consentAt: expect.any(String),
    });
    expect((await as().get(`/api/admin/seller-applications/${id}`)).body.data.reference).toMatch(/^SA-\d{5}$/);

    const res = await as().patch(`/api/admin/seller-applications/${id}`, { status: 'CONTACTED', adminNote: 'Call booked' });
    expect(res.body.data).toMatchObject({ status: 'CONTACTED', adminNote: 'Call booked', handledBy: adminEmail });
    expect((await as().get(`/api/admin/seller-applications?q=${tag}&status=NEW`)).body.data.totalElements).toBe(0);
    expect((await as().patch(`/api/admin/seller-applications/${id}`, { status: 'OPEN' })).status).toBe(400);
  });
});

describe('inbox counts', () => {
  it('counts open messages, new applications, pending reviews and submissions awaiting review', async () => {
    const before = (await as().get('/api/admin/inbox/counts')).body.data;

    await request(app).post('/api/support/messages').send(message());
    await request(app).post('/api/seller-applications').send(application());
    const product = await fixtures.newActiveProduct(5, '10.00');
    // One review per customer and product, so a new reviewer each time.
    const review = async (status: string, deleted = false) =>
      prisma.productReview.create({
        data: { parentId: product.parentId!, productId: product.id, userId: (await fixtures.newCustomer()).id, rating: 5, title: 'Nice', body: 'x'.repeat(20), status, deleted },
      });
    await review('PENDING');
    await review('PENDING', true);
    await review('PUBLISHED');
    const merchant = await fixtures.newCustomer();
    for (const status of ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED']) {
      const p = await fixtures.newActiveProduct(1, '1.00');
      await prisma.productSubmission.create({
        data: {
          reference: `PS-${randomUUID().slice(0, 8)}`,
          merchantId: merchant.id,
          parentProductId: p.parentId!,
          kind: 'EDIT',
          status,
          source: 'FORM',
          submittedAt: new Date(),
        },
      });
    }

    const after = await as().get('/api/admin/inbox/counts');
    expect(after.status).toBe(200);
    expect(after.body.data).toEqual({
      supportOpen: before.supportOpen + 1,
      sellerApplicationsNew: before.sellerApplicationsNew + 1,
      reviewsPending: before.reviewsPending + 1,
      submissionsOpen: before.submissionsOpen + 2,
    });
  });
});

describe('access', () => {
  it('is admin only', async () => {
    const { token: catalog } = await tokenFor('ROLE_CATALOG');
    const { token: customer } = await tokenFor('ROLE_CUSTOMER');
    for (const url of ['/api/admin/inbox/counts', '/api/admin/support-messages', '/api/admin/seller-applications']) {
      expect((await as(catalog).get(url)).status).toBe(403);
      expect((await as(customer).get(url)).status).toBe(403);
      expect((await request(app).get(url)).status).toBe(401);
    }
  });
});

describe('rate limiting', () => {
  const limited = harness({
    env: { RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_AUTH_CAPACITY: '2', RATE_LIMIT_AUTH_REFILL_PER_MINUTE: '1' },
  });

  it('throttles the public forms per client', async () => {
    expect((await request(limited.app).post('/api/support/messages').send(message())).status).toBe(201);
    expect((await request(limited.app).post('/api/seller-applications').send(application())).status).toBe(201);
    expect((await request(limited.app).post('/api/support/messages').send(message())).status).toBe(429);
    expect((await request(limited.app).post('/api/seller-applications').send(application())).status).toBe(429);
  });
});
