import { randomUUID } from 'node:crypto';
import type { PaymentGateway, PaymentInitiation } from './gateway';

/**
 * Default gateway when no provider is configured. Moves no money: the order
 * waits in PENDING_PAYMENT until an admin marks it paid, which stands in for a
 * provider callback.
 */
export class ManualPaymentGateway implements PaymentGateway {
  async initiate(): Promise<PaymentInitiation> {
    return { status: 'PENDING', reference: `MANUAL-${randomUUID()}`, clientSecret: null };
  }

  /** No money moved here; the operator returns funds out of band. */
  async refund(): Promise<string> {
    return `MANUAL-REFUND-${randomUUID()}`;
  }

  async cancelPayment(): Promise<boolean> {
    return true;
  }

  async findClientSecret(): Promise<string | null> {
    return null;
  }

  /** Manual orders legitimately wait for an admin, so they never expire. */
  supportsAutomaticExpiry() {
    return false;
  }

  supportsManualConfirmation() {
    return true;
  }
}
