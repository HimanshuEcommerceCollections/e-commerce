import { Prisma, type PrismaClient, type StoreCreditEntry, type User } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { DomainError } from '../common/errors';
import { decimal, requiredString } from '../common/validation';
import type { Config } from '../config';
import { TX, type Db } from '../db';
import { estimatedRefund } from '../order/order.mapper';

/** store_credit_entries.type. */
export type StoreCreditEntryType = 'GIFT_CARD' | 'RETURN_REFUND' | 'GOODWILL' | 'ADJUSTMENT' | 'FORFEIT';

/** Returns still on their way to a refund. */
const OPEN_RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'RECEIVED'];

export class InsufficientStoreCreditError extends DomainError {
  constructor() {
    super(409, "The store credit balance can't go below zero.");
  }
}

/** Admin manual credit: signed amount (+ goodwill, − correction) and the reason the customer sees. */
export const StoreCreditAdjustSchema = z.object({
  // Guarded: after a failed parse the refinement still runs, without a Decimal.
  amount: decimal({ required: true, max: 10_000 }).refine(
    (d) => !(d instanceof Prisma.Decimal) || (!d.isZero() && d.gte(-10_000) && d.decimalPlaces() <= 2),
    {
    message: 'Enter a non-zero amount with up to 2 decimals',
  }),
  description: requiredString({ blankMessage: 'Add a description the customer will see.', max: 255 }),
});

export interface StoreCreditChange {
  userId: string;
  /** Signed. */
  amount: Prisma.Decimal;
  type: StoreCreditEntryType;
  description: string;
  orderId?: string | null;
  returnId?: string | null;
  giftCardId?: string | null;
  createdBy?: string | null;
}

/**
 * Moves a customer's balance and writes the ledger entry, in the caller's
 * transaction. The balance update is a single conditional statement, so
 * concurrent changes can't overdraw it (and chk_users_store_credit_non_negative
 * backs that up). Throws InsufficientStoreCreditError when it would go negative.
 * Also for other modules (a return refunded to store credit: type RETURN_REFUND).
 */
export async function applyStoreCredit(db: Db, change: StoreCreditChange): Promise<{ balance: Prisma.Decimal; entry: StoreCreditEntry }> {
  const amount = change.amount.toFixed(2);
  const rows = await db.$queryRaw<{ balance: Prisma.Decimal }[]>`
    UPDATE users SET store_credit_balance = store_credit_balance + ${amount}::numeric
    WHERE id = ${change.userId}::uuid AND store_credit_balance + ${amount}::numeric >= 0
    RETURNING store_credit_balance AS balance`;
  if (rows.length === 0) throw new InsufficientStoreCreditError();
  const balance = new Prisma.Decimal(rows[0]!.balance);
  const entry = await db.storeCreditEntry.create({
    data: {
      userId: change.userId,
      amount: change.amount,
      balanceAfter: balance,
      type: change.type,
      description: change.description.slice(0, 255),
      orderId: change.orderId ?? null,
      returnId: change.returnId ?? null,
      giftCardId: change.giftCardId ?? null,
      createdBy: change.createdBy ?? null,
    },
  });
  return { balance, entry };
}

export function toCreditEntryResponse(e: StoreCreditEntry) {
  return { id: e.id, createdAt: e.createdAt, description: e.description, amount: money(e.amount), type: e.type };
}

/**
 * Store credit (design 08, "Gift cards & credit"): the balance, refunds still
 * on their way to it, and the ledger. Spending credit at checkout is a
 * follow-up; for now it only accrues.
 */
export class StoreCreditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: Config,
  ) {}

  async get(user: User) {
    const [fresh, entries, openReturns] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { storeCreditBalance: true } }),
      this.prisma.storeCreditEntry.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.prisma.orderReturn.findMany({
        where: { refundTo: 'STORE_CREDIT', status: { in: OPEN_RETURN_STATUSES }, order: { userId: user.id } },
        include: { items: true, order: { include: { items: true } } },
      }),
    ]);
    let pending = new Prisma.Decimal(0);
    for (const r of openReturns) {
      pending = pending.add(estimatedRefund(r.items, r.order.items, this.config.pricing.pricesIncludeTax));
    }
    return {
      balance: money(fresh.storeCreditBalance),
      pendingFromReturns: money(pending),
      currency: this.config.order.currency,
      activity: entries.map(toCreditEntryResponse),
    };
  }

  /** POST /api/admin/customers/:id/store-credit. */
  async adjust(customerId: string, input: z.output<typeof StoreCreditAdjustSchema>, actor: string) {
    const customer = await this.prisma.user.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new DomainError(404, `Customer not found: ${customerId}`);
    const { balance, entry } = await this.prisma.$transaction(
      (tx) =>
        applyStoreCredit(tx, {
          userId: customerId,
          amount: input.amount,
          type: input.amount.isPositive() ? 'GOODWILL' : 'ADJUSTMENT',
          description: input.description.trim(),
          createdBy: actor,
        }),
      TX.default,
    );
    return { balance: money(balance), entry: toCreditEntryResponse(entry) };
  }
}
