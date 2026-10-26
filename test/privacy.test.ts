import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Data export and account deletion (contract C13). */
const { app, prisma, fixtures } = harness();

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register() {
  const email = `priv-${randomUUID()}@test.local`;
  const res = await request(app).post('/api/auth/register').send({ email, password: 'first-pass1', fullName: 'Pri Vacy' });
  expect(res.status).toBe(201);
  return { email, token: res.body.data.accessToken as string, userId: res.body.data.userId as string };
}

async function newOrder(userId: string, status: string) {
  return prisma.order.create({
    data: {
      userId,
      orderNumber: `EC-${randomUUID().slice(0, 12)}`,
      status,
      currency: 'USD',
      subtotal: new Prisma.Decimal('10.00'),
      taxTotal: new Prisma.Decimal('0'),
      shippingTotal: new Prisma.Decimal('0'),
      discountTotal: new Prisma.Decimal('0'),
      grandTotal: new Prisma.Decimal('10.00'),
      shipRecipientName: 'Pri Vacy',
      shipAddressLine1: '1 Test Street',
      shipCity: 'Testville',
      shipState: 'CA',
      shipPostalCode: '94110',
      shipCountry: 'US',
    },
  });
}

describe('data export', () => {
  it('builds the export, emails a link, and reuses a recent one', async () => {
    const { token, userId } = await register();
    await fixtures.newAddress(userId);
    await newOrder(userId, 'DELIVERED');

    expect((await request(app).get('/api/users/me/data-export').set(bearer(token))).body.data).toBeUndefined();

    const res = await request(app).post('/api/users/me/data-export').set(bearer(token));
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'READY' });
    const again = await request(app).post('/api/users/me/data-export').set(bearer(token));
    expect(again.body.data.id).toBe(res.body.data.id);

    const latest = await request(app).get('/api/users/me/data-export').set(bearer(token));
    expect(latest.body.data).toMatchObject({ id: res.body.data.id, status: 'READY' });
    expect(latest.body.data.expiresAt).toBeTruthy();

    const mail = await prisma.notification.findFirstOrThrow({ where: { userId, template: 'DATA_EXPORT' } });
    const m = /data-export\/([0-9a-f-]{36})\?token=([A-Za-z0-9_-]+)/.exec(mail.body)!;
    expect(m[1]).toBe(res.body.data.id);

    const download = await request(app).get(`/api/users/me/data-export/${m[1]}/download?token=${m[2]}`).set(bearer(token));
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/attachment; filename="data-export-.*\.json"/);
    const data = JSON.parse(download.text);
    expect(data.profile.fullName).toBe('Pri Vacy');
    expect(data.addresses).toHaveLength(1);
    expect(data.orders).toHaveLength(1);
    expect(data).toHaveProperty('reviews');
    expect(data).toHaveProperty('savedItems');
    expect(data).toHaveProperty('storeCredit');

    expect((await request(app).get(`/api/users/me/data-export/${m[1]}/download?token=wrong`).set(bearer(token))).status).toBe(404);
    // Someone else can't use the link.
    const other = await register();
    expect((await request(app).get(`/api/users/me/data-export/${m[1]}/download?token=${m[2]}`).set(bearer(other.token))).status).toBe(404);
  });
});

describe('account deletion', () => {
  it('checks the confirmation word and the password', async () => {
    const { token } = await register();
    const word = await request(app).post('/api/users/me/delete').set(bearer(token)).send({ confirm: 'delete', password: 'first-pass1' });
    expect(word.status).toBe(400);
    expect(word.body.data.confirm).toBe('Type DELETE in capital letters.');
    const pw = await request(app).post('/api/users/me/delete').set(bearer(token)).send({ confirm: 'DELETE', password: 'wrong-pass1' });
    expect(pw.status).toBe(400);
    expect(pw.body.data.password).toBeTruthy();
  });

  it('is refused while an order is open', async () => {
    const { token, userId } = await register();
    await newOrder(userId, 'SHIPPED');
    const res = await request(app).post('/api/users/me/delete').set(bearer(token)).send({ confirm: 'DELETE', password: 'first-pass1' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("You have orders or returns in progress. You can delete your account once they're complete.");
  });

  it('is refused while a return is open', async () => {
    const { token, userId } = await register();
    const order = await newOrder(userId, 'DELIVERED');
    await prisma.orderReturn.create({
      data: { orderId: order.id, rmaNumber: `RMA-${randomUUID().slice(0, 8)}`, status: 'REQUESTED', reason: 'Too small', requestedBy: 'CUSTOMER' },
    });
    const res = await request(app).post('/api/users/me/delete').set(bearer(token)).send({ confirm: 'DELETE', password: 'first-pass1' });
    expect(res.status).toBe(409);
  });

  it('anonymises and disables the account, keeps orders, and forfeits credit', async () => {
    const { email, token, userId } = await register();
    const order = await newOrder(userId, 'DELIVERED');
    await fixtures.newAddress(userId);
    const product = await fixtures.newActiveProduct(5, '9.99');
    await prisma.savedItem.create({ data: { userId, productId: product.id, priceAtSave: new Prisma.Decimal('9.99') } });
    const admin = await fixtures.registerUser('ROLE_ADMIN');
    await request(app).post(`/api/admin/customers/${userId}/store-credit`).set(bearer(admin)).send({ amount: 15, description: 'Goodwill' });
    const second = await request(app).post('/api/auth/login').send({ email, password: 'first-pass1' });

    const res = await request(app).post('/api/users/me/delete').set(bearer(token)).send({ confirm: 'DELETE', password: 'first-pass1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ email });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({
      email: `deleted+${userId}@invalid`,
      fullName: 'Deleted user',
      phoneNumber: null,
      enabled: false,
    });
    expect(user.deletionRequestedAt).not.toBeNull();
    expect(user.storeCreditBalance.toFixed(2)).toBe('0.00');
    const forfeit = await prisma.storeCreditEntry.findFirstOrThrow({ where: { userId, type: 'FORFEIT' } });
    expect(forfeit.amount.toFixed(2)).toBe('-15.00');

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).userId).toBe(userId);
    expect(await prisma.userAddress.count({ where: { userId, deleted: false } })).toBe(0);
    expect(await prisma.savedItem.count({ where: { userId } })).toBe(0);
    expect(await prisma.userSession.count({ where: { userId, revokedAt: null } })).toBe(0);
    expect(await prisma.notification.count({ where: { toAddress: email, template: 'ACCOUNT_DELETED' } })).toBe(1);

    expect((await request(app).get('/api/users/me').set(bearer(token))).status).toBe(401);
    expect((await request(app).get('/api/users/me').set(bearer(second.body.data.accessToken))).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'first-pass1' })).status).toBe(401);
  });
});
