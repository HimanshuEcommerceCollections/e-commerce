import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Registration, profile, password change and reset (design 07/08). */
const { app, prisma } = harness();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(extra: object = {}) {
  const email = `acct-${randomUUID()}@test.local`;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'first-pass1', fullName: 'Alex Account', ...extra });
  return { email, res };
}

describe('registration', () => {
  it('works without a phone number and records the marketing choice', async () => {
    const { email, res } = await register({ marketingOptIn: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email, phoneNumber: null, role: 'ROLE_CUSTOMER' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.marketingOptIn).toBe(true);
    expect(await prisma.notification.count({ where: { userId: user.id, template: 'ACCOUNT_CREATED' } })).toBe(1);
  });

  it('needs a letter and a digit in the password', async () => {
    for (const password of ['allletters', '1234567890']) {
      const { res } = await register({ password });
      expect(res.status).toBe(400);
      expect(res.body.data.password).toBe('Password must contain at least one letter and one digit');
    }
  });
});

describe('profile', () => {
  it('reads and updates details; an email change needs the password and returns a new token', async () => {
    const { email, res } = await register();
    const token = res.body.data.accessToken;

    const me = await request(app).get('/api/users/me').set(bearer(token));
    expect(me.body.data).toMatchObject({ email, fullName: 'Alex Account', phoneNumber: null, marketingOptIn: false });

    const renamed = await request(app).patch('/api/users/me').set(bearer(token)).send({ fullName: 'Alex B', marketingOptIn: true, phoneNumber: '+1 555 010 2030' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ profile: { fullName: 'Alex B', marketingOptIn: true, phoneNumber: '+1 555 010 2030' }, auth: null });

    const newEmail = `acct-${randomUUID()}@test.local`;
    const noPassword = await request(app).patch('/api/users/me').set(bearer(token)).send({ email: newEmail });
    expect(noPassword.status).toBe(400);

    const moved = await request(app).patch('/api/users/me').set(bearer(token)).send({ email: newEmail, currentPassword: 'first-pass1' });
    expect(moved.status).toBe(200);
    expect(moved.body.data.profile.email).toBe(newEmail);
    expect(moved.body.data.auth.email).toBe(newEmail);
    // Tokens are keyed by email: the old one no longer resolves.
    expect((await request(app).get('/api/users/me').set(bearer(token))).status).toBe(401);
    expect((await request(app).get('/api/users/me').set(bearer(moved.body.data.auth.accessToken))).status).toBe(200);
  });
});

describe('password change', () => {
  it('signs out older tokens and returns a working one', async () => {
    const { email, res } = await register();
    const oldToken = res.body.data.accessToken;
    await wait(1100); // JWT issue times have whole-second precision

    const wrong = await request(app).post('/api/users/me/password').set(bearer(oldToken)).send({ currentPassword: 'nope-nope1', newPassword: 'second-pass2' });
    expect(wrong.status).toBe(400);

    const changed = await request(app).post('/api/users/me/password').set(bearer(oldToken)).send({ currentPassword: 'first-pass1', newPassword: 'second-pass2' });
    expect(changed.status).toBe(200);
    expect((await request(app).get('/api/users/me').set(bearer(oldToken))).status).toBe(401);
    expect((await request(app).get('/api/users/me').set(bearer(changed.body.data.accessToken))).status).toBe(200);

    expect((await request(app).post('/api/auth/login').send({ email, password: 'first-pass1' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'second-pass2' })).status).toBe(200);
  });
});

describe('password reset', () => {
  const tokenFromMail = async (userId: string) => {
    const mail = await prisma.notification.findFirstOrThrow({ where: { userId, template: 'PASSWORD_RESET' }, orderBy: { createdAt: 'desc' } });
    const m = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.body);
    return m![1];
  };

  it('always answers 200; a valid link sets the password once and signs out other sessions', async () => {
    const { email, res } = await register();
    const oldToken = res.body.data.accessToken;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    const unknown = await request(app).post('/api/auth/password-reset/request').send({ email: `nobody-${randomUUID()}@test.local` });
    expect(unknown.status).toBe(200);

    const asked = await request(app).post('/api/auth/password-reset/request').send({ email });
    expect(asked.status).toBe(200);
    expect(asked.body.message).toBe(unknown.body.message);
    const token = await tokenFromMail(user.id);
    expect(await prisma.passwordResetToken.count({ where: { tokenHash: token } })).toBe(0); // only the hash is stored

    await wait(1100);
    const weak = await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);

    const done = await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'reset-pass3' });
    expect(done.status).toBe(200);
    expect(done.body.data.email).toBe(email);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'reset-pass3' })).status).toBe(200);
    expect((await request(app).get('/api/users/me').set(bearer(oldToken))).status).toBe(401);
    expect((await request(app).get('/api/users/me').set(bearer(done.body.data.accessToken))).status).toBe(200);

    const reused = await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'again-pass4' });
    expect(reused.status).toBe(400);
  });

  it('an expired or superseded link is refused', async () => {
    const { email } = await register();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await request(app).post('/api/auth/password-reset/request').send({ email });
    const first = await tokenFromMail(user.id);
    await wait(5);
    await request(app).post('/api/auth/password-reset/request').send({ email });
    const second = await tokenFromMail(user.id);
    expect(second).not.toBe(first);

    expect((await request(app).post('/api/auth/password-reset/confirm').send({ token: first, newPassword: 'reset-pass3' })).status).toBe(400);

    await prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/auth/password-reset/confirm').send({ token: second, newPassword: 'reset-pass3' })).status).toBe(400);
  });
});
