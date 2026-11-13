import { Prisma, type PrismaClient, type ProductCategory } from '@prisma/client';
import { z } from 'zod';
import type { AuditService } from '../audit/audit.service';
import { SUBMISSION_KINDS, type SubmissionKind, type SubmissionStatus } from '../common/enums';
import { DomainError, InvalidSubmissionStateError, SubmissionNotFoundError } from '../common/errors';
import { toPage, type Pageable } from '../common/pagination';
import { optionalString } from '../common/validation';
import type { Config } from '../config';
import { ALL_COLUMNS, COLUMNS, keyOf, normalizeHeader } from '../product/importer/columns';
import type { CatalogExportService } from '../product/importer/export.service';
import { diff, type Actor, type FieldChange, type SellerSubmissionService } from './submission.service';

/** Queue tabs: open submissions by angle, plus the reviewer's own decisions. */
export const QUEUE_VIEWS = ['all', 'mine', 'new', 'price', 'delist', 'flagged', 'due', 'reviewed'] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

/** A request-changes checklist entry: what the seller has to fix. */
export const FIX_OPTIONS = [
  'Photos',
  'Title',
  'Description',
  'Price',
  'Category',
  'Fiber content',
  'Country of origin',
  'Weight or size',
  'Other',
] as const;

export const REJECT_REASONS = [
  'Restricted or counterfeit brand',
  'Prohibited product',
  'Duplicate of an existing listing',
  'Price looks like an error',
  'Doesn’t meet quality standards',
  'Other',
] as const;

export const DecisionSchema = z
  .object({
    decision: z.enum(['approve', 'request-changes', 'reject'], {
      errorMap: () => ({ message: 'must be one of approve, request-changes, reject' }),
    }),
    reason: z.enum(REJECT_REASONS, { errorMap: () => ({ message: `must be one of ${REJECT_REASONS.join(', ')}` }) }).optional(),
    fixes: z
      .array(z.enum(FIX_OPTIONS, { errorMap: () => ({ message: `must be one of ${FIX_OPTIONS.join(', ')}` }) }))
      .max(FIX_OPTIONS.length)
      .optional(),
    note: optionalString({ max: 1800 }),
  })
  .superRefine((v, ctx) => {
    const note = v.note?.trim() ?? '';
    if (v.decision === 'request-changes') {
      if (!v.fixes?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fixes'], message: 'choose what needs fixing' });
      if (note.length < 5) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'add a note the seller can act on' });
    }
    if (v.decision === 'reject') {
      if (!v.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'choose a reason' });
      if (v.reason === 'Other' && note.length < 5) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'explain the reason' });
    }
  });

export const BulkApproveSchema = z.object({
  references: z
    .array(z.string().regex(/^PS-\d{6}$/i, 'must be a submission reference (PS-123456)'), {
      required_error: 'must not be null',
      invalid_type_error: 'must be an array',
    })
    .min(1, 'must not be empty')
    .max(100, 'must have at most 100 references'),
  note: optionalString({ max: 2000 }),
});

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface QueueCheck {
  key: 'required' | 'duplicates' | 'brand' | 'price_change' | 'margin' | 'mrp' | 'delist_request' | 'stock_on_hand';
  label: string;
  status: CheckStatus;
  detail: string;
}

/** Decision commitment: 2 business days. */
const SLA_HOURS = 48;
const OPEN: SubmissionStatus[] = ['SUBMITTED', 'IN_REVIEW'];
const DECIDED: SubmissionStatus[] = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'];
const MAX_OPEN = 1000;

const INCLUDE = {
  parentProduct: { select: { id: true, code: true, name: true, brand: true } },
  merchant: { select: { id: true, email: true, fullName: true } },
  reviewer: { select: { id: true, email: true, fullName: true } },
} satisfies Prisma.ProductSubmissionInclude;
type Row = Prisma.ProductSubmissionGetPayload<{ include: typeof INCLUDE }>;

const K = {
  sku: keyOf(COLUMNS.SKU_ID),
  name: keyOf(COLUMNS.PRODUCT_NAME),
  brand: keyOf(COLUMNS.BRAND),
  price: keyOf(COLUMNS.SELLING_PRICE),
  mrp: keyOf(COLUMNS.MRP),
  cost: keyOf(COLUMNS.COST),
  qty: keyOf(COLUMNS.INVENTORY_QTY),
};
const REQUIRED = ALL_COLUMNS.filter((c) => c.requiredColumn);
const PRICE_ONLY = new Set([COLUMNS.SELLING_PRICE.header, COLUMNS.MRP.header, COLUMNS.COST.header, COLUMNS.DISCOUNT.header]);

const num = (v: string | undefined) => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const usd = (n: number) => `$${n.toFixed(2)}`;
const signed = (p: number) => `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;

/** Weekday hours elapsed since `t` (UTC), the business clock the 2-day commitment runs on. */
export function businessHoursSince(t: Date, now = new Date()): number {
  let ms = 0;
  let cursor = t.getTime();
  const end = now.getTime();
  while (cursor < end) {
    const d = new Date(cursor);
    const nextDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const stop = Math.min(nextDay, end);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) ms += stop - cursor;
    cursor = stop;
  }
  return ms / 3_600_000;
}

export function slaState(submittedAt: Date, now = new Date()) {
  const hours = businessHoursSince(submittedAt, now);
  const left = SLA_HOURS - hours;
  return { businessHours: Math.round(hours * 10) / 10, hoursLeft: Math.round(left * 10) / 10, state: left <= 0 ? 'overdue' : left <= 24 ? 'due_soon' : 'on_track' } as const;
}

interface Analysed {
  row: Row;
  type: 'new' | 'edit' | 'price' | 'delist';
  checks: QueueCheck[];
  priceChange: { sku: string; from: number; to: number; percent: number; skus: number } | null;
}

/**
 * The catalog team's review queue on top of the submission flow: tabs,
 * automatic checks per submission (computed on read, against the live
 * catalog), price history, structured decisions and bulk approval.
 */
export class ReviewQueueService {
  private readonly restricted: Set<string>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly exporter: CatalogExportService,
    private readonly submissions: SellerSubmissionService,
    private readonly audit: AuditService,
    private readonly checksConfig: Config['reviewChecks'],
  ) {
    this.restricted = new Set(checksConfig.restrictedBrands.map((b) => b.toLowerCase()));
  }

  async queue(
    filter: { view: QueueView; kind?: SubmissionKind; merchantId?: string; q?: string },
    reviewer: Actor,
    pageable: Pageable,
  ) {
    if (filter.view === 'reviewed') return this.reviewed(filter, reviewer, pageable);
    const now = new Date();
    const items = (await this.analyseOpen()).filter((a) => {
      if (filter.kind && a.row.kind !== filter.kind) return false;
      if (filter.merchantId && a.row.merchantId !== filter.merchantId) return false;
      if (filter.q && !matches(a.row, filter.q)) return false;
      return inView(a, filter.view, reviewer, now);
    });
    const start = pageable.page * pageable.size;
    return toPage(items.slice(start, start + pageable.size).map((a) => this.view(a, reviewer, now)), items.length, pageable);
  }

  async counts(reviewer: Actor) {
    const now = new Date();
    const open = await this.analyseOpen();
    const count = (v: QueueView) => open.filter((a) => inView(a, v, reviewer, now)).length;
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [reviewed, reviewedToday] = await Promise.all([
      this.prisma.productSubmission.count({ where: { reviewerId: reviewer.id, status: { in: DECIDED } } }),
      this.prisma.productSubmission.count({
        where: {
          reviewerId: reviewer.id,
          status: { in: DECIDED },
          OR: [{ decidedAt: { gte: startOfDay } }, { status: 'CHANGES_REQUESTED', updatedAt: { gte: startOfDay } }],
        },
      }),
    ]);
    return {
      all: open.length,
      mine: count('mine'),
      new: count('new'),
      price: count('price'),
      delist: count('delist'),
      flagged: count('flagged'),
      due: count('due'),
      dueSoon: open.filter((a) => slaState(a.row.submittedAt, now).state === 'due_soon').length,
      overdue: open.filter((a) => slaState(a.row.submittedAt, now).state === 'overdue').length,
      reviewed,
      reviewedToday,
    };
  }

  /** One submission with its checks, price history and its neighbours in the queue (oldest first). */
  async item(reference: string, reviewer: Actor) {
    const row = await this.find(reference);
    const [analysed] = await this.analyse([row]);
    const now = new Date();
    const open = OPEN.includes(row.status as SubmissionStatus)
      ? (await this.prisma.productSubmission.findMany({
          where: { status: { in: OPEN } },
          select: { reference: true },
          orderBy: [{ submittedAt: 'asc' }, { reference: 'asc' }],
          take: MAX_OPEN,
        })).map((s) => s.reference)
      : [];
    const at = open.indexOf(row.reference);
    return {
      ...this.view(analysed, reviewer, now),
      priceHistory: await this.priceHistory(analysed),
      previous: at > 0 ? open[at - 1] : null,
      next: at >= 0 && at < open.length - 1 ? open[at + 1] : null,
    };
  }

  /**
   * A decision with structured reasons. The seller gets the checklist and
   * note as one message; the audit log keeps them apart. Approval is refused
   * while a required check fails.
   */
  async decide(reference: string, input: z.output<typeof DecisionSchema>, reviewer: Actor) {
    const note = input.note?.trim() || undefined;
    if (input.decision === 'approve') {
      const [analysed] = await this.analyse([await this.find(reference)]);
      const failed = analysed.checks.filter((c) => c.status === 'fail');
      if (failed.length) {
        throw new InvalidSubmissionStateError(
          `${reference} can't be approved: ${failed.map((c) => `${c.label} (${c.detail})`).join('; ')}. Request changes or reject it.`,
        );
      }
      return this.submissions.approve(reference, reviewer, note);
    }
    if (input.decision === 'request-changes') {
      const fixes = input.fixes ?? [];
      const message = `What needs fixing: ${fixes.join(', ')}\n\n${note ?? ''}`.trim();
      return this.submissions.requestChanges(reference, reviewer, message, { fixes, message: note ?? null });
    }
    const message = `Reason: ${input.reason}${note ? `\n\n${note}` : ''}`;
    return this.submissions.reject(reference, reviewer, message, { reason: input.reason, message: note ?? null });
  }

  /**
   * Approves several submissions one by one. Anything with a check that
   * didn't pass is skipped: flagged items are reviewed on their own.
   */
  async bulkApprove(references: string[], reviewer: Actor, note?: string) {
    const unique = [...new Set(references.map((r) => r.toUpperCase()))];
    const rows = await this.prisma.productSubmission.findMany({ where: { reference: { in: unique } }, include: INCLUDE });
    const analysed = new Map((await this.analyse(rows)).map((a) => [a.row.reference, a]));
    const results: Array<{ reference: string; approved: boolean; status?: string; error?: string }> = [];
    for (const reference of unique) {
      const a = analysed.get(reference);
      if (!a) {
        results.push({ reference, approved: false, error: 'Submission not found' });
        continue;
      }
      const notPassed = a.checks.filter((c) => c.status !== 'pass');
      if (notPassed.length) {
        results.push({ reference, approved: false, error: `Flagged (${notPassed.map((c) => c.label).join(', ')}): review it on its own` });
        continue;
      }
      try {
        const done = await this.submissions.approve(reference, reviewer, note, { bulk: true });
        results.push({ reference, approved: true, status: done.status });
      } catch (e) {
        results.push({ reference, approved: false, error: e instanceof DomainError ? e.message : 'Could not be approved' });
      }
    }
    return { approved: results.filter((r) => r.approved).length, skipped: results.filter((r) => !r.approved).length, results };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async reviewed(filter: { kind?: SubmissionKind; merchantId?: string; q?: string }, reviewer: Actor, pageable: Pageable) {
    const q = filter.q?.trim();
    const where: Prisma.ProductSubmissionWhereInput = {
      reviewerId: reviewer.id,
      status: { in: DECIDED },
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.merchantId ? { merchantId: filter.merchantId } : {}),
      ...(q
        ? {
            OR: [
              { reference: { contains: q, mode: 'insensitive' } },
              { parentProduct: { name: { contains: q, mode: 'insensitive' } } },
              { parentProduct: { code: { contains: q, mode: 'insensitive' } } },
              { merchant: { fullName: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.productSubmission.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ updatedAt: 'desc' }],
        skip: pageable.page * pageable.size,
        take: pageable.size,
      }),
      this.prisma.productSubmission.count({ where }),
    ]);
    const now = new Date();
    return toPage(
      rows.map((row) => this.view({ row, type: typeOf(row, []), checks: [], priceChange: null }, reviewer, now)),
      total,
      pageable,
    );
  }

  private async analyseOpen(): Promise<Analysed[]> {
    const rows = await this.prisma.productSubmission.findMany({
      where: { status: { in: OPEN } },
      include: INCLUDE,
      orderBy: [{ submittedAt: 'asc' }, { reference: 'asc' }],
      take: MAX_OPEN,
    });
    return this.analyse(rows);
  }

  /** Pending SKU records and the checks over them, for many submissions at once. */
  private async analyse(rows: Row[]): Promise<Analysed[]> {
    if (!rows.length) return [];
    const skusOf = (r: Row) =>
      r.kind === 'EDIT'
        ? ((r.payload as { rows?: Record<string, string>[] }).rows ?? []).map((x) => x[K.sku])
        : r.kind === 'NEW_PRODUCT'
          ? Object.keys((r.payload as { requestedStatus?: Record<string, string> }).requestedStatus ?? {})
          : [];
    const allSkus = [...new Set(rows.flatMap(skusOf))];
    const delists = rows.filter((r) => r.kind === 'DELIST').map((r) => r.parentProductId);
    const [live, categories, delistStock] = await Promise.all([
      this.exporter.records(allSkus),
      this.prisma.productCategory.findMany({ where: { deleted: false } }),
      delists.length
        ? this.prisma.product.findMany({
            where: { parentId: { in: delists }, deleted: false },
            select: { id: true, parentId: true, stockQuantity: true },
          })
        : Promise.resolve([]),
    ]);
    const recentOrders = delistStock.length
      ? await this.prisma.orderItem.groupBy({
          by: ['productId'],
          where: { productId: { in: delistStock.map((p) => p.id) }, deleted: false, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
          _sum: { quantity: true },
        })
      : [];

    // The pending version of each SKU, normalized keys: live merged with the submitted row.
    const pendingOf = (r: Row) =>
      skusOf(r).map((sku) => {
        const base = Object.fromEntries(Object.entries(live.get(sku) ?? {}).map(([h, v]) => [normalizeHeader(h), v]));
        const submitted = r.kind === 'EDIT' ? ((r.payload as { rows: Record<string, string>[] }).rows.find((x) => x[K.sku] === sku) ?? {}) : {};
        return { sku, record: { ...base, ...submitted } as Record<string, string>, live: live.get(sku), submitted };
      });

    const names = new Set<string>();
    const pending = new Map(rows.map((r) => [r.id, pendingOf(r)]));
    for (const r of rows) {
      const name = pending.get(r.id)![0]?.record[K.name]?.trim() || r.parentProduct.name;
      if (r.kind !== 'DELIST' && name) names.add(name.toLowerCase());
    }
    const twins = names.size
      ? await this.prisma.parentProduct.findMany({
          where: { deleted: false, OR: [...names].map((n) => ({ name: { equals: n, mode: 'insensitive' as const } })) },
          select: { id: true, code: true, name: true, brand: true, merchantId: true, variants: { where: { deleted: false }, select: { status: true } } },
          take: 500,
        })
      : [];

    return rows.map((row) => {
      const skus = pending.get(row.id)!;
      if (row.kind === 'DELIST') {
        const stock = delistStock.filter((p) => p.parentId === row.parentProductId);
        const units = stock.reduce((n, p) => n + p.stockQuantity, 0);
        const ordered = recentOrders.filter((o) => stock.some((p) => p.id === o.productId)).reduce((n, o) => n + (o._sum.quantity ?? 0), 0);
        return {
          row,
          type: 'delist' as const,
          priceChange: null,
          checks: [
            { key: 'delist_request', label: 'Seller request', status: 'pass', detail: row.sellerNote ? `Reason: ${row.sellerNote}` : 'No reason given' },
            {
              key: 'stock_on_hand',
              label: 'Stock still on hand',
              status: units > 0 ? 'warn' : 'pass',
              detail: `${units} unit(s) · ${ordered} sold in the last 30 days`,
            },
          ] satisfies QueueCheck[],
        };
      }

      const fieldChanges: FieldChange[] = [];
      if (row.kind === 'EDIT') {
        for (const s of skus) if (s.live) fieldChanges.push(...diff(s.live, s.submitted as Record<string, string>, categories as ProductCategory[]));
      }
      const checks: QueueCheck[] = [];

      // 1. Required fields on every pending SKU.
      const missing = skus
        .map((s) => ({ sku: s.sku, cols: REQUIRED.filter((c) => !(s.record[keyOf(c)] ?? '').trim()).map((c) => c.header) }))
        .filter((m) => m.cols.length);
      checks.push(
        !skus.length
          ? { key: 'required', label: 'Required fields', status: 'fail', detail: 'No SKUs found for this submission' }
          : missing.length
            ? {
                key: 'required',
                label: 'Required fields',
                status: 'fail',
                detail: missing.slice(0, 3).map((m) => `${m.sku}: missing ${m.cols.join(', ')}`).join('; ') + (missing.length > 3 ? ` (+${missing.length - 3} more)` : ''),
              }
            : { key: 'required', label: 'Required fields', status: 'pass', detail: 'Title, category, price, stock and main image on every SKU' },
      );

      // 2. Duplicates: another product with the same title.
      const name = skus[0]?.record[K.name]?.trim() || row.parentProduct.name;
      const twin = twins.find(
        (t) => t.id !== row.parentProductId && t.name.toLowerCase() === name.toLowerCase() && t.variants.some((v) => v.status !== 'ARCHIVED'),
      );
      if (row.kind === 'NEW_PRODUCT' || fieldChanges.some((f) => f.column === COLUMNS.PRODUCT_NAME.header)) {
        checks.push(
          twin
            ? {
                key: 'duplicates',
                label: 'Duplicates',
                status: 'warn',
                detail: `Same title as ${twin.code}${twin.merchantId === row.merchantId ? ' (same seller)' : ''}`,
              }
            : { key: 'duplicates', label: 'Duplicates', status: 'pass', detail: 'No match in the catalog' },
        );
      }

      // 3. Restricted brands.
      const brand = (skus[0]?.record[K.brand] ?? row.parentProduct.brand ?? '').trim();
      checks.push(
        brand && this.restricted.has(brand.toLowerCase())
          ? { key: 'brand', label: 'Restricted brands', status: 'fail', detail: `“${brand}” is on the restricted brands list` }
          : { key: 'brand', label: 'Restricted brands', status: 'pass', detail: brand ? 'Not on the restricted list' : 'No brand given' },
      );

      // 4. Size of a price change.
      let priceChange: Analysed['priceChange'] = null;
      const changed = skus
        .map((s) => ({ sku: s.sku, from: num(s.live?.[COLUMNS.SELLING_PRICE.header]), to: num(s.record[K.price]) }))
        .filter((c): c is { sku: string; from: number; to: number } => row.kind === 'EDIT' && c.from !== null && c.to !== null && c.from !== c.to);
      if (changed.length) {
        const biggest = changed.reduce((a, b) => (Math.abs((b.to - b.from) / b.from) > Math.abs((a.to - a.from) / a.from) ? b : a));
        const percent = ((biggest.to - biggest.from) / biggest.from) * 100;
        priceChange = { sku: biggest.sku, from: biggest.from, to: biggest.to, percent: Math.round(percent * 10) / 10, skus: changed.length };
        const big = Math.abs(percent) >= this.checksConfig.bigPriceChangePercent;
        checks.push({
          key: 'price_change',
          label: 'Size of change',
          status: big ? 'warn' : 'pass',
          detail: `${signed(percent)} vs live price on ${biggest.sku} (${usd(biggest.from)} → ${usd(biggest.to)})${big ? `, at least ${this.checksConfig.bigPriceChangePercent}%` : ''}`,
        });
      }

      // 5. Margin floor over cost, and price at or below MRP.
      const floor = this.checksConfig.marginFloorPercent;
      const priced = skus.map((s) => ({ sku: s.sku, price: num(s.record[K.price]), cost: num(s.record[K.cost]), mrp: num(s.record[K.mrp]) }));
      const withCost = priced.filter((p) => p.price !== null && p.price > 0 && p.cost !== null);
      const thin = withCost
        .map((p) => ({ ...p, margin: ((p.price! - p.cost!) / p.price!) * 100 }))
        .filter((p) => p.margin < floor);
      checks.push(
        thin.length
          ? {
              key: 'margin',
              label: 'Margin floor',
              status: 'fail',
              detail: `${thin[0].sku}: ${usd(thin[0].price!)} over cost ${usd(thin[0].cost!)} is a ${thin[0].margin.toFixed(0)}% margin. Floor: ${floor}%${thin.length > 1 ? ` (+${thin.length - 1} more SKU)` : ''}`,
            }
          : {
              key: 'margin',
              label: 'Margin floor',
              status: 'pass',
              detail: withCost.length ? `Meets the ${floor}% floor on ${withCost.length} SKU(s)` : `No cost given, so the ${floor}% floor isn't checked`,
            },
      );
      const overMrp = priced.filter((p) => p.price !== null && p.mrp !== null && p.mrp > 0 && p.price > p.mrp);
      if (priced.some((p) => p.mrp !== null && p.mrp > 0)) {
        checks.push(
          overMrp.length
            ? { key: 'mrp', label: 'Price at or below MRP', status: 'fail', detail: `${overMrp[0].sku}: ${usd(overMrp[0].price!)} > ${usd(overMrp[0].mrp!)}` }
            : { key: 'mrp', label: 'Price at or below MRP', status: 'pass', detail: 'Every price is at or below its MRP' },
        );
      }

      return { row, type: typeOf(row, fieldChanges), checks, priceChange };
    });
  }

  /** Price changes of the submission's SKUs from the audit log, newest first. */
  private async priceHistory(a: Analysed) {
    const skus = a.row.kind === 'EDIT' ? ((a.row.payload as { rows?: Record<string, string>[] }).rows ?? []).map((r) => r[K.sku]) : [];
    if (!skus.length) return [];
    const events = await this.prisma.auditEvent.findMany({
      where: { category: 'price', entityCode: { in: skus } },
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: 30,
    });
    return events.map((e) => ({
      at: e.createdAt,
      sku: e.entityCode,
      action: e.action,
      before: e.beforeValue,
      after: e.afterValue,
      summary: e.summary,
      actor: e.actorName ?? e.actorEmail,
      source: e.source,
      note: e.note,
    }));
  }

  private view(a: Analysed, reviewer: Actor, now: Date) {
    const r = a.row;
    const skus =
      r.kind === 'EDIT'
        ? ((r.payload as { rows?: Record<string, string>[] }).rows ?? []).map((x) => x[K.sku])
        : r.kind === 'NEW_PRODUCT'
          ? Object.keys((r.payload as { requestedStatus?: Record<string, string> }).requestedStatus ?? {})
          : [];
    return {
      reference: r.reference,
      kind: r.kind as SubmissionKind,
      type: a.type,
      status: r.status as SubmissionStatus,
      parentProductId: r.parentProductId,
      parentProductCode: r.parentProduct.code,
      productName: r.parentProduct.name,
      brand: r.parentProduct.brand,
      skus,
      source: r.source,
      fileName: r.fileName,
      /** Rows of one upload share a batch: the bulk-approve unit. */
      batch: r.source === 'UPLOAD' && r.fileName ? `${r.merchantId.slice(0, 8)}:${r.fileName}` : null,
      sellerNote: r.sellerNote,
      reviewNote: r.reviewNote,
      merchant: r.merchant,
      reviewer: r.reviewer,
      assignedToMe: r.reviewerId === reviewer.id && r.status === 'IN_REVIEW',
      submittedAt: r.submittedAt,
      decidedAt: r.decidedAt,
      updatedAt: r.updatedAt,
      sla: OPEN.includes(r.status as SubmissionStatus) ? slaState(r.submittedAt, now) : null,
      priceChange: a.priceChange,
      checks: a.checks,
      flagged: a.checks.some((c) => c.status !== 'pass'),
      blocked: a.checks.some((c) => c.status === 'fail'),
    };
  }

  private async find(reference: string): Promise<Row> {
    const s = await this.prisma.productSubmission.findUnique({ where: { reference: reference.toUpperCase() }, include: INCLUDE });
    if (!s) throw new SubmissionNotFoundError(reference);
    return s;
  }
}

export const isQueueView = (v: string): v is QueueView => (QUEUE_VIEWS as readonly string[]).includes(v);
export const isSubmissionKind = (v: string): v is SubmissionKind => (SUBMISSION_KINDS as readonly string[]).includes(v);

/** An EDIT that only touches prices is a price change. */
function typeOf(row: Row, changes: FieldChange[]): Analysed['type'] {
  if (row.kind === 'NEW_PRODUCT') return 'new';
  if (row.kind === 'DELIST') return 'delist';
  return changes.length && changes.every((c) => PRICE_ONLY.has(c.column)) ? 'price' : 'edit';
}

function inView(a: Analysed, view: QueueView, reviewer: Actor, now: Date): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'mine':
      return a.row.reviewerId === reviewer.id && a.row.status === 'IN_REVIEW';
    case 'new':
      return a.row.kind === 'NEW_PRODUCT';
    case 'price':
      return a.priceChange !== null;
    case 'delist':
      return a.row.kind === 'DELIST';
    case 'flagged':
      return a.checks.some((c) => c.status !== 'pass');
    case 'due':
      return slaState(a.row.submittedAt, now).state !== 'on_track';
    default:
      return false;
  }
}

function matches(row: Row, q: string): boolean {
  const needle = q.trim().toLowerCase();
  const skus = row.kind === 'EDIT' ? ((row.payload as { rows?: Record<string, string>[] }).rows ?? []).map((r) => r[K.sku]) : Object.keys((row.payload as { requestedStatus?: object }).requestedStatus ?? {});
  return [row.reference, row.parentProduct.name, row.parentProduct.code, row.merchant.fullName, row.merchant.email, ...skus]
    .some((v) => v?.toLowerCase().includes(needle));
}
