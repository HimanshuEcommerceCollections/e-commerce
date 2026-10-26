import type { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PaymentGatewayError } from '../common/errors';
import { logger } from '../common/logger';
import type {
  PaymentGateway,
  PaymentInitiation,
  PaymentMethodDetails,
  PaymentRequest,
  SavedPaymentMethodVault,
  VaultedPaymentMethod,
} from './gateway';
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

  async refund(paymentReference: string, amount: Prisma.Decimal, currency: string, idempotencyKey?: string): Promise<string> {
    try {
      const refund = await this.stripe.refunds.create(
        { payment_intent: paymentReference, amount: Number(toMinorUnits(amount, currency)) },
        // Default: at most one full refund per intent, so a retried cancel can't
        // double-refund. Partial refunds (returns) pass a key per return.
        { idempotencyKey: idempotencyKey ?? `refund-${paymentReference}` },
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

  private vault?: StripeSavedPaymentMethods;

  /** Saved cards through Stripe customers and SetupIntents. */
  get savedPaymentMethods(): SavedPaymentMethodVault {
    return (this.vault ??= new StripeSavedPaymentMethods(this.stripe));
  }

  /**
   * The intent's payment method: a card (or a card in Apple Pay / Google Pay,
   * reported as WALLET) with brand and last 4, or PayPal.
   */
  async describePayment(paymentReference: string): Promise<PaymentMethodDetails | null> {
    const intent = await this.stripe.paymentIntents.retrieve(paymentReference, { expand: ['payment_method'] });
    const pm = intent.payment_method;
    if (!pm || typeof pm === 'string') return null;
    if (pm.type === 'card' && pm.card) {
      return { type: pm.card.wallet ? 'WALLET' : 'CARD', brand: pm.card.brand ?? null, last4: pm.card.last4 ?? null };
    }
    if (pm.type === 'paypal') return { type: 'PAYPAL', brand: null, last4: null };
    if (pm.type === 'link' || pm.type === 'cashapp' || pm.type === 'amazon_pay') return { type: 'WALLET', brand: pm.type, last4: null };
    return { type: 'CARD', brand: null, last4: null };
  }

  private async currentStatus(paymentReference: string): Promise<string | null> {
    try {
      return (await this.stripe.paymentIntents.retrieve(paymentReference)).status;
    } catch {
      return null;
    }
  }
}

/** The saved-payment-method half of the Stripe gateway (see SavedPaymentMethodVault). */
class StripeSavedPaymentMethods implements SavedPaymentMethodVault {
  readonly provider = 'stripe';

  constructor(private readonly stripe: Stripe) {}

  async createCustomer(input: { email: string; name: string; userId: string }): Promise<string> {
    return this.call('create a customer', async () => {
      const customer = await this.stripe.customers.create(
        { email: input.email, name: input.name, metadata: { userId: input.userId } },
        // One customer per user, even if two setup requests race.
        { idempotencyKey: `customer-${input.userId}` },
      );
      return customer.id;
    });
  }

  async createSetupIntent(customerId: string): Promise<string> {
    return this.call('create a SetupIntent', async () => {
      const intent = await this.stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        automatic_payment_methods: { enabled: true },
      });
      if (!intent.client_secret) throw new Error('SetupIntent without a client secret');
      return intent.client_secret;
    });
  }

  async retrievePaymentMethod(paymentMethodId: string): Promise<VaultedPaymentMethod | null> {
    try {
      const pm = await this.stripe.paymentMethods.retrieve(paymentMethodId);
      const customer = typeof pm.customer === 'string' ? pm.customer : (pm.customer?.id ?? null);
      return {
        id: pm.id,
        customerId: customer,
        type: pm.type === 'paypal' ? 'PAYPAL' : 'CARD',
        brand: pm.card?.brand ?? null,
        last4: pm.card?.last4 ?? null,
        expMonth: pm.card?.exp_month ?? null,
        expYear: pm.card?.exp_year ?? null,
        holderName: pm.billing_details?.name ?? null,
        email: pm.paypal?.payer_email ?? pm.billing_details?.email ?? null,
      };
    } catch (e) {
      if (e instanceof Stripe.errors.StripeInvalidRequestError && e.code === 'resource_missing') return null;
      log.error(`Stripe PaymentMethod retrieve failed for ${paymentMethodId}`, e);
      throw new PaymentGatewayError('Unable to look up the payment method', e);
    }
  }

  async attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<void> {
    await this.call('attach a payment method', () => this.stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }));
  }

  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.call('set the default payment method', () =>
      this.stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } }),
    );
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    try {
      await this.stripe.paymentMethods.detach(paymentMethodId);
    } catch (e) {
      // Already detached (or gone) is the outcome we wanted.
      if (e instanceof Stripe.errors.StripeInvalidRequestError) return;
      log.error(`Stripe PaymentMethod detach failed for ${paymentMethodId}`, e);
      throw new PaymentGatewayError('Unable to remove the payment method', e);
    }
  }

  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      log.error(`Stripe: unable to ${what}`, e);
      throw new PaymentGatewayError(`Unable to ${what}`, e);
    }
  }
}
