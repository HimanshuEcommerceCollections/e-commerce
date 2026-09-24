import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WebhookEventNotFoundError, WebhookEventNotReplayableError } from '../src/common/errors';
import type { PaymentEventHandler } from '../src/payment/gateway';
import { StripeWebhookService } from '../src/payment/webhook/webhook.service';
import { harness } from './support/harness';
import { RecordingPaymentGateway } from './support/recording-gateway';

const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_checks';

const { container } = harness();
const store = container.webhookStore;

/** Minimal Stripe event payload. */
const succeededPayload = (eventId: string, intentId = 'pi_test_1', amount = 5000) =>
  JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'payment_intent.succeeded',
    api_version: '2025-01-01',
    data: { object: { id: intentId, object: 'payment_intent', amount, currency: 'usd' } },
  });

class StubHandler implements PaymentEventHandler {
  failNext = false;
  readonly confirmed: string[] = [];
  async confirmPaymentByIntent(paymentIntentId: string) {
    if (this.failNext) throw new Error('simulated handler failure');
    this.confirmed.push(paymentIntentId);
  }
  async recordPaymentFailureByIntent() {}
  async cancelPaymentByIntent() {}
  async recordRefundByIntent() {}
}

/** Idempotency and durability of the event store. (WebhookEventStoreIT) */
describe('webhook event store', () => {
  it('first delivery inserts; later deliveries see the status', async () => {
    const eventId = `evt_${randomUUID()}`;
    expect(await store.recordReceived(eventId, 'payment_intent.succeeded', '{}')).toBeNull(); // new — dispatch
    expect(await store.recordReceived(eventId, 'payment_intent.succeeded', '{}')).toBe('RECEIVED'); // in flight
    await store.markProcessed(eventId);
    expect(await store.recordReceived(eventId, 'payment_intent.succeeded', '{}')).toBe('PROCESSED'); // done
  });

  it('a failed event keeps its payload and error for replay', async () => {
    const eventId = `evt_${randomUUID()}`;
    await store.recordReceived(eventId, 'charge.refunded', '{"raw":true}');
    await store.markFailed(eventId, 'boom');
    const stored = (await store.find(eventId))!;
    expect(stored.status).toBe('FAILED');
    expect(stored.errorMessage).toBe('boom');
    expect(stored.payload).toBe('{"raw":true}');
    expect(stored.processedAt).not.toBeNull();
  });
});

/** No webhook event can be silently lost. (StripeWebhookReplayIT) */
describe('webhook replay', () => {
  it('a failed dispatch is stored for replay, and replay succeeds once fixed', async () => {
    const handler = new StubHandler();
    const service = new StripeWebhookService(handler, store, WEBHOOK_SECRET, 0);
    const eventId = `evt_${randomUUID()}`;
    await store.recordReceived(eventId, 'payment_intent.succeeded', succeededPayload(eventId));

    handler.failNext = true;
    await service.replay(eventId);
    const afterFailure = (await store.find(eventId))!;
    expect(afterFailure.status).toBe('FAILED');
    expect(afterFailure.errorMessage).toContain('simulated handler failure');
    expect(afterFailure.payload).not.toBeNull();

    handler.failNext = false;
    await service.replay(eventId);
    expect((await store.find(eventId))!.status).toBe('PROCESSED');
    expect(handler.confirmed).toEqual(['pi_test_1']);

    // Replaying a PROCESSED event would double-apply it.
    await expect(service.replay(eventId)).rejects.toBeInstanceOf(WebhookEventNotReplayableError);
  });

  it('a payload-less marker row is not replayable', async () => {
    const service = new StripeWebhookService(new StubHandler(), store, WEBHOOK_SECRET);
    const eventId = `evt_${randomUUID()}`;
    await store.recordReceived(eventId, 'payment_intent.succeeded', null);
    await store.markFailed(eventId, 'old marker');
    await expect(service.replay(eventId)).rejects.toBeInstanceOf(WebhookEventNotReplayableError);
  });

  it('replay of an unknown event is a 404', async () => {
    const service = new StripeWebhookService(new StubHandler(), store, WEBHOOK_SECRET);
    await expect(service.replay('evt_does_not_exist')).rejects.toBeInstanceOf(WebhookEventNotFoundError);
  });

  it('a fresh in-flight event cannot be concurrently redispatched', async () => {
    const eventId = `evt_${randomUUID()}`;
    await store.recordReceived(eventId, 'payment_intent.succeeded', succeededPayload(eventId));
    // RECEIVED and within its lease: a second dispatcher is refused…
    expect(await store.claimForRedispatch(eventId, new Date(Date.now() - 300_000))).toBe(false);
    // …until the lease has run out.
    expect(await store.claimForRedispatch(eventId, new Date(Date.now() + 1_000))).toBe(true);
  });
});

/** The webhook endpoint end to end, with real Stripe signatures. */
describe('Stripe webhook endpoint', () => {
  const gateway = new RecordingPaymentGateway();
  gateway.manualConfirmation = false;
  const stripe = harness({
    gateway,
    env: { PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
  });

  const sign = (payload: string) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

  it('rejects a bad signature with 400 and stores nothing', async () => {
    const eventId = `evt_${randomUUID()}`;
    const res = await request(stripe.app)
      .post('/api/payments/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=forged')
      .send(succeededPayload(eventId));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid Stripe webhook signature');
    expect(await store.find(eventId)).toBeNull();
  });

  it('a signed payment_intent.succeeded marks the order paid, once', async () => {
    const { fixtures, container: c, prisma } = stripe;
    const user = await fixtures.newCustomer();
    const product = await fixtures.newActiveProduct(10, '25.00');
    await fixtures.addToCart(user.id, product.id, 2);
    const placed = await c.orders.checkout(user.id, { addressId: (await fixtures.newAddress(user.id)).id }, null);
    const intentId = (await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } })).paymentIntentId!;

    const eventId = `evt_${randomUUID()}`;
    const payload = succeededPayload(eventId, intentId, 5000);
    for (let delivery = 0; delivery < 2; delivery++) {
      const res = await request(stripe.app)
        .post('/api/payments/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sign(payload))
        .send(payload);
      expect(res.status).toBe(200);
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } })).status).toBe('PAID');
    expect((await store.find(eventId))!.status).toBe('PROCESSED');
  });

  it('an amount mismatch is acknowledged but stored FAILED for replay', async () => {
    const { fixtures, container: c, prisma } = stripe;
    const user = await fixtures.newCustomer();
    const product = await fixtures.newActiveProduct(10, '25.00');
    await fixtures.addToCart(user.id, product.id, 2);
    const placed = await c.orders.checkout(user.id, { addressId: (await fixtures.newAddress(user.id)).id }, null);
    const intentId = (await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } })).paymentIntentId!;

    const eventId = `evt_${randomUUID()}`;
    const payload = succeededPayload(eventId, intentId, 1);
    const res = await request(stripe.app)
      .post('/api/payments/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sign(payload))
      .send(payload);
    expect(res.status).toBe(200);
    const stored = (await store.find(eventId))!;
    expect(stored.status).toBe('FAILED');
    expect(stored.errorMessage).toContain('Payment amount mismatch');
  });

  it('admin replay requires authentication', async () => {
    const res = await request(stripe.app).post('/api/payments/stripe/webhook-events/evt_x/replay');
    expect(res.status).toBe(401);
  });
});
