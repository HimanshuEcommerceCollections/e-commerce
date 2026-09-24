import type { Prisma } from '@prisma/client';
import type { PaymentStatus } from '../common/enums';

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
   * Refund a captured payment in full; returns the gateway's refund reference.
   * Throws PaymentGatewayError on failure — callers must then change nothing.
   */
  refund(paymentReference: string, amount: Prisma.Decimal, currency: string): Promise<string>;

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
