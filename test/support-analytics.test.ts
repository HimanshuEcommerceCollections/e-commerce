import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Help center, seller applications (designs 10, 11) and analytics ingestion (FR-IN-05). */
const { app, prisma, fixtures } = harness();

describe('support messages', () => {
  it('stores the message, returns a ticket number and acknowledges by email', async () => {
    const email = `help-${randomUUID()}@test.local`;
    const res = await request(app)
      .post('/api/support/messages')
      .send({ name: 'Pat', email, topic: 'Order', orderNumber: 'ec4821907', message: 'Where is my parcel, please?' });
    expect(res.status).toBe(201);
    expect(res.body.data.ticketNumber).toMatch(/^T-\d{6}$/);
    const row = await prisma.supportMessage.findUniqueOrThrow({ where: { ticketNumber: res.body.data.ticketNumber } });
    expect(row).toMatchObject({ email, orderNumber: 'EC-4821907', status: 'OPEN' });
    expect(await prisma.notification.count({ where: { toAddress: email, template: 'SUPPORT_TICKET' } })).toBe(1);
  });

  it('validates every field', async () => {
    const res = await request(app).post('/api/support/messages').send({ email: 'bad', message: 'too short' });
    expect(res.status).toBe(400);
    expect(res.body.data).toEqual({
      name: 'Name is required',
      email: 'Must be a valid email address',
      topic: 'Topic is required',
      message: 'Message must be between 10 and 1500 characters',
    });
    const long = await request(app).post('/api/support/messages').send({ name: 'P', email: 'p@test.local', topic: 'x', message: 'x'.repeat(1501) });
    expect(long.status).toBe(400);
  });
});

describe('seller applications', () => {
  const valid = () => ({
    fullName: 'Sam Seller',
    email: `sell-${randomUUID()}@test.local`,
    phone: '+1 (503) 555-0199',
    categories: ['Home & Kitchen', 'Lifestyle'],
    products: 'Handmade ceramics',
    street: '1 Kiln Rd',
    city: 'Portland',
    state: 'OR',
    postalCode: '97214',
    consent: true,
  });

  it('stores the application and returns a reference', async () => {
    const body = valid();
    const res = await request(app).post('/api/seller-applications').send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.reference).toMatch(/^SA-\d{5}$/);
    const row = await prisma.sellerApplication.findUniqueOrThrow({ where: { reference: res.body.data.reference } });
    expect(row).toMatchObject({ email: body.email, categories: body.categories, status: 'NEW' });
    expect(await prisma.notification.count({ where: { toAddress: body.email, template: 'SELLER_APPLICATION' } })).toBe(1);
  });

  it('needs consent, at least one category and a valid phone', async () => {
    const res = await request(app)
      .post('/api/seller-applications')
      .send({ ...valid(), consent: false, categories: [], phone: 'call me' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.data).sort()).toEqual(['categories', 'consent', 'phone']);
  });
});

describe('analytics events', () => {
  it('stores a batch (202) and attaches the signed-in user', async () => {
    const token = await fixtures.registerUser();
    const user = await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    const sessionId = `s-${randomUUID()}`;
    const productId = randomUUID();
    const res = await request(app)
      .post('/api/analytics/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        events: [
          { eventType: 'PRODUCT_VIEW', sessionId, productId, path: '/product/x' },
          { eventType: 'ADD_TO_CART', sessionId, productId, value: 19.99, currency: 'usd', properties: { quantity: 1 } },
          { eventType: 'SEARCH', sessionId, properties: { q: 'mug' } },
        ],
      });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ accepted: 3 });
    const rows = await prisma.analyticsEvent.findMany({ where: { sessionId }, orderBy: { eventType: 'asc' } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.userId === user.id)).toBe(true);
    expect(rows.find((r) => r.eventType === 'ADD_TO_CART')).toMatchObject({ currency: 'USD', properties: { quantity: 1 } });
  });

  it('anonymous events are fine; PURCHASE, unknown types and big batches are not', async () => {
    const sessionId = `s-${randomUUID()}`;
    const ok = await request(app).post('/api/analytics/events').send({ events: [{ eventType: 'CHECKOUT_START', sessionId }] });
    expect(ok.status).toBe(202);
    expect((await prisma.analyticsEvent.findFirstOrThrow({ where: { sessionId } })).userId).toBeNull();

    expect((await request(app).post('/api/analytics/events').send({ events: [{ eventType: 'PURCHASE', sessionId }] })).status).toBe(400);
    expect((await request(app).post('/api/analytics/events').send({ events: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 26 }, () => ({ eventType: 'PRODUCT_VIEW', sessionId }));
    expect((await request(app).post('/api/analytics/events').send({ events: tooMany })).status).toBe(400);
  });
});
