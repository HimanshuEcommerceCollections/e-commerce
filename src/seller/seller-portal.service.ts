import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { OPEN_SUBMISSION_STATUSES, type SubmissionKind, type SubmissionStatus } from '../common/enums';
import { ProductNotFoundError } from '../common/errors';
import { toPage, type Pageable } from '../common/pagination';
import { ValidationError, decimal, optionalString, requiredString } from '../common/validation';
import type { Config } from '../config';
import { COLUMNS, keyOf } from '../product/importer/columns';
import type { CatalogExportService } from '../product/importer/export.service';
import type { CatalogFileReader, UploadedFile } from '../product/importer/file-reader';
import type { CatalogImportService } from '../product/importer/import.service';
import { listingState, type Actor, type SellerSubmissionService } from './submission.service';

const OPEN = OPEN_SUBMISSION_STATUSES as readonly string[];
const PRICE = keyOf(COLUMNS.SELLING_PRICE);
const SKU = keyOf(COLUMNS.SKU_ID);
const NAME = keyOf(COLUMNS.PRODUCT_NAME);
/** Seller notes of price requests start with one of these lines per SKU (see requestPriceChange). */
const PRICE_LINE = /^Price (\S+): ([\d.]+) → ([\d.]+)$/gm;

/** Orders count for a seller once paid; before that nothing was sold. */
const PAID_ORDER = { deleted: false, paidAt: { not: null } } satisfies Prisma.OrderWhereInput;
/** Fully refunded orders: every seller line counts as refunded. */
const REFUNDED_ORDER_STATUSES = new Set(['CANCELLED', 'REFUNDED']);

export const PriceChangeSchema = z.object({
  items: z
    .array(
      z.object({
        sku: requiredString({ max: 100 }),
        price: decimal({ required: true, positive: true, max: 9_999_999_999 }),
        mrp: decimal({ positive: true, max: 9_999_999_999 }),
      }),
    )
    .min(1, 'must not be empty')
    // The old prices go into the seller note (2,000 characters).
    .max(30, 'must have at most 30 items'),
  note: optionalString({ max: 500 }),
});

export const ORDER_FILTERS = ['TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

const ORDER_FILTER_WHERE: Record<OrderFilter, Prisma.OrderWhereInput> = {
  TO_SHIP: { status: { in: ['PAID', 'CONFIRMED'] } },
  SHIPPED: { status: 'SHIPPED' },
  DELIVERED: { status: 'DELIVERED' },
  CANCELLED: { status: { in: [...REFUNDED_ORDER_STATUSES] } },
};

export interface RowCheck {
  row: number;
  sku: string | null;
  parentProductId: string | null;
  name: string;
  /** OK: goes through; NOTE: goes through with something for the reviewer; FIX: won't be sent. */
  status: 'OK' | 'NOTE' | 'FIX';
  issues: { level: 'error' | 'warning'; message: string }[];
}

/**
 * The seller portal's read models and helpers around the submission flow:
 * the catalog with stock and review state, a dry-run check of an upload,
 * price change requests, the review team's activity, stock history, and the
 * seller's orders and earnings (derived from order lines of their products;
 * there's no payout ledger yet).
 */
export class SellerPortalService {
  private readonly lowStock: number;
  private readonly currency: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: CatalogFileReader,
    private readonly importer: CatalogImportService,
    private readonly exporter: CatalogExportService,
    private readonly submissions: SellerSubmissionService,
    config: Config,
  ) {
    this.lowStock = config.inventory.lowStockThreshold;
    this.currency = config.order.currency;
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  /** Every product of the seller (newest change first), with what the portal shows per SKU. */
  async catalog(seller: Actor) {
    const parents = await this.prisma.parentProduct.findMany({
      where: { merchantId: seller.id, deleted: false },
      include: {
        category: { select: { name: true } },
        subcategory: { select: { name: true } },
        variants: {
          where: { deleted: false },
          orderBy: { sku: 'asc' },
          select: {
            id: true,
            sku: true,
            variantName: true,
            status: true,
            price: true,
            mrp: true,
            stockQuantity: true,
            lowStockThreshold: true,
            createdAt: true,
            updatedAt: true,
            images: { where: { deleted: false }, orderBy: { position: 'asc' }, take: 1, select: { url: true } },
          },
        },
        submissions: {
          where: { status: { in: [...OPEN] } },
          select: { reference: true, kind: true, status: true, reviewNote: true, submittedAt: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 2000,
    });
    const ids = parents.flatMap((p) => p.variants.map((v) => v.id));
    const lastStock = new Map(
      ids.length
        ? (
            await this.prisma.stockMovement.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _max: { createdAt: true } })
          ).map((g) => [g.productId, g._max.createdAt])
        : [],
    );
    return parents.map((p) => {
      const open = p.submissions[0];
      const updated = Math.max(p.updatedAt.getTime(), ...p.variants.map((v) => v.updatedAt.getTime()));
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        brand: p.brand,
        category: p.category?.name ?? null,
        subcategory: p.subcategory?.name ?? null,
        state: listingState(p.variants, open),
        openSubmission: open ?? null,
        imageUrl: p.variants.find((v) => v.images.length)?.images[0].url ?? null,
        updatedAt: new Date(updated),
        variants: p.variants.map((v) => ({
          sku: v.sku,
          variantName: v.variantName,
          status: v.status,
          price: money(v.price),
          mrp: v.mrp ? money(v.mrp) : null,
          stockQuantity: v.stockQuantity,
          lowStockThreshold: v.lowStockThreshold ?? this.lowStock,
          stockUpdatedAt: lastStock.get(v.id) ?? v.createdAt,
        })),
      };
    });
  }

  /** The product's SKUs as template rows (export headers): what an edit form starts from. */
  async rows(parentId: string, seller: Actor) {
    const parent = await this.ownParent(parentId, seller);
    const records = await this.exporter.records(parent.variants.map((v) => v.sku));
    return parent.variants.map((v) => records.get(v.sku)).filter((r): r is Record<string, string> => !!r);
  }

  /** Stock changes of the product's SKUs, newest first. */
  async stockHistory(parentId: string, seller: Actor) {
    const parent = await this.ownParent(parentId, seller);
    const rows = await this.prisma.stockMovement.findMany({
      where: { product: { parentId: parent.id } },
      include: { product: { select: { sku: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((m) => ({
      at: m.createdAt,
      sku: m.product.sku,
      from: m.quantityAfter - m.delta,
      to: m.quantityAfter,
      source: m.source,
      reason: m.reason,
    }));
  }

  // ── Submissions ───────────────────────────────────────────────────────────

  /**
   * The upload's automated checks as a dry run: nothing is written or sent.
   * Image links are only checked when the file is submitted.
   */
  async check(file: UploadedFile | undefined, seller: Actor) {
    const parsed = await this.reader.read(file);
    const plan = await this.importer.importRows(file!.originalname, parsed.headers, parsed.rows, seller.id, {
      staff: false,
      actor: seller.email,
      dryRun: true,
    });
    const results = new Map<number, RowCheck>(
      parsed.rows.map((r) => [
        r.rowNumber,
        { row: r.rowNumber, sku: r.getKey(SKU) || null, parentProductId: null, name: r.getKey(NAME), status: 'OK', issues: [] },
      ]),
    );
    const add = (row: number, level: 'error' | 'warning', message: string) => results.get(row)?.issues.push({ level, message });
    for (const e of plan.errors) add(e.row, 'error', e.reason);
    for (const w of plan.warnings) add(w.row, 'warning', w.message);
    for (const p of plan.imported) {
      const r = results.get(p.row);
      if (!r) continue;
      r.sku = p.sku;
      r.parentProductId = p.parentProductId;
      if (p.action === 'UPDATED') add(p.row, 'warning', 'You already sell this SKU. It will be reviewed as an update.');
    }

    // Same gate as a real upload: a product being reviewed can't change.
    const codes = [...new Set(plan.imported.map((p) => p.parentProductId))];
    const blocked = await this.prisma.productSubmission.findMany({
      where: { parentProduct: { code: { in: codes } }, status: { in: [...OPEN] }, OR: [{ status: 'IN_REVIEW' }, { kind: 'DELIST' }] },
      select: { reference: true, kind: true, parentProduct: { select: { code: true } } },
    });
    for (const s of blocked) {
      for (const p of plan.imported.filter((i) => i.parentProductId === s.parentProduct.code)) {
        add(
          p.row,
          'error',
          s.kind === 'DELIST'
            ? `Product ${s.parentProduct.code} has a delisting request open (${s.reference}); withdraw it first`
            : `Product ${s.parentProduct.code} is in review (${s.reference}); wait for the decision before changing it`,
        );
      }
    }

    const rows = [...results.values()].map((r) => ({
      ...r,
      status: r.issues.some((i) => i.level === 'error') ? 'FIX' : r.issues.length ? 'NOTE' : 'OK',
    })) as RowCheck[];
    return {
      fileName: file!.originalname,
      totalRows: rows.length,
      ready: rows.filter((r) => r.status === 'OK').length,
      withNote: rows.filter((r) => r.status === 'NOTE').length,
      toFix: rows.filter((r) => r.status === 'FIX').length,
      ignoredColumns: plan.ignoredColumns,
      rows,
    };
  }

  /**
   * A new price for SKUs of the seller's product: their current rows with the
   * new Selling_Price (and MRP), submitted for review like any other edit. The
   * old price goes into the seller note, so the change can be shown later.
   */
  async requestPriceChange(parentId: string, seller: Actor, input: z.output<typeof PriceChangeSchema>) {
    const parent = await this.ownParent(parentId, seller);
    const skus = new Set(parent.variants.map((v) => v.sku));
    const unknown = input.items.filter((i) => !skus.has(i.sku)).map((i) => i.sku);
    if (unknown.length) throw new ValidationError({ items: `SKU not in product ${parent.code}: ${unknown.join(', ')}` });

    const live = await this.exporter.records(input.items.map((i) => i.sku));
    const lines: string[] = [];
    const rows = input.items.map((i) => {
      const record = { ...live.get(i.sku)! };
      lines.push(`Price ${i.sku}: ${record[COLUMNS.SELLING_PRICE.header]} → ${i.price.toFixed(2)}`);
      record[COLUMNS.SELLING_PRICE.header] = i.price.toFixed(2);
      if (i.mrp) record[COLUMNS.MRP.header] = i.mrp.toFixed(2);
      // Derived from the two prices; a stale value would only confuse the check.
      record[COLUMNS.DISCOUNT.header] = '';
      return record;
    });
    const note = [...lines, input.note ?? ''].filter(Boolean).join('\n');
    return this.submissions.submitForm({ rows, note }, seller);
  }

  /**
   * Price requests: open ones against today's live price, and those decided
   * in the last 30 days (their old price comes from the request's note).
   */
  async priceChanges(seller: Actor) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const subs = await this.prisma.productSubmission.findMany({
      where: { merchantId: seller.id, kind: 'EDIT', OR: [{ status: { in: [...OPEN] } }, { decidedAt: { gte: since } }] },
      include: { parentProduct: { select: { id: true, name: true } } },
      orderBy: { submittedAt: 'desc' },
      take: 200,
    });
    const skus = subs.flatMap((s) => ((s.payload as { rows?: Record<string, string>[] }).rows ?? []).map((r) => r[SKU]));
    const livePrice = new Map(
      (await this.prisma.product.findMany({ where: { sku: { in: skus }, merchantId: seller.id }, select: { sku: true, price: true } })).map(
        (p) => [p.sku, p.price],
      ),
    );
    const out = [];
    for (const s of subs) {
      const noted = new Map([...(s.sellerNote ?? '').matchAll(PRICE_LINE)].map((m) => [m[1], m[2]]));
      const open = OPEN.includes(s.status);
      for (const row of (s.payload as { rows?: Record<string, string>[] }).rows ?? []) {
        const sku = row[SKU];
        const requested = row[PRICE];
        const live = livePrice.get(sku);
        if (!requested || !live) continue;
        const from = open ? live.toFixed(2) : noted.get(sku);
        if (!from || new Prisma.Decimal(from).eq(new Prisma.Decimal(requested))) continue;
        out.push({
          reference: s.reference,
          status: s.status as SubmissionStatus,
          parentProductId: s.parentProduct.id,
          productName: s.parentProduct.name,
          sku,
          from: money(new Prisma.Decimal(from)),
          to: money(new Prisma.Decimal(requested)),
          submittedAt: s.submittedAt,
          decidedAt: s.decidedAt,
          reviewNote: s.reviewNote,
        });
      }
    }
    return out;
  }

  /** What the catalog team did on the seller's submissions, newest first: the portal's notifications. */
  async activity(seller: Actor, limit: number) {
    const events = await this.prisma.productSubmissionEvent.findMany({
      where: { submission: { merchantId: seller.id }, OR: [{ actorId: null }, { actorId: { not: seller.id } }] },
      include: {
        submission: { select: { reference: true, kind: true, status: true, parentProduct: { select: { id: true, code: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return events.map((e) => ({
      id: e.id,
      at: e.createdAt,
      status: e.status as SubmissionStatus,
      note: e.note,
      reference: e.submission.reference,
      kind: e.submission.kind as SubmissionKind,
      currentStatus: e.submission.status as SubmissionStatus,
      parentProductId: e.submission.parentProduct.id,
      productCode: e.submission.parentProduct.code,
      productName: e.submission.parentProduct.name,
    }));
  }

  // ── Orders and earnings ───────────────────────────────────────────────────

  /** Paid orders with at least one line of the seller's products; only those lines are shown. */
  async orders(seller: Actor, filter: OrderFilter | undefined, pageable: Pageable) {
    const ids = await this.productIds(seller);
    const where: Prisma.OrderWhereInput = {
      ...PAID_ORDER,
      ...(filter ? ORDER_FILTER_WHERE[filter] : {}),
      items: { some: { productId: { in: ids }, deleted: false } },
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          items: { where: { productId: { in: ids }, deleted: false }, orderBy: { createdAt: 'asc' } },
          returns: { where: { status: 'REFUNDED' }, include: { items: true } },
        },
        orderBy: { paidAt: 'desc' },
        skip: pageable.page * pageable.size,
        take: pageable.size,
      }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(
      rows.map((o) => {
        const subtotal = o.items.reduce((sum, i) => sum.plus(i.lineTotal), new Prisma.Decimal(0));
        return {
          orderNumber: o.orderNumber,
          paidAt: o.paidAt,
          status: o.status,
          fulfilmentStatus: o.fulfilmentStatus,
          shippedAt: o.shippedAt,
          deliveredAt: o.deliveredAt,
          // Where it goes, not who: the store ships and talks to the customer.
          shipTo: `${o.shipCity}, ${o.shipState}`,
          items: o.items.map((i) => ({
            sku: i.sku,
            productName: i.productName,
            variantName: i.variantName,
            imageUrl: i.imageUrl,
            quantity: i.quantity,
            returnedQuantity: i.returnedQuantity,
            unitPrice: money(i.unitPrice),
            lineTotal: money(i.lineTotal),
          })),
          subtotal: money(subtotal),
          refunded: money(this.refundedOf(o)),
        };
      }),
      total,
      pageable,
    );
  }

  /**
   * Sales of the seller's products by calendar month (UTC): gross is the
   * value of order lines paid that month, refunds what went back to customers
   * that month (a whole line for a cancelled or refunded order, returned units
   * otherwise). There is no payout ledger, so no payout dates or fees.
   */
  async earnings(seller: Actor, months: number) {
    const ids = await this.productIds(seller);
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const keyOfDate = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const periods = new Map<string, { gross: Prisma.Decimal; refunds: Prisma.Decimal; orders: Set<string>; units: number }>();
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      periods.set(keyOfDate(d), { gross: new Prisma.Decimal(0), refunds: new Prisma.Decimal(0), orders: new Set(), units: 0 });
    }

    const sold = await this.prisma.orderItem.findMany({
      where: { productId: { in: ids }, deleted: false, order: { ...PAID_ORDER, paidAt: { gte: start } } },
      select: { lineTotal: true, quantity: true, orderId: true, order: { select: { paidAt: true, status: true } } },
    });
    for (const i of sold) {
      const p = periods.get(keyOfDate(i.order.paidAt!));
      if (!p) continue;
      p.gross = p.gross.plus(i.lineTotal);
      p.units += i.quantity;
      p.orders.add(i.orderId);
    }

    // Whole-order refunds, dated by the order's last change (when it was cancelled or refunded).
    const cancelled = await this.prisma.orderItem.findMany({
      where: {
        productId: { in: ids },
        deleted: false,
        order: { ...PAID_ORDER, status: { in: [...REFUNDED_ORDER_STATUSES] }, updatedAt: { gte: start } },
      },
      select: { lineTotal: true, order: { select: { updatedAt: true } } },
    });
    for (const i of cancelled) {
      const p = periods.get(keyOfDate(i.order.updatedAt));
      if (p) p.refunds = p.refunds.plus(i.lineTotal);
    }
    const returned = await this.prisma.orderReturnItem.findMany({
      where: {
        orderItem: { productId: { in: ids }, deleted: false },
        orderReturn: { status: 'REFUNDED', refundedAt: { gte: start }, order: { status: { notIn: [...REFUNDED_ORDER_STATUSES] } } },
      },
      select: { quantity: true, orderItem: { select: { unitPrice: true } }, orderReturn: { select: { refundedAt: true } } },
    });
    for (const r of returned) {
      const p = periods.get(keyOfDate(r.orderReturn.refundedAt!));
      if (p) p.refunds = p.refunds.plus(r.orderItem.unitPrice.mul(r.quantity));
    }

    const openOrders = await this.prisma.order.count({
      where: { ...PAID_ORDER, ...ORDER_FILTER_WHERE.TO_SHIP, items: { some: { productId: { in: ids }, deleted: false } } },
    });
    const rows = [...periods.entries()].reverse().map(([period, p]) => ({
      period,
      orders: p.orders.size,
      units: p.units,
      gross: money(p.gross),
      refunds: money(p.refunds),
      net: money(p.gross.minus(p.refunds)),
    }));
    const sum = (f: 'gross' | 'refunds') => [...periods.values()].reduce((s, p) => s.plus(p[f]), new Prisma.Decimal(0));
    return {
      currency: this.currency,
      from: start,
      openOrders,
      periods: rows,
      totals: {
        orders: new Set([...periods.values()].flatMap((p) => [...p.orders])).size,
        units: [...periods.values()].reduce((s, p) => s + p.units, 0),
        gross: money(sum('gross')),
        refunds: money(sum('refunds')),
        net: money(sum('gross').minus(sum('refunds'))),
      },
      /** No payout ledger yet: payout dates, fees and statements are still to come. */
      payoutSchedule: null,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Order lines aren't linked to products by key; a seller's lines are those of SKUs of their parent products. */
  private async productIds(seller: Actor) {
    return (await this.prisma.product.findMany({ where: { parent: { merchantId: seller.id } }, select: { id: true } })).map((p) => p.id);
  }

  private refundedOf(o: {
    status: string;
    items: { id: string; lineTotal: Prisma.Decimal; unitPrice: Prisma.Decimal }[];
    returns: { items: { orderItemId: string; quantity: number }[] }[];
  }) {
    if (REFUNDED_ORDER_STATUSES.has(o.status)) return o.items.reduce((s, i) => s.plus(i.lineTotal), new Prisma.Decimal(0));
    const mine = new Map(o.items.map((i) => [i.id, i]));
    return o.returns
      .flatMap((r) => r.items)
      .filter((ri) => mine.has(ri.orderItemId))
      .reduce((s, ri) => s.plus(mine.get(ri.orderItemId)!.unitPrice.mul(ri.quantity)), new Prisma.Decimal(0));
  }

  private async ownParent(parentId: string, seller: Actor) {
    const parent = await this.prisma.parentProduct.findFirst({
      where: { id: parentId, merchantId: seller.id, deleted: false },
      include: { variants: { where: { deleted: false }, select: { sku: true }, orderBy: { sku: 'asc' } } },
    });
    if (!parent) throw new ProductNotFoundError(parentId);
    return parent;
  }
}
