import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type DataExportRequest, type PrismaClient, type User } from '@prisma/client';
import { z } from 'zod';
import { checkPassword, hashPassword, sha256Hex } from '../auth/auth.service';
import { DomainError } from '../common/errors';
import { requiredString, ValidationError } from '../common/validation';
import type { Config } from '../config';
import { TX } from '../db';
import type { Mailer } from '../notify/mailer';
import type { PaymentMethodService } from './payment-methods.service';
import { recomputeRollup } from './reviews.service';
import type { SessionService } from './sessions.service';
import { applyStoreCredit } from './store-credit.service';

/** An export request younger than this is reused instead of building another. */
const EXPORT_REUSE_MS = 48 * 3_600_000;
/** How long a ready export can be downloaded. */
const EXPORT_TTL_MS = 7 * 24 * 3_600_000;

/** Orders and returns that block deletion until they finish. */
const OPEN_ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'SHIPPED'];
const OPEN_RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'RECEIVED'];

export const AccountDeleteSchema = z.object({
  confirm: z.unknown().transform((v, ctx) => {
    if (v !== 'DELETE') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Type DELETE in capital letters.' });
      return z.NEVER;
    }
    return v;
  }),
  password: requiredString({ blankMessage: 'Enter your password.' }),
});

export class OpenOrdersBlockDeletionError extends DomainError {
  constructor() {
    super(409, "You have orders or returns in progress. You can delete your account once they're complete.");
  }
}
export class DataExportNotFoundError extends DomainError {
  constructor() {
    super(404, 'This download link is invalid or has expired. Request a new export.');
  }
}

const toExportSummary = (r: DataExportRequest) => ({
  id: r.id,
  status: r.status === 'READY' && r.expiresAt && r.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : r.status,
  createdAt: r.createdAt,
  completedAt: r.completedAt,
  expiresAt: r.expiresAt,
});

const dec = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));

/**
 * "Download your data" and "Delete account" (design 08, "Privacy & data").
 * The export is built synchronously (it's one customer's rows) and kept for
 * seven days behind a single emailed token, of which only the hash is stored.
 */
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mailer: Mailer,
    private readonly config: Config,
    private readonly sessions: SessionService,
    private readonly paymentMethods: PaymentMethodService,
  ) {}

  async requestExport(user: User) {
    const recent = await this.prisma.dataExportRequest.findFirst({
      where: {
        userId: user.id,
        status: { in: ['REQUESTED', 'READY'] },
        createdAt: { gt: new Date(Date.now() - EXPORT_REUSE_MS) },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return toExportSummary(recent);

    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const payload = await this.buildExport(user);
    const now = new Date();
    const row = await this.prisma.dataExportRequest.create({
      data: {
        id,
        userId: user.id,
        status: 'READY',
        completedAt: now,
        expiresAt: new Date(now.getTime() + EXPORT_TTL_MS),
        downloadTokenHash: sha256Hex(token),
        payload: payload as Prisma.InputJsonValue,
      },
    });
    const link = `${this.config.store.appBaseUrl}/account/data-export/${id}?token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      template: 'DATA_EXPORT',
      to: user.email,
      userId: user.id,
      subject: `${this.config.store.name}: your data is ready`,
      body:
        `The copy of your ${this.config.store.name} data you asked for is ready.\n\n` +
        `Download it here while signed in (the link works for 7 days):\n${link}\n\n` +
        `If you didn't ask for this, change your password and sign out other devices.`,
    });
    return toExportSummary(row);
  }

  async latestExport(user: User) {
    const row = await this.prisma.dataExportRequest.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    return row ? toExportSummary(row) : null;
  }

  /** The export JSON, for its owner holding the emailed token. */
  async download(user: User, id: string, token: string | undefined) {
    const row = await this.prisma.dataExportRequest.findFirst({ where: { id, userId: user.id } });
    const given = Buffer.from(sha256Hex(token ?? ''), 'hex');
    const valid =
      row !== null &&
      row.status === 'READY' &&
      row.payload !== null &&
      row.downloadTokenHash !== null &&
      timingSafeEqual(given, Buffer.from(row.downloadTokenHash, 'hex')) &&
      (!row.expiresAt || row.expiresAt.getTime() > Date.now());
    if (!token || !valid) throw new DataExportNotFoundError();
    return { fileName: `data-export-${row.createdAt.toISOString().slice(0, 10)}.json`, payload: row.payload };
  }

  /**
   * Closes the account. Refused while an order or return is still moving.
   * Order rows stay (with their user id) for the business record; everything
   * else personal goes: addresses, saved items, reviews (soft), saved cards,
   * sessions, credit (forfeited), and the user row is anonymised and disabled.
   */
  async deleteAccount(user: User, input: z.output<typeof AccountDeleteSchema>) {
    if (!(await checkPassword(input.password, user.password))) {
      throw new ValidationError({ password: 'That password is incorrect.' });
    }
    const [openOrders, openReturns] = await Promise.all([
      this.prisma.order.count({ where: { userId: user.id, deleted: false, status: { in: OPEN_ORDER_STATUSES } } }),
      this.prisma.orderReturn.count({ where: { order: { userId: user.id }, status: { in: OPEN_RETURN_STATUSES } } }),
    ]);
    if (openOrders > 0 || openReturns > 0) throw new OpenOrdersBlockDeletionError();

    const oldEmail = user.email;
    const unusablePassword = await hashPassword(randomBytes(32).toString('hex'));
    await this.paymentMethods.forgetAll(user.id);

    const reviewedParents = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { storeCreditBalance: true } });
      if (fresh.storeCreditBalance.gt(0)) {
        await applyStoreCredit(tx, {
          userId: user.id,
          amount: fresh.storeCreditBalance.neg(),
          type: 'FORFEIT',
          description: 'Account closed',
        });
      }
      await this.sessions.revokeOthers(user.id, null, tx);
      await tx.userAddress.updateMany({ where: { userId: user.id, deleted: false }, data: { deleted: true, isDefault: false } });
      await tx.savedItem.deleteMany({ where: { userId: user.id } });
      const reviews = await tx.productReview.findMany({ where: { userId: user.id, deleted: false }, select: { parentId: true } });
      await tx.productReview.updateMany({ where: { userId: user.id, deleted: false }, data: { deleted: true } });
      await tx.notificationPreference.deleteMany({ where: { userId: user.id } });
      await tx.dataExportRequest.updateMany({ where: { userId: user.id }, data: { payload: Prisma.DbNull, status: 'EXPIRED' } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: `deleted+${user.id}@invalid`,
          fullName: 'Deleted user',
          phoneNumber: null,
          birthday: null,
          password: unusablePassword,
          enabled: false,
          marketingOptIn: false,
          twoFactorEnabled: false,
          twoFactorPhone: null,
          deletionRequestedAt: new Date(),
        },
      });
      return [...new Set(reviews.map((r) => r.parentId))];
    }, TX.default);
    await this.refreshRatings(reviewedParents);

    await this.mailer.send({
      template: 'ACCOUNT_DELETED',
      to: oldEmail,
      userId: user.id,
      subject: `${this.config.store.name}: your account has been deleted`,
      body:
        `Your ${this.config.store.name} account has been closed and your personal details removed.\n\n` +
        `We keep order records as the law requires. If you didn't ask for this, reply to this email right away.`,
    });
    return { email: oldEmail };
  }

  /** Rating rollups on parent_products for the reviews just hidden. */
  private async refreshRatings(parentIds: string[]) {
    for (const parentId of parentIds) await recomputeRollup(this.prisma, parentId);
  }

  private async buildExport(user: User) {
    const [addresses, orders, reviews, savedItems, credit, prefs] = await Promise.all([
      this.prisma.userAddress.findMany({ where: { userId: user.id, deleted: false }, orderBy: { createdAt: 'asc' } }),
      this.prisma.order.findMany({
        where: { userId: user.id, deleted: false },
        include: { items: true, returns: { include: { items: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.productReview.findMany({ where: { userId: user.id, deleted: false }, orderBy: { createdAt: 'desc' } }),
      this.prisma.savedItem.findMany({ where: { userId: user.id }, include: { product: { select: { name: true, sku: true } } } }),
      this.prisma.storeCreditEntry.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.notificationPreference.findUnique({ where: { userId: user.id } }),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      store: this.config.store.name,
      profile: {
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        birthday: user.birthday,
        marketingOptIn: user.marketingOptIn,
        memberSince: user.createdAt,
        twoFactorEnabled: user.twoFactorEnabled,
        storeCreditBalance: dec(user.storeCreditBalance),
      },
      notificationPreferences: prefs
        ? {
            newArrivals: prefs.newArrivals,
            priceDrops: prefs.priceDrops,
            backInStock: prefs.backInStock,
            reviewReminders: prefs.reviewReminders,
            smsDelivery: prefs.smsDelivery,
          }
        : null,
      addresses: addresses.map((a) => ({
        label: a.label,
        recipientName: a.recipientName,
        phone: a.phone,
        addressLine1: a.addressLine1,
        addressLine2: a.addressLine2,
        city: a.city,
        state: a.state,
        postalCode: a.postalCode,
        country: a.country,
        isDefault: a.isDefault,
      })),
      orders: orders.map((o) => ({
        orderNumber: o.orderNumber,
        placedAt: o.createdAt,
        status: o.status,
        currency: o.currency,
        subtotal: dec(o.subtotal),
        discountTotal: dec(o.discountTotal),
        taxTotal: dec(o.taxTotal),
        shippingTotal: dec(o.shippingTotal),
        grandTotal: dec(o.grandTotal),
        refundedTotal: dec(o.refundedTotal),
        shipTo: {
          name: o.shipRecipientName,
          phone: o.shipPhone,
          addressLine1: o.shipAddressLine1,
          addressLine2: o.shipAddressLine2,
          city: o.shipCity,
          state: o.shipState,
          postalCode: o.shipPostalCode,
          country: o.shipCountry,
        },
        items: o.items.map((i) => ({
          productName: i.productName,
          sku: i.sku,
          variant: i.variantName,
          quantity: i.quantity,
          unitPrice: dec(i.unitPrice),
          lineTotal: dec(i.lineTotal),
        })),
        returns: o.returns.map((r) => ({
          rmaNumber: r.rmaNumber,
          status: r.status,
          reason: r.reason,
          requestedAt: r.createdAt,
          refundAmount: dec(r.refundAmount),
          refundTo: r.refundTo,
        })),
      })),
      reviews: reviews.map((r) => ({
        rating: r.rating,
        title: r.title,
        body: r.body,
        recommend: r.recommend,
        status: r.status,
        createdAt: r.createdAt,
      })),
      savedItems: savedItems.map((s) => ({
        productName: s.product.name,
        sku: s.product.sku,
        priceAtSave: dec(s.priceAtSave),
        savedAt: s.createdAt,
      })),
      storeCredit: credit.map((e) => ({
        date: e.createdAt,
        description: e.description,
        amount: dec(e.amount),
        type: e.type,
        balanceAfter: dec(e.balanceAfter),
      })),
    };
  }
}
