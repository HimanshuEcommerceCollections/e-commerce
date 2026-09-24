import type { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PaymentGatewayError } from '../common/errors';
import { logger } from '../common/logger';
import type { PaymentGateway, PaymentInitiation, PaymentRequest } from './gateway';
import { toMinorUnits } from './money-units';

const log = logger('stripe');

/** PaymentIntent statuses meaning "too late to cancel — money is moving or moved". */
const NOT_CANCELLABLE = new Set(['succeeded', 'processing', 'requires_capture']);

/**
 * Stripe-backed gateway. `initiate` creates a PaymentIntent and returns its
 * client secret for Stripe Elements; the order stays PENDING_PAYMENT until the
 * webhook reports the outcome.
 */
export class StripePaymentGateway implements PaymentGateway {
  private readonly stripe: Stripe;

  constructor(secretKey: string, timeoutMs: number) {
    // Fail fast: a missing key would otherwise surface as a 502 on the first checkout.
    if (!secretKey || secretKey.includes('REPLACE')) {
      throw new Error('PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY to be set');
    }
    // Tight timeout: checkout calls Stripe while holding stock row locks, so the
    // SDK default would let one latency spike stall every checkout of a product.
    this.stripe = new Stripe(secretKey, { timeout: timeoutMs, maxNetworkRetries: 0 });
  }

  async initiate(request: PaymentRequest): Promise<PaymentInitiation> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: Number(toMinorUnits(request.amount, request.currency)),
          currency: request.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: { orderNumber: request.orderNumber },
        },
        // Scoped to the order: a retried checkout reuses the same intent.
        { idempotencyKey: `order-${request.orderNumber}` },
      );
      return { status: 'PENDING', reference: intent.id, clientSecret: intent.client_secret };
    } catch (e) {
      log.error(`Stripe PaymentIntent creation failed for order ${request.orderNumber}`, e);
      throw new PaymentGatewayError('Unable to initiate payment', e);
    }
  }

  async refund(paymentReference: string, amount: Prisma.Decimal, currency: string): Promise<string> {
    try {
      const refund = await this.stripe.refunds.create(
        { payment_intent: paymentReference, amount: Number(toMinorUnits(amount, currency)) },
        // At most one full refund per intent, so a retried cancel can't double-refund.
        { idempotencyKey: `refund-${paymentReference}` },
      );
      return refund.id;
    } catch (e) {
      log.error(`Stripe refund failed for intent ${paymentReference}`, e);
      throw new PaymentGatewayError('Unable to refund payment', e);
    }
  }

  async cancelPayment(paymentReference: string): Promise<boolean> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(paymentReference);
      if (intent.status === 'canceled') return true;
      if (NOT_CANCELLABLE.has(intent.status)) return false;
      await this.stripe.paymentIntents.cancel(paymentReference);
      return true;
    } catch (e) {
      // The cancel can race the customer completing payment; re-check first.
      const status = await this.currentStatus(paymentReference);
      if (status && NOT_CANCELLABLE.has(status)) return false;
      if (status === 'canceled') return true;
      log.error(`Stripe PaymentIntent cancel failed for intent ${paymentReference}`, e);
      throw new PaymentGatewayError('Unable to cancel payment', e);
    }
  }

  async findClientSecret(paymentReference: string): Promise<string | null> {
    try {
      return (await this.stripe.paymentIntents.retrieve(paymentReference)).client_secret;
    } catch (e) {
      log.error(`Stripe PaymentIntent retrieve failed for intent ${paymentReference}`, e);
      throw new PaymentGatewayError('Unable to look up payment', e);
    }
  }

  /** Abandoned Stripe checkouts hold reserved stock until expired. */
  supportsAutomaticExpiry() {
    return true;
  }

  /** Stripe reports outcomes by webhook; marking by hand would diverge from the money. */
  supportsManualConfirmation() {
    return false;
  }

  private async currentStatus(paymentReference: string): Promise<string | null> {
    try {
      return (await this.stripe.paymentIntents.retrieve(paymentReference)).status;
    } catch {
      return null;
    }
  }
}
