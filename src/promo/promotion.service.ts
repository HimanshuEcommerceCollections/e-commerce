import { Prisma, type PrismaClient, type Promotion } from '@prisma/client';
import { money } from '../common/api-response';
import { optionalString, requiredString, ValidationError } from '../common/validation';
import type { Db } from '../db';
import { promoDiscount } from '../order/pricing';

/**
 * Promotion codes (contract B1): looked up case-insensitively (stored
 * upper-case), checked against dates, minimum subtotal, usage limits and the
 * first-order rule. The money side — discount, its spread over the lines,
 * free shipping — lives in src/order/pricing.ts with everything else.
 */

/** A code as typed: trimmed, upper-cased, at most 40 characters. */
export const promoCodeField = () =>
  optionalString({ max: 40, sizeMessage: 'Promo code must not exceed 40 characters' });

/** A code that must be there (the validate endpoint). */
export const requiredPromoCode = () =>
  requiredString({ blankMessage: 'Enter a promo code.', max: 40, sizeMessage: 'Promo code must not exceed 40 characters' });

export const normalizePromoCode = (code: string) => code.trim().toUpperCase();

/** Orders in these states never used their code (it can be used again). */
const UNUSED_STATUSES = ['CANCELLED', 'PAYMENT_FAILED'];

/** Who is redeeming: the signed-in user, or a guest by email. Either may be unknown before checkout. */
export interface PromoCustomer {
  userId?: string | null;
  email?: string | null;
}

/**
 * The live promotion for `rawCode`, or a 400 naming `field` with the reason
 * the shopper sees. `lock` (inside the checkout transaction) serialises
 * redemptions of a limited code, so two orders can't both take its last use.
 */
export async function resolvePromotion(
  db: Db,
  rawCode: string,
  subtotal: Prisma.Decimal,
  customer: PromoCustomer,
  options: { field?: string; lock?: boolean; now?: Date } = {},
): Promise<Promotion> {
  const field = options.field ?? 'code';
  const code = normalizePromoCode(rawCode);
  const fail = (message: string): never => {
    throw new ValidationError({ [field]: message });
  };
  const now = options.now ?? new Date();
  const promo = await db.promotion.findUnique({ where: { code } });
  if (!promo || !promo.active || (promo.startsAt && promo.startsAt > now) || (promo.endsAt && promo.endsAt <= now)) {
    return fail(`"${code}" isn't a valid code.`);
  }
  if (options.lock && (promo.usageLimit !== null || promo.perCustomerLimit !== null || promo.firstOrderOnly)) {
    await db.$queryRaw`SELECT id::text FROM promotions WHERE id = ${promo.id}::uuid FOR UPDATE`;
  }
  if (promo.minSubtotal && subtotal.lt(promo.minSubtotal)) {
    return fail(`Add $${promo.minSubtotal.sub(subtotal).toFixed(2)} more to use ${code}.`);
  }
  if (promo.usageLimit !== null) {
    const used = await db.order.count({
      where: { promotionId: promo.id, deleted: false, status: { notIn: UNUSED_STATUSES } },
    });
    if (used >= promo.usageLimit) fail(`${code} is no longer available.`);
  }

  const who = customerWhere(customer);
  if (who && promo.firstOrderOnly) {
    const previous = await db.order.count({ where: { ...who, deleted: false, status: { notIn: UNUSED_STATUSES } } });
    if (previous > 0) fail(`${code} is for your first order only.`);
  }
  if (who && promo.perCustomerLimit !== null) {
    const mine = await db.order.count({
      where: { ...who, promotionId: promo.id, deleted: false, status: { notIn: UNUSED_STATUSES } },
    });
    if (mine >= promo.perCustomerLimit) fail(`You've already used ${code}.`);
  }
  return promo;
}

/** The customer's orders: by account, or by the email a guest checked out with. */
function customerWhere(c: PromoCustomer): Prisma.OrderWhereInput | null {
  const or: Prisma.OrderWhereInput[] = [];
  if (c.userId) or.push({ userId: c.userId });
  if (c.email?.trim()) or.push({ customerEmail: { equals: c.email.trim(), mode: 'insensitive' } });
  return or.length ? { OR: or } : null;
}

/** What the cart, quote and order show for an applied code. */
export function toPromoResponse(promo: Promotion, discount: Prisma.Decimal) {
  return {
    code: promo.code,
    description: promo.description,
    type: promo.type,
    discount: money(discount),
    freeShipping: promo.type === 'FREE_SHIPPING',
  };
}

/**
 * The cart/quote outcome of an optional code: the promotion, or the reason it
 * doesn't apply. Carts never fail over a code — only order placement does.
 */
export interface PromoLookup {
  promo: Promotion | null;
  error: string | null;
}

export class PromotionService {
  constructor(private readonly prisma: PrismaClient) {}

  /** A code entered in the cart: the promotion, or why it doesn't apply (never throws for a bad code). */
  async lookup(code: string | null | undefined, subtotal: Prisma.Decimal, customer: PromoCustomer): Promise<PromoLookup> {
    if (!code?.trim()) return { promo: null, error: null };
    try {
      return { promo: await resolvePromotion(this.prisma, code, subtotal, customer), error: null };
    } catch (e) {
      if (e instanceof ValidationError) return { promo: null, error: e.fieldErrors.code ?? 'Invalid code' };
      throw e;
    }
  }

  /** POST /api/cart/promo/validate: the code against this subtotal, or a 400 on `code`. */
  async validate(code: string, subtotal: Prisma.Decimal, customer: PromoCustomer) {
    const promo = await resolvePromotion(this.prisma, code, subtotal, customer);
    return toPromoResponse(promo, promoDiscount(promo, subtotal));
  }
}
