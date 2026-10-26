import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { describeDevice } from '../src/account/sessions.user-agent';
import { harness } from './support/harness';

/** Sessions, "keep me signed in", sign-out and the device list (contract C8). */
const { app, prisma, container } = harness();

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register() {
  const email = `sess-${randomUUID()}@test.local`;
  const res = await request(app)
    .post('/api/auth/register')
    .set('User-Agent', CHROME_WINDOWS)
    .send({ email, password: 'first-pass1', fullName: 'Sam Session' });
  expect(res.status).toBe(201);
  return { email, token: res.body.data.accessToken as string };
}

const login = (email: string, ua = SAFARI_IPHONE, extra: object = {}) =>
  request(app).post('/api/auth/login').set('User-Agent', ua).send({ email, password: 'first-pass1', ...extra });

describe('device labels', () => {
  it('names common browsers and systems', () => {
    expect(describeDevice(CHROME_WINDOWS)).toEqual({ label: 'Chrome on Windows', deviceType: 'DESKTOP' });
    expect(describeDevice(SAFARI_IPHONE)).toEqual({ label: 'Safari on iPhone', deviceType: 'PHONE' });
    expect(
      describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0'),
    ).toMatchObject({ label: 'Edge on Windows' });
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0')).toMatchObject({
      label: 'Firefox on Mac',
      deviceType: 'DESKTOP',
    });
    expect(
      describeDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'),
    ).toEqual({ label: 'Chrome on Android', deviceType: 'PHONE' });
    expect(describeDevice(undefined)).toEqual({ label: 'Unknown device', deviceType: 'DESKTOP' });
    expect(describeDevice('curl/8.4.0')).toEqual({ label: 'Unknown device', deviceType: 'DESKTOP' });
  });
});

describe('sign-in sessions', () => {
  it('login puts a sid in the token; rememberMe picks the lifetime; expiresAt is returned', async () => {
    const { email } = await register();
    const remembered = await login(email);
    expect(remembered.status).toBe(200);
    expect(remembered.body.data.expiresIn).toBe(30 * 24 * 3_600_000);
    expect(Date.parse(remembered.body.data.expiresAt)).toBeGreaterThan(Date.now() + 29 * 24 * 3_600_000);
    const claims = container.jwt.verifyClaims(remembered.body.data.accessToken)!;
    expect(claims.email).toBe(email);
    expect(claims.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const short = await login(email, SAFARI_IPHONE, { rememberMe: false });
    expect(short.body.data.expiresIn).toBe(86_400_000);
  });

  it('lists devices with the current one first, and signs one out', async () => {
    const { email, token: desktop } = await register();
    const phone = (await login(email)).body.data.accessToken as string;

    const list = await request(app).get('/api/users/me/sessions').set(bearer(phone));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[0]).toMatchObject({ label: 'Safari on iPhone', deviceType: 'PHONE', current: true, location: null });
    expect(list.body.data[1]).toMatchObject({ label: 'Chrome on Windows', deviceType: 'DESKTOP', current: false });

    const del = await request(app).delete(`/api/users/me/sessions/${list.body.data[1].id}`).set(bearer(phone));
    expect(del.status).toBe(200);
    expect((await request(app).get('/api/users/me').set(bearer(desktop))).status).toBe(401);
    expect((await request(app).get('/api/users/me').set(bearer(phone))).status).toBe(200);

    // Someone else's session id is a 404.
    const other = await register();
    const theirs = await request(app).get('/api/users/me/sessions').set(bearer(other.token));
    expect((await request(app).delete(`/api/users/me/sessions/${theirs.body.data[0].id}`).set(bearer(phone))).status).toBe(404);
  });

  it('revoke-others keeps only the current device; logout ends the current one', async () => {
    const { email, token: first } = await register();
    const second = (await login(email)).body.data.accessToken as string;
    const third = (await login(email)).body.data.accessToken as string;

    const res = await request(app).post('/api/users/me/sessions/revoke-others').set(bearer(third));
    expect(res.body.data.revoked).toBe(2);
    expect((await request(app).get('/api/users/me').set(bearer(first))).status).toBe(401);
    expect((await request(app).get('/api/users/me').set(bearer(second))).status).toBe(401);

    expect((await request(app).post('/api/auth/logout').set(bearer(third))).status).toBe(200);
    expect((await request(app).get('/api/users/me').set(bearer(third))).status).toBe(401);
    expect((await request(app).post('/api/auth/logout')).status).toBe(401);
  });

  it('legacy tokens without a sid keep working', async () => {
    const { email } = await register();
    const legacy = container.jwt.generateToken(email);
    expect(container.jwt.verifyClaims(legacy)!.sessionId).toBeNull();
    expect((await request(app).get('/api/users/me').set(bearer(legacy))).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set(bearer(legacy))).status).toBe(200);
  });

  it('a forged sid or another user’s session is refused', async () => {
    const a = await register();
    const b = await register();
    const bSid = container.jwt.verifyClaims(b.token)!.sessionId!;
    const mixed = container.jwt.generateToken(a.email, { sessionId: bSid });
    expect((await request(app).get('/api/users/me').set(bearer(mixed))).status).toBe(401);
    const junk = container.jwt.generateToken(a.email, { sessionId: 'not-a-uuid' });
    expect((await request(app).get('/api/users/me').set(bearer(junk))).status).toBe(401);
  });

  it('touches lastSeenAt at most every five minutes', async () => {
    const { token } = await register();
    const sid = container.jwt.verifyClaims(token)!.sessionId!;
    const recent = new Date(Date.now() - 60_000);
    await prisma.userSession.update({ where: { id: sid }, data: { lastSeenAt: recent } });
    await request(app).get('/api/users/me').set(bearer(token));
    expect((await prisma.userSession.findUniqueOrThrow({ where: { id: sid } })).lastSeenAt.getTime()).toBe(recent.getTime());

    const stale = new Date(Date.now() - 10 * 60_000);
    await prisma.userSession.update({ where: { id: sid }, data: { lastSeenAt: stale } });
    await request(app).get('/api/users/me').set(bearer(token));
    expect((await prisma.userSession.findUniqueOrThrow({ where: { id: sid } })).lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe('password change and other devices', () => {
  it('signOutOtherDevices=false keeps other sessions and passwordChangedAt', async () => {
    const { email, token: desktop } = await register();
    const phone = (await login(email)).body.data.accessToken as string;
    const res = await request(app)
      .post('/api/users/me/password')
      .set(bearer(phone))
      .send({ currentPassword: 'first-pass1', newPassword: 'second-pass2', signOutOtherDevices: false });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/users/me').set(bearer(desktop))).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).passwordChangedAt).toBeNull();
    // The same session continues.
    expect(container.jwt.verifyClaims(res.body.data.accessToken)!.sessionId).toBe(container.jwt.verifyClaims(phone)!.sessionId);
  });

  it('by default revokes other sessions and returns a token for this one', async () => {
    const { email, token: desktop } = await register();
    const phone = (await login(email)).body.data.accessToken as string;
    await wait(1100); // JWT issue times have whole-second precision
    const res = await request(app)
      .post('/api/users/me/password')
      .set(bearer(phone))
      .send({ currentPassword: 'first-pass1', newPassword: 'second-pass2' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/users/me').set(bearer(desktop))).status).toBe(401);
    expect((await request(app).get('/api/users/me').set(bearer(phone))).status).toBe(401); // older than the change
    const fresh = res.body.data.accessToken as string;
    expect((await request(app).get('/api/users/me').set(bearer(fresh))).status).toBe(200);
    const sessions = await request(app).get('/api/users/me/sessions').set(bearer(fresh));
    expect(sessions.body.data).toHaveLength(1);
    expect(sessions.body.data[0].current).toBe(true);
  });
});
