import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** 2-step verification by (log-only) text message, and login enforcement (contract C9). */
const { app, prisma } = harness();
const enforced = harness({ env: { TWO_FACTOR_ENFORCE: 'true' } });

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const phoneNumber = () => `+1 555 ${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

async function register(target = app, phone: string | null = phoneNumber()) {
  const email = `tfa-${randomUUID()}@test.local`;
  const res = await request(target)
    .post('/api/auth/register')
    .send({ email, password: 'first-pass1', fullName: 'Tia Factor', ...(phone ? { phoneNumber: phone } : {}) });
  expect(res.status).toBe(201);
  return { email, phone, token: res.body.data.accessToken as string, userId: res.body.data.userId as string };
}

/** The code from the latest OTP_CODE "text" to that phone. */
async function lastCode(phone: string) {
  const sms = await prisma.notification.findFirstOrThrow({
    where: { template: 'OTP_CODE', toAddress: phone },
    orderBy: { createdAt: 'desc' },
  });
  return /^(\d{6}) is your/.exec(sms.body)![1]!;
}

describe('enrolment', () => {
  it('needs a phone number', async () => {
    const { token } = await register(app, null);
    const res = await request(app).post('/api/users/me/2fa/start').set(bearer(token)).send({});
    expect(res.status).toBe(400);
    expect(res.body.data.phone).toBe('Add a mobile number in Profile first.');
  });

  it('texts a code to the profile phone, then turns on with the right code', async () => {
    const { token, phone } = await register();
    const start = await request(app).post('/api/users/me/2fa/start').set(bearer(token)).send({});
    expect(start.status).toBe(200);
    const digits = phone!.replace(/\D/g, '');
    expect(start.body.data.phoneMasked).toBe(`•••-•••-${digits.slice(-4)}`);
    const code = await lastCode(phone!);
    // Only a hash is stored.
    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: start.body.data.challengeId } });
    expect(row.codeHash).not.toContain(code);

    const wrongCode = code === '000000' ? '111111' : '000000';
    const wrong = await request(app).post('/api/users/me/2fa/confirm').set(bearer(token)).send({ challengeId: start.body.data.challengeId, code: wrongCode });
    expect(wrong.status).toBe(400);
    expect(wrong.body.data.code).toBe("That code didn't match. Try again.");

    const ok = await request(app).post('/api/users/me/2fa/confirm').set(bearer(token)).send({ challengeId: start.body.data.challengeId, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ twoFactorEnabled: true, twoFactorPhone: `•••-•••-${digits.slice(-4)}` });

    // Single use.
    const again = await request(app).post('/api/users/me/2fa/confirm').set(bearer(token)).send({ challengeId: start.body.data.challengeId, code });
    expect(again.status).toBe(400);

    const me = await request(app).get('/api/users/me').set(bearer(token));
    expect(me.body.data.twoFactorEnabled).toBe(true);

    const off = await request(app).delete('/api/users/me/2fa').set(bearer(token));
    expect(off.body.data).toMatchObject({ twoFactorEnabled: false, twoFactorPhone: null });
  });

  it('allows five tries, then the challenge is spent', async () => {
    const { token, phone } = await register();
    const start = await request(app).post('/api/users/me/2fa/start').set(bearer(token)).send({ phone: '+1 555 222 4821' });
    expect(start.body.data.phoneMasked).toBe('•••-•••-4821');
    const code = await lastCode('+1 555 222 4821');
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/users/me/2fa/confirm').set(bearer(token)).send({ challengeId: start.body.data.challengeId, code: wrongCode });
    }
    const late = await request(app).post('/api/users/me/2fa/confirm').set(bearer(token)).send({ challengeId: start.body.data.challengeId, code });
    expect(late.status).toBe(400);
    expect(late.body.data.code).toMatch(/Too many tries/);
    expect(phone).toBeTruthy();
  });

  it('an expired code is refused', async () => {
    const { token, phone } = await register();
    const start = await request(app).post('/api/users/me/2fa/start').set(bearer(token)).send({});
    await prisma.otpChallenge.update({ where: { id: start.body.data.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app)
      .post('/api/users/me/2fa/confirm')
      .set(bearer(token))
      .send({ challengeId: start.body.data.challengeId, code: await lastCode(phone!) });
    expect(res.status).toBe(400);
    expect(res.body.data.code).toMatch(/expired/);
  });
});

describe('login enforcement', () => {
  async function enrol(target: typeof app) {
    const user = await register(target);
    const start = await request(target).post('/api/users/me/2fa/start').set(bearer(user.token)).send({});
    await request(target)
      .post('/api/users/me/2fa/confirm')
      .set(bearer(user.token))
      .send({ challengeId: start.body.data.challengeId, code: await lastCode(user.phone!) });
    return user;
  }

  it('is off by default: an enrolled customer still gets a token', async () => {
    const { email } = await enrol(app);
    const res = await request(app).post('/api/auth/login').send({ email, password: 'first-pass1' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('with TWO_FACTOR_ENFORCE=true login asks for the code, and /login/verify signs in', async () => {
    const { email, phone } = await enrol(enforced.app);
    const first = await request(enforced.app).post('/api/auth/login').send({ email, password: 'first-pass1', rememberMe: false });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ twoFactorRequired: true });
    expect(first.body.data.accessToken).toBeUndefined();

    const bad = await request(enforced.app).post('/api/auth/login/verify').send({ challengeId: first.body.data.challengeId, code: 'abcdef' });
    expect(bad.status).toBe(400);

    const done = await request(enforced.app)
      .post('/api/auth/login/verify')
      .send({ challengeId: first.body.data.challengeId, code: await lastCode(phone!), rememberMe: false });
    expect(done.status).toBe(200);
    expect(done.body.data.email).toBe(email);
    expect(done.body.data.expiresIn).toBe(86_400_000);
    expect((await request(enforced.app).get('/api/users/me').set(bearer(done.body.data.accessToken))).status).toBe(200);
  });

  it('customers without 2-step sign in directly even when enforced', async () => {
    const { email } = await register(enforced.app);
    const res = await request(enforced.app).post('/api/auth/login').send({ email, password: 'first-pass1' });
    expect(res.body.data.accessToken).toBeTruthy();
  });
});
