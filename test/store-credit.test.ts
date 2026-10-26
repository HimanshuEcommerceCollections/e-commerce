import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Store credit, gift card redeem, admin gift cards and manual credit (contract C11). */
const { app, prisma, fixtures } = harness();

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function newGiftCard(adminToken: string, amount: number | string = 25) {
  const res = await request(app).post('/api/admin/gift-cards').set(bearer(adminToken)).send({ amount });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; code: string; pin: string; amount: number };
}

const userIdOf = async (token: string) => (await request(app).get('/api/users/me').set(bearer(token))).body.data.id as string;

describe('admin gift cards', () => {
  it('shows the code and PIN once and stores only hashes', async () => {
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    const card = await newGiftCard(admin, '50.00');
    expect(card.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(card.pin).toMatch(/^\d{4}$/);
    expect(card.amount).toBe(50);

    const row = await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } });
    const plain = card.code.replace(/-/g, '');
    expect(row.codeHash).toBe(createHash('sha256').update(plain).digest('hex'));
    expect(row.pinHash).not.toContain(card.pin);
    expect(row.last4).toBe(plain.slice(-4));

    const list = await request(app).get('/api/admin/gift-cards?page=0').set(bearer(admin));
    expect(list.status).toBe(200);
    const listed = list.body.data.content.find((g: { id: string }) => g.id === card.id);
    expect(listed).toMatchObject({ maskedCode: `••••-••••-••••-${row.last4}`, status: 'ACTIVE' });
    expect(JSON.stringify(list.body)).not.toContain(plain);
  });

  it('is admin only, and validates the amount', async () => {
    const customer = await fixtures.registerUser();
    const catalog = await fixtures.registerUser('ROLE_CATALOG');
    expect((await request(app).post('/api/admin/gift-cards').set(bearer(customer)).send({ amount: 10 })).status).toBe(403);
    expect((await request(app).get('/api/admin/gift-cards').set(bearer(catalog))).status).toBe(403);
    expect((await request(app).post('/api/admin/gift-cards').send({ amount: 10 })).status).toBe(401);
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    expect((await request(app).post('/api/admin/gift-cards').set(bearer(admin)).send({ amount: -5 })).status).toBe(400);
  });
});

describe('redeeming a gift card', () => {
  it('adds the amount to store credit once; dashes and case are ignored', async () => {
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    const card = await newGiftCard(admin, 25);
    const customer = await fixtures.registerUser();

    const res = await request(app)
      .post('/api/users/me/store-credit/redeem')
      .set(bearer(customer))
      .send({ code: card.code.toLowerCase().replace(/-/g, ' '), pin: card.pin });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ added: 25, balance: 25 });
    expect(res.text).toContain('"added":25.00');

    const again = await request(app).post('/api/users/me/store-credit/redeem').set(bearer(customer)).send({ code: card.code, pin: card.pin });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('This gift card has already been added.');

    const credit = await request(app).get('/api/users/me/store-credit').set(bearer(customer));
    expect(credit.status).toBe(200);
    expect(credit.body.data).toMatchObject({ balance: 25, pendingFromReturns: 0, currency: 'USD' });
    expect(credit.body.data.activity).toHaveLength(1);
    expect(credit.body.data.activity[0]).toMatchObject({ amount: 25, type: 'GIFT_CARD' });

    const profile = await request(app).get('/api/users/me').set(bearer(customer));
    expect(profile.body.data.storeCreditBalance).toBe(25);
    const userId = await userIdOf(customer);
    expect(await prisma.notification.count({ where: { userId, template: 'GIFT_CARD' } })).toBe(1);
  });

  it('a wrong PIN or unknown number is a 404; a malformed one a 400', async () => {
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    const card = await newGiftCard(admin);
    const customer = await fixtures.registerUser();
    const wrongPin = String((Number(card.pin) + 1) % 10_000).padStart(4, '0');
    const wrong = await request(app).post('/api/users/me/store-credit/redeem').set(bearer(customer)).send({ code: card.code, pin: wrongPin });
    expect(wrong.status).toBe(404);
    expect(wrong.body.message).toBe("We couldn't find a gift card with that number and PIN.");
    const unknown = await request(app)
      .post('/api/users/me/store-credit/redeem')
      .set(bearer(customer))
      .send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', pin: '1234' });
    expect(unknown.status).toBe(404);
    const malformed = await request(app).post('/api/users/me/store-credit/redeem').set(bearer(customer)).send({ code: 'ABC', pin: '12' });
    expect(malformed.status).toBe(400);
    expect(Object.keys(malformed.body.data).sort()).toEqual(['code', 'pin']);
  });

  it('is rate limited to five tries per 15 minutes per customer', async () => {
    const customer = await fixtures.registerUser();
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/users/me/store-credit/redeem')
        .set(bearer(customer))
        .send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', pin: '0000' });
      expect(res.status).toBe(404);
    }
    const throttled = await request(app)
      .post('/api/users/me/store-credit/redeem')
      .set(bearer(customer))
      .send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', pin: '0000' });
    expect(throttled.status).toBe(429);
    // Another customer has their own allowance.
    const other = await fixtures.registerUser();
    expect(
      (await request(app).post('/api/users/me/store-credit/redeem').set(bearer(other)).send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', pin: '0000' })).status,
    ).toBe(404);
  });

  it('an expired card is not found', async () => {
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    const card = await newGiftCard(admin);
    await prisma.giftCard.update({ where: { id: card.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const customer = await fixtures.registerUser();
    expect(
      (await request(app).post('/api/users/me/store-credit/redeem').set(bearer(customer)).send({ code: card.code, pin: card.pin })).status,
    ).toBe(404);
  });
});

describe('admin manual credit', () => {
  it('adds and removes credit, never below zero', async () => {
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    const customer = await fixtures.registerUser();
    const id = await userIdOf(customer);

    const add = await request(app)
      .post(`/api/admin/customers/${id}/store-credit`)
      .set(bearer(admin))
      .send({ amount: '10.50', description: 'Sorry for the delay' });
    expect(add.status).toBe(200);
    expect(add.body.data.balance).toBe(10.5);
    expect(add.body.data.entry).toMatchObject({ type: 'GOODWILL', description: 'Sorry for the delay' });

    const tooMuch = await request(app).post(`/api/admin/customers/${id}/store-credit`).set(bearer(admin)).send({ amount: -20, description: 'Fix' });
    expect(tooMuch.status).toBe(409);

    const take = await request(app).post(`/api/admin/customers/${id}/store-credit`).set(bearer(admin)).send({ amount: -0.5, description: 'Correction' });
    expect(take.body.data).toMatchObject({ balance: 10, entry: { type: 'ADJUSTMENT', amount: -0.5 } });

    const zero = await request(app).post(`/api/admin/customers/${id}/store-credit`).set(bearer(admin)).send({ amount: 0, description: 'x' });
    expect(zero.status).toBe(400);
    expect((await request(app).post(`/api/admin/customers/${id}/store-credit`).set(bearer(customer)).send({ amount: 5, description: 'x' })).status).toBe(403);

    const credit = await request(app).get('/api/users/me/store-credit').set(bearer(customer));
    expect(credit.body.data.balance).toBe(10);
    expect(credit.body.data.activity.map((a: { type: string }) => a.type)).toEqual(['ADJUSTMENT', 'GOODWILL']);

    // The admin customer page shows the balance next to the adjust form.
    const detail = await request(app).get(`/api/admin/customers/${id}`).set(bearer(admin));
    expect(detail.body.data.storeCreditBalance).toBe(10);
  });
});
