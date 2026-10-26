import type { PrismaClient, SavedPaymentMethod, User } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { requiredString, ValidationError } from '../common/validation';
import { TX } from '../db';
import type { PaymentGateway, SavedPaymentMethodVault } from '../payment/gateway';

export class SavedPaymentMethodsUnavailableError extends DomainError {
  constructor() {
    super(501, "Saved payment methods aren't available yet.");
  }
}
export class PaymentMethodNotFoundError extends DomainError {
  constructor() {
    super(404, 'That payment method was not found');
  }
}

/** Only a provider id ("pm_…") is accepted — never card details. */
export const PaymentMethodAddSchema = z.object({
  providerPaymentMethodId: requiredString({
    blankMessage: 'providerPaymentMethodId is required',
    max: 255,
    pattern: /^pm_[A-Za-z0-9_]+$/,
    patternMessage: 'must be a payment method id from the provider (pm_…)',
  }),
  makeDefault: z.boolean({ invalid_type_error: 'must be a boolean' }).nullish(),
});

export function toPaymentMethodResponse(m: SavedPaymentMethod) {
  return {
    id: m.id,
    type: m.type,
    brand: m.brand,
    last4: m.last4,
    expMonth: m.expMonth,
    expYear: m.expYear,
    holderName: m.holderName,
    email: m.email,
    isDefault: m.isDefault,
  };
}

/**
 * Saved cards (design 08, "Payment methods"), vaulted with the payment
 * provider: the browser confirms a SetupIntent, then sends us the resulting
 * payment method id and we read brand/last4/expiry from the provider. Only
 * where the gateway has a vault (PAYMENT_PROVIDER=stripe); otherwise 501.
 */
export class PaymentMethodService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: PaymentGateway,
  ) {}

  /** Whether the storefront should offer saved payment methods (GET /api/store/config). */
  get available(): boolean {
    return Boolean(this.gateway.savedPaymentMethods);
  }

  private vault(): SavedPaymentMethodVault {
    const vault = this.gateway.savedPaymentMethods;
    if (!vault) throw new SavedPaymentMethodsUnavailableError();
    return vault;
  }

  async list(user: User) {
    this.vault();
    const rows = await this.prisma.savedPaymentMethod.findMany({
      where: { userId: user.id, deleted: false },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toPaymentMethodResponse);
  }

  /** Creates the provider customer on first use. */
  async createSetupIntent(user: User) {
    const vault = this.vault();
    const customerId = await this.customerFor(user, vault);
    return { clientSecret: await vault.createSetupIntent(customerId) };
  }

  async add(user: User, input: z.output<typeof PaymentMethodAddSchema>) {
    const vault = this.vault();
    const customerId = await this.customerFor(user, vault);
    const pm = await vault.retrievePaymentMethod(input.providerPaymentMethodId);
    // Someone else's card (or a made-up id) looks the same as an unknown one.
    if (!pm || (pm.customerId !== null && pm.customerId !== customerId)) {
      throw new ValidationError({ providerPaymentMethodId: 'We couldn’t find that payment method. Try adding it again.' });
    }
    if (pm.customerId === null) await vault.attachPaymentMethod(pm.id, customerId);

    let saved: SavedPaymentMethod;
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.savedPaymentMethod.findUnique({ where: { providerPaymentMethodId: pm.id } });
        if (existing && existing.userId !== user.id) {
          throw new ValidationError({ providerPaymentMethodId: 'We couldn’t find that payment method. Try adding it again.' });
        }
        const others = await tx.savedPaymentMethod.count({
          where: { userId: user.id, deleted: false, ...(existing ? { id: { not: existing.id } } : {}) },
        });
        const makeDefault = input.makeDefault === true || others === 0;
        if (makeDefault) {
          await tx.savedPaymentMethod.updateMany({ where: { userId: user.id, isDefault: true }, data: { isDefault: false } });
        }
        const details = {
          type: pm.type,
          brand: pm.brand,
          last4: pm.last4,
          expMonth: pm.expMonth,
          expYear: pm.expYear,
          holderName: pm.holderName,
          email: pm.email,
        };
        return existing
          ? tx.savedPaymentMethod.update({
              where: { id: existing.id },
              data: { ...details, deleted: false, ...(makeDefault ? { isDefault: true } : {}) },
            })
          : tx.savedPaymentMethod.create({
              data: {
                ...details,
                userId: user.id,
                provider: vault.provider,
                providerPaymentMethodId: pm.id,
                isDefault: makeDefault,
              },
            });
      }, TX.default);
    } catch (e) {
      // Double submit: the unique provider id lets one insert through.
      if (isIntegrityViolation(e)) {
        const row = await this.prisma.savedPaymentMethod.findUnique({ where: { providerPaymentMethodId: pm.id } });
        if (row && row.userId === user.id) return toPaymentMethodResponse(row);
      }
      throw e;
    }
    if (saved.isDefault) await vault.setDefaultPaymentMethod(customerId, pm.id);
    return toPaymentMethodResponse(saved);
  }

  async setDefault(user: User, id: string) {
    const vault = this.vault();
    const row = await this.find(user, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.savedPaymentMethod.updateMany({ where: { userId: user.id, isDefault: true }, data: { isDefault: false } });
      return tx.savedPaymentMethod.update({ where: { id: row.id }, data: { isDefault: true } });
    }, TX.default);
    if (user.stripeCustomerId) await vault.setDefaultPaymentMethod(user.stripeCustomerId, row.providerPaymentMethodId);
    return toPaymentMethodResponse(updated);
  }

  /** Detaches at the provider, then forgets it; the newest remaining card becomes the default. */
  async remove(user: User, id: string) {
    const vault = this.vault();
    const row = await this.find(user, id);
    await vault.detachPaymentMethod(row.providerPaymentMethodId);
    const promoted = await this.prisma.$transaction(async (tx) => {
      await tx.savedPaymentMethod.update({ where: { id: row.id }, data: { deleted: true, isDefault: false } });
      if (!row.isDefault) return null;
      const next = await tx.savedPaymentMethod.findFirst({
        where: { userId: user.id, deleted: false },
        orderBy: { createdAt: 'desc' },
      });
      return next ? tx.savedPaymentMethod.update({ where: { id: next.id }, data: { isDefault: true } }) : null;
    }, TX.default);
    if (promoted && user.stripeCustomerId) {
      await vault.setDefaultPaymentMethod(user.stripeCustomerId, promoted.providerPaymentMethodId);
    }
  }

  /**
   * Account deletion: detach every saved card at the provider (best effort)
   * and mark the rows deleted.
   */
  async forgetAll(userId: string) {
    const rows = await this.prisma.savedPaymentMethod.findMany({ where: { userId, deleted: false } });
    const vault = this.gateway.savedPaymentMethods;
    if (vault) {
      for (const row of rows) await vault.detachPaymentMethod(row.providerPaymentMethodId).catch(() => undefined);
    }
    await this.prisma.savedPaymentMethod.updateMany({ where: { userId, deleted: false }, data: { deleted: true, isDefault: false } });
  }

  private async find(user: User, id: string) {
    const row = await this.prisma.savedPaymentMethod.findFirst({ where: { id, userId: user.id, deleted: false } });
    if (!row) throw new PaymentMethodNotFoundError();
    return row;
  }

  private async customerFor(user: User, vault: SavedPaymentMethodVault): Promise<string> {
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { stripeCustomerId: true } });
    if (fresh.stripeCustomerId) return fresh.stripeCustomerId;
    const customerId = await vault.createCustomer({ email: user.email, name: user.fullName, userId: user.id });
    // Two first-time requests at once get the same customer (idempotency key); write it once.
    await this.prisma.user.updateMany({ where: { id: user.id, stripeCustomerId: null }, data: { stripeCustomerId: customerId } });
    user.stripeCustomerId = customerId;
    return customerId;
  }
}
