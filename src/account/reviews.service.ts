import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { REVIEW_STATUSES, type ReviewStatus } from '../common/enums';
import { DomainError, ProductNotFoundError } from '../common/errors';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { flag, optionalString, requiredUuid } from '../common/validation';
import type { Config } from '../config';
import { TX, type Db } from '../db';
import type { Mailer } from '../notify/mailer';
import { primaryImageUrl } from '../product/product.mapper';
import { logger } from '../common/logger';

const log = logger('reviews');

// ── Request schemas ─────────────────────────────────────────────────────────

/** Trimmed text between `min` and `max` characters, with the design's messages. */
const text = (min: number, max: number, short: string, long: string) =>
  z.unknown().transform((v, ctx) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s.length < min) ctx.addIssue({ code: z.ZodIssueCode.custom, message: short });
    else if (s.length > max) ctx.addIssue({ code: z.ZodIssueCode.custom, message: long });
    return s;
  });

export const ReviewCreateSchema = z.object({
  productId: requiredUuid(),
  rating: z.unknown().transform((v, ctx) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 5) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose a star rating.' });
      return z.NEVER;
    }
    return n;
  }),
  title: text(1, 80, 'Add a short title.', 'Keep the title to 80 characters or fewer.'),
  body: text(20, 2000, 'Write at least 20 characters.', 'Keep your review to 2,000 characters or fewer.'),
  // "Would you recommend this?" defaults to yes.
  recommend: z.preprocess((v) => (v === undefined || v === null ? true : v), flag()),
});

export const ReviewRejectSchema = z.object({ note: optionalString({ max: 1000 }) });

export const PUBLIC_REVIEW_SORTS = ['recent', 'rating'] as const;
export const ADMIN_REVIEW_SORTS = ['createdAt', 'rating', 'status'] as const;
export const isReviewStatus = (v: string): v is ReviewStatus => (REVIEW_STATUSES as readonly string[]).includes(v);

// ── Errors ──────────────────────────────────────────────────────────────────

export class ReviewNotAllowedError extends DomainError {
  constructor() {
    super(403, 'You can review products once your order has been delivered.');
  }
}
export class ReviewExistsError extends DomainError {
  constructor() {
    super(409, "You've already reviewed this product.");
  }
}
const reviewNotFound = (id: string) => new DomainError(404, `Review ${id} was not found`);

// ── Shapes ──────────────────────────────────────────────────────────────────

const PUBLIC_INCLUDE = {
  user: { select: { id: true, fullName: true } },
  product: { select: { color: true, size: true, variantName: true, urlSlug: true, id: true } },
  parent: { select: { name: true } },
} satisfies Prisma.ProductReviewInclude;

type PublicRow = Prisma.ProductReviewGetPayload<{ include: typeof PUBLIC_INCLUDE }>;

const ADMIN_INCLUDE = {
  ...PUBLIC_INCLUDE,
  user: { select: { id: true, fullName: true, email: true } },
  product: { select: { color: true, size: true, variantName: true, urlSlug: true, id: true, sku: true } },
} satisfies Prisma.ProductReviewInclude;

type AdminRow = Prisma.ProductReviewGetPayload<{ include: typeof ADMIN_INCLUDE }>;

/** "Jordan Miller" → "Jordan M." (reviews never show a full name). */
export function reviewAuthor(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** "Indigo · M", else the variant name. */
export function variantLabel(p: { color: string | null; size: string | null; variantName: string | null }) {
  const label = [p.color, p.size].filter(Boolean).join(' · ');
  return label || p.variantName || null;
}

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/**
 * Product reviews (design "Reviews", "Write a review", homepage "What our
 * customers say"). A customer reviews a product (the parent) once, after a
 * delivered purchase of any of its SKUs. Reviews wait for moderation unless
 * REVIEWS_AUTO_PUBLISH; only PUBLISHED ones are shown and counted in the
 * parent's rating rollup, which is recomputed on every change.
 */
export class ReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: Config,
    private readonly mailer: Mailer,
  ) {}

  // ── Customer ─────────────────────────────────────────────────────────────

  /** Delivered purchases still waiting for a review (one per product, latest delivery), and the customer's reviews. */
  async mine(userId: string) {
    const [items, reviews] = await Promise.all([
      this.prisma.orderItem.findMany({
        where: { deleted: false, order: { userId, deleted: false, deliveredAt: { not: null }, status: { in: ['DELIVERED', 'REFUNDED'] } } },
        include: { order: { select: { orderNumber: true, deliveredAt: true } } },
        orderBy: [{ order: { deliveredAt: 'desc' } }, { createdAt: 'asc' }],
      }),
      this.prisma.productReview.findMany({
        where: { userId, deleted: false },
        include: {
          parent: { select: { name: true } },
          product: { include: { images: { where: { deleted: false }, orderBy: { position: 'asc' } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const parents = await this.parentsOf(items.map((i) => i.productId));
    const reviewed = new Set(reviews.map((r) => r.parentId));
    const pending = [];
    for (const item of items) {
      const parentId = parents.get(item.productId);
      if (!parentId || reviewed.has(parentId)) continue;
      reviewed.add(parentId); // one prompt per product
      pending.push({
        productId: item.productId,
        parentId,
        productName: item.productName,
        imageUrl: item.imageUrl,
        variant: variantLabel(item),
        orderNumber: item.order.orderNumber,
        orderItemId: item.id,
        deliveredAt: item.order.deliveredAt,
      });
    }
    return {
      pending,
      reviews: reviews.map((r) => ({
        id: r.id,
        productId: r.productId,
        parentId: r.parentId,
        productName: r.parent.name,
        imageUrl: primaryImageUrl(r.product.images),
        rating: r.rating,
        title: r.title,
        body: r.body,
        recommend: r.recommend,
        status: r.status,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * `productId` is the SKU (or the parent) being reviewed. 403 without a
   * delivered purchase of the parent, 409 when this customer already reviewed it.
   */
  async create(userId: string, input: z.output<typeof ReviewCreateSchema>) {
    const target = await this.resolve(input.productId);
    const purchases = await this.prisma.orderItem.findMany({
      where: {
        deleted: false,
        productId: { in: target.skuIds },
        order: { userId, deleted: false, deliveredAt: { not: null }, status: { in: ['DELIVERED', 'REFUNDED'] } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, productId: true },
    });
    if (!purchases.length) throw new ReviewNotAllowedError();
    // The SKU asked about when it was bought, else the one that was.
    const bought = purchases.find((p) => p.productId === input.productId) ?? purchases[0];
    const publish = this.config.reviews.autoPublish;

    const review = await this.prisma.$transaction(async (tx) => {
      // One review per customer and product: serialise this customer's attempts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`review:${userId}:${target.parentId}`}))`;
      const existing = await tx.productReview.findFirst({ where: { userId, parentId: target.parentId, deleted: false } });
      if (existing) throw new ReviewExistsError();
      const created = await tx.productReview.create({
        data: {
          parentId: target.parentId,
          productId: bought.productId,
          userId,
          orderItemId: bought.id,
          rating: input.rating,
          title: input.title,
          body: input.body,
          recommend: input.recommend,
          status: publish ? 'PUBLISHED' : 'PENDING',
          publishedAt: publish ? new Date() : null,
        },
      });
      if (publish) await recomputeRollup(tx, target.parentId);
      return created;
    }, TX.default);
    return (await this.mine(userId)).reviews.find((r) => r.id === review.id)!;
  }

  /** Soft delete; a published review leaves the rating. */
  async remove(userId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const review = await tx.productReview.findFirst({ where: { id, userId, deleted: false } });
      if (!review) throw reviewNotFound(id);
      await tx.productReview.update({ where: { id }, data: { deleted: true } });
      await recomputeRollup(tx, review.parentId);
    }, TX.default);
  }

  // ── Public ───────────────────────────────────────────────────────────────

  /** A product's published reviews (id = parent or SKU) with the rating summary. */
  async forProduct(id: string, pageable: Pageable) {
    const { parentId } = await this.resolve(id);
    const where = { parentId, status: 'PUBLISHED', deleted: false } satisfies Prisma.ProductReviewWhereInput;
    const byRating = pageable.sort[0]?.field === 'rating';
    const [summary, rows, total] = await Promise.all([
      this.summary(where),
      this.prisma.productReview.findMany({
        where,
        include: PUBLIC_INCLUDE,
        orderBy: byRating ? [{ rating: 'desc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }],
        ...skipTake(pageable),
      }),
      this.prisma.productReview.count({ where }),
    ]);
    return { summary, page: toPage(await this.toPublic(rows), total, pageable) };
  }

  /** Homepage "What our customers say": recent 4★ and 5★ reviews, and the store-wide rating. */
  async featured(limit: number) {
    const published = { status: 'PUBLISHED', deleted: false } satisfies Prisma.ProductReviewWhereInput;
    const [rows, overall] = await Promise.all([
      this.prisma.productReview.findMany({
        where: { ...published, rating: { gte: 4 } },
        include: PUBLIC_INCLUDE,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      }),
      this.prisma.productReview.aggregate({ where: published, _avg: { rating: true }, _count: { _all: true } }),
    ]);
    const reviews = await this.toPublic(rows);
    return {
      average: oneDecimal(overall._avg.rating ?? 0),
      count: overall._count._all,
      reviews: reviews.map((r, i) => ({
        ...r,
        productId: rows[i].productId,
        parentId: rows[i].parentId,
        productName: rows[i].parent.name,
        productSlug: rows[i].product.urlSlug ?? rows[i].product.id,
      })),
    };
  }

  // ── Moderation (catalog staff) ───────────────────────────────────────────

  async adminList(status: ReviewStatus | undefined, pageable: Pageable) {
    const where: Prisma.ProductReviewWhereInput = { deleted: false, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.productReview.findMany({ where, include: ADMIN_INCLUDE, orderBy: orderBy(pageable), ...skipTake(pageable) }),
      this.prisma.productReview.count({ where }),
    ]);
    return toPage(rows.map(toAdminReview), total, pageable);
  }

  publish(id: string, actor: string) {
    return this.moderate(id, ['PENDING', 'REJECTED'], 'PUBLISHED', undefined, actor);
  }

  reject(id: string, note: string | undefined, actor: string) {
    return this.moderate(id, ['PENDING', 'PUBLISHED'], 'REJECTED', note, actor);
  }

  pendingCount() {
    return this.prisma.productReview.count({ where: { status: 'PENDING', deleted: false } });
  }

  private async moderate(id: string, from: ReviewStatus[], to: ReviewStatus, note: string | undefined, actor: string) {
    const row = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.productReview.updateMany({
        where: { id, deleted: false, status: { in: from } },
        data: {
          status: to,
          ...(to === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
          ...(note !== undefined ? { moderatorNote: note } : {}),
        },
      });
      if (count === 0) {
        const current = await tx.productReview.findFirst({ where: { id, deleted: false }, select: { status: true } });
        if (!current) throw reviewNotFound(id);
        throw new DomainError(409, `A ${current.status} review can't be moved to ${to}`);
      }
      const review = await tx.productReview.findUniqueOrThrow({ where: { id }, include: ADMIN_INCLUDE });
      await recomputeRollup(tx, review.parentId);
      return review;
    }, TX.default);

    await this.mailer.send({
      template: 'REVIEW_UPDATE',
      to: row.user.email,
      subject: to === 'PUBLISHED' ? 'Your review is live' : "We couldn't publish your review",
      body: [
        to === 'PUBLISHED'
          ? `Thanks for reviewing ${row.parent.name}. Your review "${row.title}" is now live.`
          : `Your review "${row.title}" of ${row.parent.name} doesn't meet our review guidelines, so it wasn't published.`,
        ...(to === 'REJECTED' && note ? [note] : []),
        '',
        this.config.store.name,
      ].join('\n'),
      userId: row.userId,
    });
    log.info(`Review ${id} ${to.toLowerCase()} by ${actor}`);
    return toAdminReview(row);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** A parent id or SKU id → the parent and all its SKU ids; anything else is a 404. */
  private async resolve(id: string) {
    const parent =
      (await this.prisma.parentProduct.findFirst({ where: { id, deleted: false }, select: { id: true } })) ??
      (await this.prisma.product
        .findFirst({ where: { id, deleted: false }, select: { parent: { select: { id: true, deleted: true } } } })
        .then((p) => (p && !p.parent.deleted ? { id: p.parent.id } : null)));
    if (!parent) throw new ProductNotFoundError(id);
    const skus = await this.prisma.product.findMany({ where: { parentId: parent.id }, select: { id: true } });
    return { parentId: parent.id, skuIds: skus.map((s) => s.id) };
  }

  private async parentsOf(productIds: string[]) {
    const rows = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(productIds)] } },
      select: { id: true, parentId: true },
    });
    return new Map(rows.map((r) => [r.id, r.parentId]));
  }

  private async summary(where: Prisma.ProductReviewWhereInput) {
    const [groups, recommended] = await Promise.all([
      this.prisma.productReview.groupBy({ by: ['rating'], where, _count: { _all: true } }),
      this.prisma.productReview.count({ where: { ...where, recommend: true } }),
    ]);
    const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let sum = 0;
    for (const g of groups) {
      if (g.rating >= 1 && g.rating <= 5) distribution[g.rating as 1 | 2 | 3 | 4 | 5] = g._count._all;
      count += g._count._all;
      sum += g.rating * g._count._all;
    }
    return {
      average: count ? oneDecimal(sum / count) : 0,
      count,
      distribution,
      recommendPercent: count ? Math.round((recommended / count) * 100) : 0,
    };
  }

  /** Public rows: first name + initial, and the city of the reviewer's default address. */
  private async toPublic(rows: PublicRow[]) {
    const addresses = await this.prisma.userAddress.findMany({
      where: { userId: { in: [...new Set(rows.map((r) => r.userId))] }, isDefault: true, deleted: false },
      select: { userId: true, city: true, state: true },
    });
    const location = new Map(addresses.map((a) => [a.userId, `${a.city}, ${a.state}`]));
    return rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      recommend: r.recommend,
      author: reviewAuthor(r.user.fullName),
      location: location.get(r.userId) ?? null,
      variant: variantLabel(r.product),
      verifiedBuyer: r.orderItemId !== null,
      createdAt: r.createdAt,
    }));
  }
}

function toAdminReview(r: AdminRow) {
  return {
    id: r.id,
    status: r.status,
    rating: r.rating,
    title: r.title,
    body: r.body,
    recommend: r.recommend,
    author: reviewAuthor(r.user.fullName),
    customer: { id: r.user.id, name: r.user.fullName, email: r.user.email },
    productId: r.productId,
    parentId: r.parentId,
    productName: r.parent.name,
    sku: r.product.sku,
    variant: variantLabel(r.product),
    verifiedBuyer: r.orderItemId !== null,
    moderatorNote: r.moderatorNote,
    createdAt: r.createdAt,
    publishedAt: r.publishedAt,
  };
}

/** parent_products.rating_avg / rating_count from the PUBLISHED, live reviews. */
export async function recomputeRollup(db: Db, parentId: string) {
  const agg = await db.productReview.aggregate({
    where: { parentId, status: 'PUBLISHED', deleted: false },
    _avg: { rating: true },
    _count: { _all: true },
  });
  await db.parentProduct.update({
    where: { id: parentId },
    data: {
      ratingAvg: new Prisma.Decimal(agg._avg.rating ?? 0).toDecimalPlaces(2),
      ratingCount: agg._count._all,
    },
  });
}
