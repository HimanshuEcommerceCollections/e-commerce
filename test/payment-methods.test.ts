import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { SavedPaymentMethodVault, VaultedPaymentMethod } from '../src/payment/gateway';
import { harness } from './support/harness';
import { RecordingPaymentGateway } from './support/recording-gateway';

/** Saved payment methods (contract C12): 501 under the manual gateway, vaulted otherwise. */

/** In-memory stand-in for Stripe customers and payment methods. */
class FakeVault implements SavedPaymentMethodVault {
  readonly provider = 'stripe';
  readonly methods = new Map<string, VaultedPaymentMethod>();
  readonly defaults = new Map<string, string>();
  readonly detached: string[] = [];

  async createCustomer() {
    return `cus_${randomUUID().replace(/-/g, '')}`;
  }
  async createSetupIntent(customerId: string) {
    return `seti_secret_for_${customerId}`;
  }
  async retrievePaymentMethod(id: string) {
    return this.methods.get(id) ?? null;
  }
  async attachPaymentMethod(id: string, customerId: string) {
    this.methods.get(id)!.customerId = customerId;
  }
  async setDefaultPaymentMethod(customerId: string, id: string) {
    this.defaults.set(customerId, id);
  }
  async detachPaymentMethod(id: string) {
    this.detached.push(id);
  }
  /** What the browser's confirmed SetupIntent would leave behind. */
  card(last4: string): string {
    const id = `pm_${randomUUID().replace(/-/g, '')}`;
    this.methods.set(id, {
      id,
      customerId: null,
      type: 'CARD',
      brand: 'visa',
      last4,
      expMonth: 12,
      expYear: 2030,
      holderName: 'Pay Ment',
      email: null,
    });
    return id;
  }
}

class VaultGateway extends RecordingPaymentGateway {
  readonly savedPaymentMethods = new FakeVault();
}

const manual = harness();
const gateway = new VaultGateway();
const vaulted = harness({ gateway });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('without a vault (manual gateway)', () => {
  it('every route answers 501', async () => {
    const token = await manual.fixtures.registerUser();
    for (const [method, path] of [
      ['get', '/api/users/me/payment-methods'],
      ['post', '/api/users/me/payment-methods/setup-intent'],
    ] as const) {
      const res = await request(manual.app)[method](path).set(bearer(token));
      expect(res.status).toBe(501);
      expect(res.body.message).toBe("Saved payment methods aren't available yet.");
    }
    expect(manual.container.paymentMethods.available).toBe(false);
  });
});

describe('with a vault', () => {
  it('saves cards by provider id, keeps one default, and removes them', async () => {
    const { app, prisma } = vaulted;
    const token = await vaulted.fixtures.registerUser();
    expect(vaulted.container.paymentMethods.available).toBe(true);

    const setup = await request(app).post('/api/users/me/payment-methods/setup-intent').set(bearer(token));
    expect(setup.status).toBe(200);
    expect(setup.body.data.clientSecret).toMatch(/^seti_secret_for_cus_/);

    const first = await request(app)
      .post('/api/users/me/payment-methods')
      .set(bearer(token))
      .send({ providerPaymentMethodId: gateway.savedPaymentMethods.card('4242') });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ type: 'CARD', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true });

    const second = await request(app)
      .post('/api/users/me/payment-methods')
      .set(bearer(token))
      .send({ providerPaymentMethodId: gateway.savedPaymentMethods.card('1111'), makeDefault: true });
    expect(second.body.data.isDefault).toBe(true);

    let list = await request(app).get('/api/users/me/payment-methods').set(bearer(token));
    expect(list.body.data.map((m: { last4: string; isDefault: boolean }) => [m.last4, m.isDefault])).toEqual([
      ['1111', true],
      ['4242', false],
    ]);

    await request(app).patch(`/api/users/me/payment-methods/${first.body.data.id}/default`).set(bearer(token));
    const del = await request(app).delete(`/api/users/me/payment-methods/${first.body.data.id}`).set(bearer(token));
    expect(del.status).toBe(200);
    list = await request(app).get('/api/users/me/payment-methods').set(bearer(token));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ last4: '1111', isDefault: true });
    expect(gateway.savedPaymentMethods.detached).toHaveLength(1);

    const id = (await request(app).get('/api/users/me').set(bearer(token))).body.data.id;
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.stripeCustomerId).toMatch(/^cus_/);
  });

  it('never accepts card numbers or another customer’s card', async () => {
    const { app } = vaulted;
    const token = await vaulted.fixtures.registerUser();
    const raw = await request(app).post('/api/users/me/payment-methods').set(bearer(token)).send({ providerPaymentMethodId: '4242424242424242' });
    expect(raw.status).toBe(400);

    const other = await vaulted.fixtures.registerUser();
    const theirs = gateway.savedPaymentMethods.card('9999');
    expect((await request(app).post('/api/users/me/payment-methods').set(bearer(other)).send({ providerPaymentMethodId: theirs })).status).toBe(201);
    const stolen = await request(app).post('/api/users/me/payment-methods').set(bearer(token)).send({ providerPaymentMethodId: theirs });
    expect(stolen.status).toBe(400);
  });
});
