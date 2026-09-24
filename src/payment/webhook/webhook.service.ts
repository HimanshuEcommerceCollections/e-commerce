import Stripe from 'stripe';
import {
  WebhookEventNotFoundError,
  WebhookEventNotReplayableError,
  WebhookVerificationError,
} from '../../common/errors';
import { logger } from '../../common/logger';
import type { PaymentEventHandler } from '../gateway';
import type { WebhookEventStore } from './event-store';

const log = logger('stripe-webhook');

interface StoredEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Verifies and processes Stripe webhook events, deliberately in separate steps:
 *  1. signature verification — the only failure answered with 400; anything
 *     after a valid signature is acknowledged 200, so no storable event is lost;
 *  2. the event is stored RECEIVED (the idempotency check, and a durable row
 *     even if processing then fails);
 *  3. dispatch to the order module. Errors mark the event FAILED rather than
 *     answering 4xx (Stripe would stop retrying) or 5xx (a poison event would
 *     retry forever); FAILED events are replayed by an admin.
 */
export class StripeWebhookService {
  constructor(
    private readonly handler: PaymentEventHandler,
    private readonly store: WebhookEventStore,
    private readonly webhookSecret: string,
    private readonly inflightLeaseSeconds = 300,
  ) {}

  /**
   * Fails fast on a missing or placeholder signing secret: with it, anyone could
   * forge a payment_intent.succeeded and mark their order PAID for free.
   */
  static requireRealSecret(secret: string) {
    if (!secret || secret.includes('REPLACE')) {
      throw new Error(
        "PAYMENT_PROVIDER=stripe requires STRIPE_WEBHOOK_SECRET to be set to the endpoint's real signing secret (whsec_…)",
      );
    }
  }

  /** @param payload the raw body exactly as received (the signature covers its bytes) */
  async process(payload: Buffer, signature: string | undefined) {
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(payload, signature ?? '', this.webhookSecret);
    } catch {
      throw new WebhookVerificationError('Invalid Stripe webhook signature');
    }

    const raw = payload.toString('utf8');
    const existing = await this.store.recordReceived(event.id, event.type, raw);
    if (existing === null) {
      await this.dispatchAndRecord(event as unknown as StoredEvent);
      return;
    }
    if (existing === 'PROCESSED') {
      log.info(`Skipping already-processed Stripe event ${event.id}`);
      return;
    }
    // FAILED is always reclaimable; RECEIVED only past its in-flight lease.
    if (await this.store.claimForRedispatch(event.id, this.leaseCutoff())) {
      await this.dispatchAndRecord(event as unknown as StoredEvent);
    } else {
      log.info(`Stripe event ${event.id} is already being processed — skipping duplicate`);
    }
  }

  /** Re-dispatch a stored event from its payload (verified when it was stored). */
  async replay(eventId: string) {
    const stored = await this.store.find(eventId);
    if (!stored) throw new WebhookEventNotFoundError(eventId);
    if (stored.status === 'PROCESSED') throw new WebhookEventNotReplayableError(eventId, 'it was already processed');
    if (stored.payload === null) throw new WebhookEventNotReplayableError(eventId, 'no payload was stored for it');
    if (!(await this.store.claimForRedispatch(eventId, this.leaseCutoff()))) {
      throw new WebhookEventNotReplayableError(eventId, 'it is currently being processed — retry shortly');
    }
    await this.dispatchAndRecord(JSON.parse(stored.payload) as StoredEvent);
  }

  private leaseCutoff() {
    return new Date(Date.now() - this.inflightLeaseSeconds * 1000);
  }

  private async dispatchAndRecord(event: StoredEvent) {
    try {
      await this.dispatch(event);
      await this.store.markProcessed(event.id);
    } catch (e) {
      log.error(`Processing Stripe event ${event.id} (${event.type}) failed — stored as FAILED for replay`, e);
      await this.store.markFailed(event.id, e instanceof Error ? e.message : String(e));
    }
  }

  private async dispatch(event: StoredEvent) {
    const obj = event.data?.object ?? {};
    const str = (k: string) => {
      const v = obj[k];
      if (typeof v !== 'string') throw new Error(`Event ${event.id} data object has no '${k}'`);
      return v;
    };
    const minor = (k: string) => {
      const v = obj[k];
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`Event ${event.id} data object has no '${k}'`);
      return BigInt(v);
    };

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handler.confirmPaymentByIntent(str('id'), minor('amount'), str('currency'));
        break;
      case 'payment_intent.payment_failed':
        await this.handler.recordPaymentFailureByIntent(str('id'));
        break;
      case 'payment_intent.canceled':
        await this.handler.cancelPaymentByIntent(str('id'));
        break;
      case 'charge.refunded':
        // Carries a Charge, and also fires for partial refunds, so the handler
        // gets the cumulative amount_refunded to compare with the order total.
        await this.handler.recordRefundByIntent(str('payment_intent'), minor('amount_refunded'), str('currency'));
        break;
      default:
        log.debug(`Ignoring unhandled Stripe event type ${event.type}`);
    }
  }
}
