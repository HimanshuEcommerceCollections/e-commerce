import type { Prisma } from '@prisma/client';
import type { PaymentMethodType, PaymentStatus } from '../common/enums';

/** Gateway-agnostic charge instruction (primitives only — payment never depends on order). */
export interface PaymentRequest {
  orderNumber: string;
  /** Major units, e.g. dollars. */
  amount: Prisma.Decimal;
  currency: string;
}

export interface PaymentInitiation {
  status: PaymentStatus;
  /** Gateway reference for reconciliation (manual id or Stripe PaymentIntent id). */
  reference: string | null;
  /** Secret the client confirms the payment with; null for the manual gateway. */
  clientSecret: string | null;
}

/**
 * A payment provider. The order flow depends only on this interface; the
 * implementation is chosen by PAYMENT_PROVIDER.
 */
export interface PaymentGateway {
  initiate(request: PaymentRequest): Promise<PaymentInitiation>;

  /**
   * Refund `amount` of a captured payment (all of it, or part for a return);
   * returns the gateway's refund reference. Throws PaymentGatewayError on
   * failure — callers must then change nothing.
   * @param idempotencyKey one key per refund decision, so a retry never pays
   *        twice; defaults to one key per payment (a single full refund).
   */
  refund(paymentReference: string, amount: Prisma.Decimal, currency: string, idempotencyKey?: string): Promise<string>;

  /**
   * Cancel an uncaptured payment so it can never be confirmed later.
   * @returns true if cancelled (or already was); false if it can no longer be
   *          cancelled because it is processing or succeeded — back off and let
   *          the success webhook win.
   */
  cancelPayment(paymentReference: string): Promise<boolean>;

  /** Re-fetch the client secret for a pending payment (never persisted); null if none. */
  findClientSecret(paymentReference: string): Promise<string | null>;

  /** Whether abandoned PENDING_PAYMENT orders may be auto-expired (Stripe: yes; manual: no). */
  supportsAutomaticExpiry(): boolean;

  /** Whether an admin may mark payment by hand (manual only — never override a real provider). */
  supportsManualConfirmation(): boolean;

  /**
   * Saved cards ("Payment methods" in the account), when the provider can
   * vault them; null or absent when it can't (manual). Card numbers never
   * reach the server: the browser confirms a SetupIntent with the provider.
   */
  readonly savedPaymentMethods?: SavedPaymentMethodVault | null;

  /**
   * How a succeeded payment was made, for the order's "Visa •••• 4242" line.
   * Optional: a gateway without it leaves the order's payment method empty.
   */
  describePayment?(paymentReference: string): Promise<PaymentMethodDetails | null>;
}

/** orders.payment_method_type / card_brand / card_last4. */
export interface PaymentMethodDetails {
  type: PaymentMethodType;
  /** visa, mastercard, amex, discover, … (cards and wallets only). */
  brand: string | null;
  last4: string | null;
}

/** A vaulted payment method as the provider reports it. */
export interface VaultedPaymentMethod {
  id: string;
  /** Provider customer it is attached to; null when not attached yet. */
  customerId: string | null;
  /** CARD | PAYPAL | ... */
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  holderName: string | null;
  email: string | null;
}

/** Provider-side customer and card vault (Stripe customers + SetupIntents). Errors throw PaymentGatewayError. */
export interface SavedPaymentMethodVault {
  /** Provider name stored on saved_payment_methods.provider. */
  readonly provider: string;
  createCustomer(input: { email: string; name: string; userId: string }): Promise<string>;
  /** A SetupIntent for the customer; returns its client secret. */
  createSetupIntent(customerId: string): Promise<string>;
  /** null when the provider doesn't know the id. */
  retrievePaymentMethod(paymentMethodId: string): Promise<VaultedPaymentMethod | null>;
  attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<void>;
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
}

/**
 * Callbacks for verified provider events (Stripe webhooks). Implemented by the
 * order module. Must be idempotent: webhooks are delivered at least once.
 */
export interface PaymentEventHandler {
  /** A payment succeeded. Implementations validate amount and currency first. */
  confirmPaymentByIntent(paymentIntentId: string, amountMinor: bigint, currency: string): Promise<void>;
  /** An attempt failed. NOT terminal: record it; never cancel or restock. */
  recordPaymentFailureByIntent(paymentIntentId: string): Promise<void>;
  /** The intent was cancelled at the provider. No-op if the order is already cancelled. */
  cancelPaymentByIntent(paymentIntentId: string): Promise<void>;
  /** Money went back to the customer; `amountRefundedMinor` is cumulative. */
  recordRefundByIntent(paymentIntentId: string, amountRefundedMinor: bigint, currency: string): Promise<void>;
}
