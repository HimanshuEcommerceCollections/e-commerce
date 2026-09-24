import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { PaymentGateway, PaymentInitiation } from '../../src/payment/gateway';

/**
 * Test double that records gateway calls and lets a test script the outcome of
 * cancel ("payment is mid-flight") and expiry support. Otherwise behaves like
 * a provider that hands out a client secret.
 */
export class RecordingPaymentGateway implements PaymentGateway {
  readonly refunds: { paymentReference: string; amount: Prisma.Decimal; currency: string }[] = [];
  readonly cancelledReferences: string[] = [];
  cancellable = true;
  supportsExpiry = true;
  manualConfirmation = true;

  reset() {
    this.refunds.length = 0;
    this.cancelledReferences.length = 0;
    this.cancellable = true;
    this.supportsExpiry = true;
    this.manualConfirmation = true;
  }

  async initiate(): Promise<PaymentInitiation> {
    return { status: 'PENDING', reference: `TEST-${randomUUID()}`, clientSecret: 'test-client-secret' };
  }

  async refund(paymentReference: string, amount: Prisma.Decimal, currency: string) {
    this.refunds.push({ paymentReference, amount, currency });
    return `TEST-REFUND-${randomUUID()}`;
  }

  async cancelPayment(paymentReference: string) {
    if (!this.cancellable) return false;
    this.cancelledReferences.push(paymentReference);
    return true;
  }

  async findClientSecret() {
    return 'test-client-secret';
  }

  supportsAutomaticExpiry() {
    return this.supportsExpiry;
  }

  supportsManualConfirmation() {
    return this.manualConfirmation;
  }
}
