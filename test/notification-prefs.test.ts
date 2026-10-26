import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Email and text preferences (contract C10). */
const { app, prisma } = harness();

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(extra: object = {}) {
  const email = `prefs-${randomUUID()}@test.local`;
  const res = await request(app).post('/api/auth/register').send({ email, password: 'first-pass1', fullName: 'Pat Prefs', ...extra });
  expect(res.status).toBe(201);
  return { email, token: res.body.data.accessToken as string };
}

describe('notification preferences', () => {
  it('starts from the defaults, with deals from the marketing opt-in', async () => {
    const { token } = await register({ marketingOptIn: true });
    const res = await request(app).get('/api/users/me/notification-preferences').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      orderUpdates: true,
      deals: true,
      newArrivals: false,
      priceDrops: true,
      backInStock: true,
      reviewReminders: true,
      smsDelivery: false,
      phone: null,
    });
  });

  it('PATCH changes only the keys sent; deals is the marketing flag', async () => {
    const { email, token } = await register();
    const res = await request(app)
      .patch('/api/users/me/notification-preferences')
      .set(bearer(token))
      .send({ deals: true, newArrivals: true, priceDrops: false, orderUpdates: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderUpdates: true, deals: true, newArrivals: true, priceDrops: false, backInStock: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).marketingOptIn).toBe(true);

    const again = await request(app).get('/api/users/me/notification-preferences').set(bearer(token));
    expect(again.body.data).toMatchObject({ deals: true, newArrivals: true, priceDrops: false });

    const bad = await request(app).patch('/api/users/me/notification-preferences').set(bearer(token)).send({ deals: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('text updates need a phone number', async () => {
    const { token } = await register();
    const res = await request(app).patch('/api/users/me/notification-preferences').set(bearer(token)).send({ smsDelivery: true });
    expect(res.status).toBe(400);
    expect(res.body.data.smsDelivery).toBe('Add a mobile number in Profile first.');

    const phone = `+1 555 ${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    await request(app).patch('/api/users/me').set(bearer(token)).send({ phoneNumber: phone });
    const ok = await request(app).patch('/api/users/me/notification-preferences').set(bearer(token)).send({ smsDelivery: true });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ smsDelivery: true, phone });
  });

  it('unsubscribe-all turns off every marketing email but not texts or order updates', async () => {
    const phone = `+1 555 ${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const { token } = await register({ marketingOptIn: true, phoneNumber: phone });
    await request(app).patch('/api/users/me/notification-preferences').set(bearer(token)).send({ smsDelivery: true, newArrivals: true });
    const res = await request(app).post('/api/users/me/notification-preferences/unsubscribe-all').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      orderUpdates: true,
      deals: false,
      newArrivals: false,
      priceDrops: false,
      backInStock: false,
      reviewReminders: false,
      smsDelivery: true,
      phone,
    });
  });

  it('needs a token', async () => {
    expect((await request(app).get('/api/users/me/notification-preferences')).status).toBe(401);
  });
});
