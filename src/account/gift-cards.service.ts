import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Prisma, type GiftCard, type PrismaClient, type User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { money } from '../common/api-response';
import { DomainError } from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { skipTake, toPage, type Pageable } from '../common/pagination';
import { decimal } from '../common/validation';
import type { Config } from '../config';
import { TX } from '../db';
import type { Mailer } from '../notify/mailer';
import { applyStoreCredit } from './store-credit.service';

export const GIFT_CARD_SORTS = ['createdAt'] as const;

// No 0/O or 1/I: codes are typed in from a printed card.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PIN_ROUNDS = 10;
// Compared against when the code is unknown, so both paths cost one bcrypt.
const DUMMY_PIN_HASH = bcrypt.hashSync('0000-not-a-pin', PIN_ROUNDS);

const NOT_FOUND_MESSAGE = "We couldn't find a gift card with that number and PIN.";

export class GiftCardNotFoundError extends DomainError {
  constructor() {
    super(404, NOT_FOUND_MESSAGE);
  }
}
export class GiftCardAlreadyRedeemedError extends DomainError {
  constructor() {
    super(409, 'This gift card has already been added.');
  }
}

/** Dashes and spaces ignored, case-insensitive. */
const normalizeCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();
const hashCode = (normalized: string) => createHash('sha256').update(normalized).digest('hex');
const formatCode = (normalized: string) => normalized.match(/.{4}/g)!.join('-');

export const GiftCardRedeemSchema = z.object({
  code: z.unknown().transform((v, ctx) => {
    const code = typeof v === 'string' ? normalizeCode(v) : '';
    if (!/^[A-Z0-9]{16}$/.test(code)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter the 16-character gift card number.' });
      return z.NEVER;
    }
    return code;
  }),
  pin: z.unknown().transform((v, ctx) => {
    const pin = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v).padStart(4, '0') : '';
    if (!/^\d{4}$/.test(pin)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter the 4-digit PIN.' });
      return z.NEVER;
    }
    return pin;
  }),
});

export const GiftCardCreateSchema = z.object({
  amount: decimal({ required: true, positive: true, max: 2_000 }).refine(
    (d) => !(d instanceof Prisma.Decimal) || d.decimalPlaces() <= 2,
    { message: 'must have at most 2 decimals' },
  ),
  expiresAt: z.unknown().transform((v, ctx): Date | null => {
    if (v === null || v === undefined || v === '') return null;
    const d = typeof v === 'string' ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a future date (ISO 8601)' });
      return z.NEVER;
    }
    return d;
  }),
});

/**
 * Gift cards: admins issue them (the code and PIN are shown once), customers
 * add them to their store credit. Only hashes are stored — SHA-256 of the
 * code (looked up by index) and bcrypt of the PIN.
 */
export class GiftCardService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mailer: Mailer,
    private readonly config: Config,
  ) {}

  /** POST /api/users/me/store-credit/redeem → { added, balance }. */
  async redeem(user: User, input: z.output<typeof GiftCardRedeemSchema>) {
    const codeHash = hashCode(input.code);
    const card = await this.prisma.giftCard.findUnique({ where: { codeHash } });
    const codeMatches = card !== null && timingSafeEqual(Buffer.from(card.codeHash, 'hex'), Buffer.from(codeHash, 'hex'));
    const pinMatches = await bcrypt.compare(input.pin, card?.pinHash ?? DUMMY_PIN_HASH);
    if (!card || !codeMatches || !pinMatches) throw new GiftCardNotFoundError();
    // Only past the PIN check do the answers differ.
    if (card.status === 'REDEEMED') throw new GiftCardAlreadyRedeemedError();
    if (card.status !== 'ACTIVE' || (card.expiresAt && card.expiresAt.getTime() <= Date.now())) {
      throw new GiftCardNotFoundError();
    }

    const { balance } = await this.prisma.$transaction(async (tx) => {
      // Single use, even when two people race the same card.
      const { count } = await tx.giftCard.updateMany({
        where: { id: card.id, status: 'ACTIVE' },
        data: { status: 'REDEEMED', redeemedByUserId: user.id, redeemedAt: new Date() },
      });
      if (count === 0) throw new GiftCardAlreadyRedeemedError();
      return applyStoreCredit(tx, {
        userId: user.id,
        amount: card.initialAmount,
        type: 'GIFT_CARD',
        description: `Gift card ending in ${card.last4}`,
        giftCardId: card.id,
      });
    }, TX.default);

    await this.mailer.send({
      template: 'GIFT_CARD',
      to: user.email,
      userId: user.id,
      subject: `${this.config.store.name}: gift card added`,
      body:
        `A ${card.initialAmount.toFixed(2)} ${card.currency} gift card (ending in ${card.last4}) is now in your store credit.\n\n` +
        `Your balance: ${balance.toFixed(2)} ${card.currency}. See it any time: ${this.config.store.appBaseUrl}/account/gift-cards`,
    });
    return { added: money(card.initialAmount), balance: money(balance) };
  }

  /** POST /api/admin/gift-cards. The only time the code and PIN are readable. */
  async create(input: z.output<typeof GiftCardCreateSchema>, actor: string) {
    for (let attempt = 0; ; attempt++) {
      const code = Array.from({ length: 16 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const pin = String(randomInt(0, 10_000)).padStart(4, '0');
      try {
        const card = await this.prisma.giftCard.create({
          data: {
            codeHash: hashCode(code),
            last4: code.slice(-4),
            pinHash: await bcrypt.hash(pin, PIN_ROUNDS),
            initialAmount: input.amount,
            currency: this.config.order.currency,
            status: 'ACTIVE',
            expiresAt: input.expiresAt,
            createdBy: actor,
          },
        });
        return { ...toGiftCardResponse(card, null), code: formatCode(code), pin };
      } catch (e) {
        // 32^16 codes: a collision is all but impossible, but cheap to retry.
        if (isIntegrityViolation(e) && attempt < 3) continue;
        throw e;
      }
    }
  }

  /** GET /api/admin/gift-cards?page — newest first; codes appear masked. */
  async list(pageable: Pageable) {
    const [rows, total] = await Promise.all([
      this.prisma.giftCard.findMany({
        orderBy: pageable.sort.length ? pageable.sort.map((s) => ({ [s.field]: s.direction })) : [{ createdAt: 'desc' }],
        ...skipTake(pageable),
      }),
      this.prisma.giftCard.count(),
    ]);
    const redeemerIds = [...new Set(rows.map((r) => r.redeemedByUserId).filter((id): id is string => id !== null))];
    const redeemers = redeemerIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: redeemerIds } }, select: { id: true, email: true } })
      : [];
    const emailById = new Map(redeemers.map((u) => [u.id, u.email]));
    return toPage(
      rows.map((r) => toGiftCardResponse(r, r.redeemedByUserId ? (emailById.get(r.redeemedByUserId) ?? null) : null)),
      total,
      pageable,
    );
  }
}

function toGiftCardResponse(card: GiftCard, redeemedByEmail: string | null) {
  const expired = card.status === 'ACTIVE' && card.expiresAt !== null && card.expiresAt.getTime() <= Date.now();
  return {
    id: card.id,
    maskedCode: `••••-••••-••••-${card.last4}`,
    last4: card.last4,
    amount: money(card.initialAmount),
    currency: card.currency,
    status: expired ? 'EXPIRED' : card.status,
    createdAt: card.createdAt,
    createdBy: card.createdBy,
    expiresAt: card.expiresAt,
    redeemedAt: card.redeemedAt,
    redeemedByUserId: card.redeemedByUserId,
    redeemedByEmail,
  };
}
