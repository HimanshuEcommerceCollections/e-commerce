import { Prisma, type PrismaClient, type Promotion } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { DomainError } from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { decimal, integer, oneOf, requiredString, ValidationError } from '../common/validation';

export const PROMOTION_TYPES = ['PERCENT', 'FIXED', 'FREE_SHIPPING'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const ADMIN_PROMOTION_SORTS = ['createdAt', 'code', 'endsAt', 'startsAt'] as const;

/** Runs `inner` unless the value is null, which means "clear it" on a PATCH. */
const clearable = <T>(inner: z.ZodType<T, z.ZodTypeDef, unknown>) =>
  z.unknown().transform((v, ctx): T | null => {
    if (v === null) return null;
    const r = inner.safeParse(v);
    if (r.success) return r.data;
    for (const issue of r.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path });
    return z.NEVER;
  });

const instant = () =>
  z.unknown().transform((v, ctx): Date | undefined => {
    if (v === undefined) return undefined;
    const d = typeof v === 'string' && v.trim() !== '' ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid date' });
      return z.NEVER;
    }
    return d;
  });

const optionalBoolean = () =>
  z.unknown().transform((v, ctx): boolean | undefined => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a boolean' });
    return z.NEVER;
  });

const amount = () =>
  decimal({ positiveOrZero: true, max: 9_999_999_999.99 }).superRefine((v, ctx) => {
    if (v && v.decimalPlaces() > 2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must have at most 2 decimal places' });
  });

/** Every field of a promotion; POST requires code, description and type, PATCH none. */
const fields = {
  code: requiredString({
    blankMessage: 'Enter a code',
    max: 40,
    sizeMessage: 'Code must not exceed 40 characters',
    pattern: /^[A-Za-z0-9_-]+$/,
    patternMessage: 'Use letters, numbers, dashes or underscores',
  }),
  description: requiredString({ blankMessage: 'Enter a description', max: 255, sizeMessage: 'Description must not exceed 255 characters' }),
  type: oneOf(PROMOTION_TYPES),
  value: amount(),
  minSubtotal: clearable(amount()),
  startsAt: clearable(instant()),
  endsAt: clearable(instant()),
  usageLimit: clearable(integer({ positive: true })),
  perCustomerLimit: clearable(integer({ positive: true })),
  firstOrderOnly: optionalBoolean(),
  active: optionalBoolean(),
};

export const PromotionCreateSchema = z
  .object(fields)
  .superRefine((v, ctx) => {
    if (v.type === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not be null', path: ['type'] });
  });
export const PromotionUpdateSchema = z.object({ ...fields, code: fields.code.optional(), description: fields.description.optional() });

type PromotionInput = z.output<typeof PromotionUpdateSchema>;

/** The non-cancelled orders that used a promotion count against its limits. */
const USED = { deleted: false, status: { not: 'CANCELLED' } } satisfies Prisma.OrderWhereInput;

export interface PromotionFilter {
  search?: string;
  active?: boolean;
}

/**
 * Promotion codes for the admin (contract D3). How a code applies at checkout
 * lives in src/promo; here only the rows and their usage. Deleting only
 * deactivates: orders keep pointing at the promotion they used.
 */
export class AdminPromotionService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(filter: PromotionFilter, pageable: Pageable) {
    const q = filter.search?.trim();
    const where: Prisma.PromotionWhereInput = {
      ...(filter.active !== undefined && { active: filter.active }),
      ...(q && {
        OR: [{ code: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.promotion.findMany({ where, orderBy: orderBy(pageable, []).concat({ id: 'asc' }), ...skipTake(pageable) }),
      this.prisma.promotion.count({ where }),
    ]);
    const used = await this.timesUsed(rows.map((r) => r.id));
    return toPage(rows.map((r) => toRow(r, used.get(r.id) ?? 0)), total, pageable);
  }

  async get(id: string) {
    const row = await this.prisma.promotion.findUnique({ where: { id } });
    if (!row) throw notFound(id);
    return toRow(row, (await this.timesUsed([id])).get(id) ?? 0);
  }

  async create(input: PromotionInput) {
    const data = validated(input, null);
    try {
      const row = await this.prisma.promotion.create({ data: data as Prisma.PromotionCreateInput });
      return toRow(row, 0);
    } catch (e) {
      throw isIntegrityViolation(e) ? codeTaken(data.code!) : e;
    }
  }

  async update(id: string, input: PromotionInput) {
    const current = await this.prisma.promotion.findUnique({ where: { id } });
    if (!current) throw notFound(id);
    const data = validated(input, current);
    try {
      await this.prisma.promotion.update({ where: { id }, data });
    } catch (e) {
      throw isIntegrityViolation(e) ? codeTaken(data.code!) : e;
    }
    return this.get(id);
  }

  async deactivate(id: string) {
    const current = await this.prisma.promotion.findUnique({ where: { id } });
    if (!current) throw notFound(id);
    if (current.active) await this.prisma.promotion.update({ where: { id }, data: { active: false } });
    return this.get(id);
  }

  private async timesUsed(ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const groups = await this.prisma.order.groupBy({
      by: ['promotionId'],
      where: { ...USED, promotionId: { in: ids } },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.promotionId!, g._count._all]));
  }
}

/**
 * The changed columns, checked against the row they land on: the value must
 * suit the type, and the window must end after it starts.
 */
function validated(input: PromotionInput, current: Promotion | null) {
  const type = input.type ?? (current?.type as PromotionType | undefined);
  const value = input.value ?? current?.value;
  const errors: Record<string, string> = {};
  if (type === 'PERCENT' && (!value || value.lte(0) || value.gt(100))) errors.value = 'Enter a percentage between 1 and 100';
  if (type === 'FIXED' && (!value || value.lte(0))) errors.value = 'Enter an amount greater than 0';
  const startsAt = input.startsAt === undefined ? current?.startsAt : input.startsAt;
  const endsAt = input.endsAt === undefined ? current?.endsAt : input.endsAt;
  if (startsAt && endsAt && endsAt <= startsAt) errors.endsAt = 'must be after the start date';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const data: Prisma.PromotionUpdateInput = {
    ...(input.code !== undefined && { code: input.code.trim().toUpperCase() }),
    ...(input.description !== undefined && { description: input.description.trim() }),
    ...(input.type !== undefined && { type: input.type }),
    // FREE_SHIPPING ignores the value; store 0 so a stale percentage can't linger.
    ...(type === 'FREE_SHIPPING' ? { value: new Prisma.Decimal(0) } : input.value !== undefined && { value: input.value }),
    ...(input.minSubtotal !== undefined && { minSubtotal: input.minSubtotal }),
    ...(input.startsAt !== undefined && { startsAt: input.startsAt }),
    ...(input.endsAt !== undefined && { endsAt: input.endsAt }),
    ...(input.usageLimit !== undefined && { usageLimit: input.usageLimit }),
    ...(input.perCustomerLimit !== undefined && { perCustomerLimit: input.perCustomerLimit }),
    ...(input.firstOrderOnly !== undefined && { firstOrderOnly: input.firstOrderOnly }),
    ...(input.active !== undefined && { active: input.active }),
  };
  return data as Prisma.PromotionUpdateInput & { code?: string };
}

const notFound = (id: string) => new DomainError(404, `Promotion ${id} was not found`);
const codeTaken = (code: string) => new DomainError(409, `A promotion with code ${code} already exists`);

/** ACTIVE, SCHEDULED (starts later), EXPIRED (ended or used up) or INACTIVE (switched off). */
function stateOf(p: Promotion, timesUsed: number, now = new Date()) {
  if (!p.active) return 'INACTIVE';
  if (p.endsAt && p.endsAt <= now) return 'EXPIRED';
  if (p.usageLimit !== null && timesUsed >= p.usageLimit) return 'EXPIRED';
  if (p.startsAt && p.startsAt > now) return 'SCHEDULED';
  return 'ACTIVE';
}

function toRow(p: Promotion, timesUsed: number) {
  return {
    id: p.id,
    code: p.code,
    description: p.description,
    type: p.type,
    value: money(p.value),
    minSubtotal: p.minSubtotal === null ? null : money(p.minSubtotal),
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    usageLimit: p.usageLimit,
    perCustomerLimit: p.perCustomerLimit,
    firstOrderOnly: p.firstOrderOnly,
    active: p.active,
    state: stateOf(p, timesUsed),
    timesUsed,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
