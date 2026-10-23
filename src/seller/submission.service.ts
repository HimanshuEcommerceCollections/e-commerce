import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient, type ProductCategory } from '@prisma/client';
import { z } from 'zod';
import {
  OPEN_SUBMISSION_STATUSES,
  SUBMISSION_STATUSES,
  type ListingState,
  type ProductStatus,
  type SubmissionKind,
  type SubmissionStatus,
} from '../common/enums';
import { InvalidSubmissionStateError, ProductNotFoundError, SubmissionNotFoundError } from '../common/errors';
import { logger } from '../common/logger';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { withUniqueReference } from '../common/reference';
import { integer, optionalString, requiredString } from '../common/validation';
import type { Config } from '../config';
import { TX } from '../db';
import type { Mailer } from '../notify/mailer';
import type { ImageCheckService } from '../product/image-check';
import {
  ALL_COLUMNS,
  COLUMNS,
  IMAGE_COLUMNS,
  ImportRow,
  PARENT_IMAGE_COLUMNS,
  keyOf,
  normalizeHeader,
  type ImportColumn,
} from '../product/importer/columns';
import type { CatalogExportService } from '../product/importer/export.service';
import type { CatalogFileReader, UploadedFile } from '../product/importer/file-reader';
import type { CatalogImportService, ImportWarning, ImportedRow, RowError } from '../product/importer/import.service';

const log = logger('seller-portal');

/** Time an upload waits for its image URL checks. */
const IMAGE_CHECK_BUDGET_MS = 30_000;
const OPEN = OPEN_SUBMISSION_STATUSES as readonly string[];

const SKU = keyOf(COLUMNS.SKU_ID);
const PARENT = keyOf(COLUMNS.PARENT_PRODUCT_ID);
const STATUS = keyOf(COLUMNS.PRODUCT_STATUS);
const QTY = keyOf(COLUMNS.INVENTORY_QTY);
const IMAGE_URL_COLUMNS: ImportColumn[] = [...IMAGE_COLUMNS, COLUMNS.THUMBNAIL_URL, ...PARENT_IMAGE_COLUMNS];
/** Columns a review never shows as changed: derived or not stored. */
const NOT_COMPARED = new Set([SKU, PARENT, QTY, keyOf(COLUMNS.DISCOUNT), keyOf(COLUMNS.CURRENCY), keyOf(COLUMNS.THUMBNAIL_URL)]);
const NUMERIC = new Set(
  [COLUMNS.MRP, COLUMNS.SELLING_PRICE, COLUMNS.COST, COLUMNS.TAX_RATE, COLUMNS.LOW_STOCK_THRESHOLD].map(keyOf),
);
const CASE_INSENSITIVE = new Set([STATUS, keyOf(COLUMNS.FEATURED)]);

export interface Actor {
  id: string;
  email: string;
}

/** Form submissions: template rows keyed by column header, as an upload would send them. */
export const SubmissionFormSchema = z.object({
  rows: z
    .array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .min(1, 'must not be empty')
    .max(100, 'must have at most 100 rows'),
  note: optionalString({ max: 2000 }),
});

export const SubmissionNoteSchema = z.object({ note: optionalString({ max: 2000 }) });
export const RequiredNoteSchema = z.object({ note: requiredString({ max: 2000 }) });

export const StockUpdateSchema = z.object({
  items: z
    .array(z.object({ sku: requiredString({ max: 100 }), quantity: integer({ required: true, positiveOrZero: true }) }))
    .min(1, 'must not be empty')
    .max(1000, 'must have at most 1000 items'),
});

export const SUBMISSION_SORTS = ['submittedAt', 'createdAt', 'updatedAt'] as const;

/** Payload of a NEW_PRODUCT submission: the status each draft SKU takes on approval. */
interface NewProductPayload {
  requestedStatus: Record<string, ProductStatus>;
}
/** Payload of an EDIT submission: full template rows (normalized headers), codes filled in. */
interface EditPayload {
  rows: Record<string, string>[];
}

export interface SubmissionSummary {
  reference: string;
  kind: SubmissionKind;
  status: SubmissionStatus;
  parentProductId: string;
  parentProductCode: string;
  productName: string;
  skus: string[];
}

/** Outcome of one seller upload or form: per-row errors, then one submission per product touched. */
export interface SubmissionReport {
  fileName: string;
  totalRows: number;
  acceptedRows: number;
  failedRows: number;
  errors: RowError[];
  warnings: ImportWarning[];
  ignoredColumns: string[];
  /** Submissions created or updated, one per product. */
  submissions: SubmissionSummary[];
  /** Rows saved as drafts without being submitted (Product_Status DRAFT on a product not yet live). */
  draftsSaved: string[];
  /** Rows that matched the live product exactly; nothing to review. */
  unchangedRows: number;
  /** Stock levels applied at once, without review. */
  stockUpdates: StockChange[];
  imagesChecked: boolean;
  durationMs: number;
}

export interface StockChange {
  sku: string;
  from: number;
  to: number;
}

export interface FieldChange {
  column: string;
  before: string;
  after: string;
}

type Planned = ImportedRow & { record: Record<string, string> };

const SUBMISSION_INCLUDE = {
  parentProduct: { select: { id: true, code: true, name: true, brand: true } },
  merchant: { select: { id: true, email: true, fullName: true } },
  reviewer: { select: { id: true, email: true, fullName: true } },
} satisfies Prisma.ProductSubmissionInclude;

type SubmissionRow = Prisma.ProductSubmissionGetPayload<{ include: typeof SUBMISSION_INCLUDE }>;

/**
 * Seller portal (submission and review flow). Every seller change reaches
 * customers only after the catalog team approves it:
 *
 *  - Automated checks first: the importer's validation as a dry run (fields,
 *    categories, duplicates, ownership) plus image URL checks. Failing rows are
 *    rejected at upload with per-row errors; the rest carry on.
 *  - A product that isn't live yet is written as DRAFT SKUs (codes reserved,
 *    invisible to customers) and a NEW_PRODUCT submission asks for it to go live.
 *  - A change to a live product never touches it: the rows wait in an EDIT
 *    submission and replace the live version on approval.
 *  - Stock is the exception: it applies at once, logged as a SELLER stock
 *    movement, and a drop to zero raises an alert for the catalog team.
 *
 * A product has at most one open submission; uploading again while it waits
 * (or after changes were requested) updates that submission, unless a
 * reviewer has it open.
 */
export class SellerSubmissionService {
  private readonly storeName: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: CatalogFileReader,
    private readonly importer: CatalogImportService,
    private readonly exporter: CatalogExportService,
    private readonly images: ImageCheckService,
    private readonly mailer: Mailer,
    config: Config,
  ) {
    this.storeName = config.store.name;
  }

  // ── Seller: submit ────────────────────────────────────────────────────────

  async submitFile(file: UploadedFile | undefined, seller: Actor, note?: string): Promise<SubmissionReport> {
    const parsed = await this.reader.read(file);
    return this.submitRows(file!.originalname, parsed.headers, parsed.rows, seller, 'UPLOAD', note);
  }

  async submitForm(input: z.output<typeof SubmissionFormSchema>, seller: Actor): Promise<SubmissionReport> {
    const rows = input.rows.map((record, i) => {
      const values = new Map<string, string>();
      for (const [header, value] of Object.entries(record)) {
        const key = normalizeHeader(header);
        if (key && !values.has(key)) values.set(key, value === null ? '' : String(value));
      }
      return new ImportRow(i + 1, values);
    });
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r.toRecord())))];
    return this.submitRows('form', headers, rows, seller, 'FORM', input.note);
  }

  private async submitRows(
    fileName: string,
    headers: string[],
    rows: ImportRow[],
    seller: Actor,
    source: 'UPLOAD' | 'FORM',
    note: string | undefined,
  ): Promise<SubmissionReport> {
    const started = Date.now();
    const byRow = new Map(rows.map((r) => [r.rowNumber, r]));

    // 1. Automated checks: everything the importer checks, writing nothing.
    const plan = await this.importer.importRows(fileName, headers, rows, seller.id, {
      staff: false,
      actor: seller.email,
      dryRun: true,
    });
    const errors: RowError[] = [...plan.errors];
    let planned: Planned[] = plan.imported.map((p) => ({
      ...p,
      // Codes frozen as planned, so approval writes exactly the SKUs the seller saw.
      record: { ...byRow.get(p.row)!.toRecord(), [SKU]: p.sku, [PARENT]: p.parentProductId },
    }));
    const reject = (rowNumbers: number[], reason: string) => {
      for (const p of planned.filter((p) => rowNumbers.includes(p.row))) errors.push({ row: p.row, sku: p.sku, reason });
      planned = planned.filter((p) => !rowNumbers.includes(p.row));
    };

    // 2. Image URLs must load: reviewers check quality, not dead links.
    if (this.images.enabled && planned.length) {
      const urlsOf = (p: Planned) =>
        IMAGE_URL_COLUMNS.map((c) => [c.header, p.record[keyOf(c)] ?? ''] as const).filter(([, url]) => url.trim() !== '');
      const checks = await this.images.check(
        [...new Set(planned.flatMap((p) => urlsOf(p).map(([, url]) => url.trim())))],
        Date.now() + IMAGE_CHECK_BUDGET_MS,
      );
      for (const p of [...planned]) {
        const broken = urlsOf(p).filter(([, url]) => checks.get(url.trim())?.ok === false);
        if (broken.length) {
          reject(
            [p.row],
            broken.map(([column, url]) => `${column} '${url}' could not be loaded (${checks.get(url.trim())!.error ?? 'unreachable'})`).join('; '),
          );
        }
      }
    }

    // 3. One product at a time: not live yet → drafts + NEW_PRODUCT; live → EDIT.
    const codes = [...new Set(planned.map((p) => p.parentProductId))];
    const parents = new Map(
      (
        await this.prisma.parentProduct.findMany({
          where: { code: { in: codes } },
          include: {
            variants: { where: { deleted: false }, select: { id: true, sku: true, status: true, stockQuantity: true } },
            submissions: { where: { status: { in: [...OPEN] } } },
          },
        })
      ).map((p) => [p.code, p]),
    );
    const draftRows: Planned[] = [];
    const editGroups = new Map<string, Planned[]>();
    for (const code of codes) {
      const group = planned.filter((p) => p.parentProductId === code);
      const parent = parents.get(code);
      const open = parent?.submissions[0];
      if (open?.status === 'IN_REVIEW') {
        reject(group.map((p) => p.row), `Product ${code} is in review (${open.reference}); wait for the decision before changing it`);
      } else if (open?.kind === 'DELIST') {
        reject(group.map((p) => p.row), `Product ${code} has a delisting request open (${open.reference}); withdraw it first`);
      } else if (parent && isLive(parent.variants)) {
        editGroups.set(code, group);
      } else {
        draftRows.push(...group);
      }
    }

    const submissions: SubmissionSummary[] = [];
    const draftsSaved: string[] = [];
    let unchangedRows = 0;
    const stockUpdates: StockChange[] = [];

    // 4. Products not live yet: write the rows as drafts, then ask for review.
    if (draftRows.length) {
      const requested = new Map<string, ProductStatus>();
      const importRows = draftRows.map((p) => {
        const status = (p.record[STATUS] || 'ACTIVE').toUpperCase() as ProductStatus;
        requested.set(p.sku, status);
        return new ImportRow(p.row, new Map(Object.entries({ ...p.record, [STATUS]: 'DRAFT' })));
      });
      const written = await this.importer.importRows(fileName, withCodeHeaders(headers), importRows, seller.id, {
        staff: false,
        actor: seller.email,
      });
      errors.push(...written.errors);
      const byParent = groupBy(written.imported, (i) => i.parentProductId);
      for (const [code, imported] of byParent) {
        const wanted = Object.fromEntries(
          imported.filter((i) => requested.get(i.sku) !== 'DRAFT').map((i) => [i.sku, requested.get(i.sku)!]),
        );
        draftsSaved.push(...imported.filter((i) => requested.get(i.sku) === 'DRAFT').map((i) => i.sku));
        if (Object.keys(wanted).length === 0) continue;
        submissions.push(await this.openNewProduct(code, wanted, seller, { source, fileName, note }));
      }
    }

    // 5. Live products: stock applies now; everything else waits for review.
    for (const [code, group] of editGroups) {
      const parent = parents.get(code)!;
      const variants = new Map(parent.variants.map((v) => [v.sku, v]));
      // Already validated as a whole number; the importer allows "1,000".
      const quantity = (p: Planned) => Number(p.record[QTY].replace(/,/g, ''));
      const stock = group
        .filter((p) => variants.has(p.sku) && quantity(p) !== variants.get(p.sku)!.stockQuantity)
        .map((p) => ({ sku: p.sku, quantity: quantity(p) }));
      if (stock.length) {
        const applied = await this.updateStock(seller, stock, `Seller upload ${fileName}`);
        stockUpdates.push(...applied.updated);
      }

      const live = await this.exporter.records(group.filter((p) => variants.has(p.sku)).map((p) => p.sku));
      const categories = await this.categories();
      const changed = group.filter((p) => {
        const before = live.get(p.sku);
        return !before || diff(before, p.record, categories).length > 0;
      });
      unchangedRows += group.length - changed.length;
      if (!changed.length) continue;
      submissions.push(await this.openEdit(parent.id, changed.map((p) => p.record), seller, { source, fileName, note }));
    }

    const failed = new Set(errors.map((e) => e.row));
    const report: SubmissionReport = {
      fileName,
      totalRows: rows.length,
      acceptedRows: rows.length - failed.size,
      failedRows: failed.size,
      errors: errors.sort((a, b) => a.row - b.row),
      warnings: plan.warnings,
      ignoredColumns: plan.ignoredColumns,
      submissions,
      draftsSaved,
      unchangedRows,
      stockUpdates,
      imagesChecked: this.images.enabled,
      durationMs: Date.now() - started,
    };
    log.info(
      `Seller ${seller.email} submitted '${fileName}': ${report.totalRows} rows, ${report.failedRows} rejected, ` +
        `${submissions.length} submissions, ${stockUpdates.length} stock updates`,
    );
    return report;
  }

  /** Opens (or updates the open) NEW_PRODUCT submission of a draft product. */
  private async openNewProduct(
    code: string,
    wanted: Record<string, ProductStatus>,
    seller: Actor,
    meta: { source: 'UPLOAD' | 'FORM'; fileName: string | null; note?: string },
  ): Promise<SubmissionSummary> {
    const parent = await this.prisma.parentProduct.findUniqueOrThrow({
      where: { code },
      include: { submissions: { where: { status: { in: [...OPEN] } } } },
    });
    const open = parent.submissions[0];
    if (open) {
      const payload = open.payload as unknown as NewProductPayload;
      return this.resubmit(open.id, { requestedStatus: { ...payload.requestedStatus, ...wanted } }, seller, meta);
    }
    return this.create(parent.id, 'NEW_PRODUCT', { requestedStatus: wanted }, seller, meta);
  }

  /** Opens (or updates the open) EDIT submission of a live product; rows replace earlier ones by SKU. */
  private async openEdit(
    parentId: string,
    rows: Record<string, string>[],
    seller: Actor,
    meta: { source: 'UPLOAD' | 'FORM'; fileName: string | null; note?: string },
  ): Promise<SubmissionSummary> {
    const open = await this.prisma.productSubmission.findFirst({ where: { parentProductId: parentId, status: { in: [...OPEN] } } });
    if (open) {
      const earlier = (open.payload as unknown as EditPayload).rows.filter((r) => !rows.some((n) => n[SKU] === r[SKU]));
      return this.resubmit(open.id, { rows: [...earlier, ...rows] }, seller, meta);
    }
    return this.create(parentId, 'EDIT', { rows }, seller, meta);
  }

  private async create(
    parentId: string,
    kind: SubmissionKind,
    payload: NewProductPayload | EditPayload | Record<string, never>,
    seller: Actor,
    meta: { source: 'UPLOAD' | 'FORM'; fileName: string | null; note?: string },
  ): Promise<SubmissionSummary> {
    const now = new Date();
    const row = await withUniqueReference(
      () => `PS-${randomInt(100_000, 1_000_000)}`,
      (reference) =>
        this.prisma.$transaction(async (tx) => {
          const s = await tx.productSubmission.create({
            data: {
              reference,
              merchantId: seller.id,
              parentProductId: parentId,
              kind,
              status: 'SUBMITTED',
              source: meta.source,
              fileName: meta.fileName?.slice(0, 255) ?? null,
              sellerNote: meta.note ?? null,
              payload: payload as unknown as Prisma.InputJsonValue,
              submittedAt: now,
            },
            include: SUBMISSION_INCLUDE,
          });
          await tx.productSubmissionEvent.create({
            data: { submissionId: s.id, status: 'SUBMITTED', actorId: seller.id, actorEmail: seller.email, note: meta.note ?? null },
          });
          return s;
        }),
    );
    return this.summary(row);
  }

  /** Back in the queue with new content; only while no reviewer has it open. */
  private async resubmit(
    id: string,
    payload: NewProductPayload | EditPayload,
    seller: Actor,
    meta: { source: 'UPLOAD' | 'FORM'; fileName: string | null; note?: string },
  ): Promise<SubmissionSummary> {
    const row = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.productSubmission.updateMany({
        where: { id, status: { in: ['SUBMITTED', 'CHANGES_REQUESTED'] } },
        data: {
          status: 'SUBMITTED',
          payload: payload as unknown as Prisma.InputJsonValue,
          source: meta.source,
          fileName: meta.fileName?.slice(0, 255) ?? null,
          ...(meta.note ? { sellerNote: meta.note } : {}),
          submittedAt: new Date(),
        },
      });
      if (!count) throw new InvalidSubmissionStateError('This product went into review while you were submitting; wait for the decision');
      await tx.productSubmissionEvent.create({
        data: { submissionId: id, status: 'SUBMITTED', actorId: seller.id, actorEmail: seller.email, note: meta.note ?? 'Updated and resubmitted' },
      });
      return tx.productSubmission.findUniqueOrThrow({ where: { id }, include: SUBMISSION_INCLUDE });
    });
    return this.summary(row);
  }

  /** A product saved as drafts goes to review as it stands: every DRAFT SKU asks to go ACTIVE. */
  async submitDraft(parentId: string, seller: Actor, note?: string): Promise<SubmissionSummary> {
    const parent = await this.ownParent(parentId, seller);
    if (parent.submissions.length) throw new InvalidSubmissionStateError(`Product ${parent.code} already has an open submission (${parent.submissions[0].reference})`);
    if (isLive(parent.variants)) throw new InvalidSubmissionStateError(`Product ${parent.code} is already live; upload your changes instead`);
    const drafts = parent.variants.filter((v) => v.status === 'DRAFT');
    if (!drafts.length) throw new InvalidSubmissionStateError(`Product ${parent.code} has no draft SKUs to submit`);
    const wanted = Object.fromEntries(drafts.map((v) => [v.sku, 'ACTIVE' as ProductStatus]));
    return this.create(parent.id, 'NEW_PRODUCT', { requestedStatus: wanted }, seller, { source: 'FORM', fileName: null, note });
  }

  /** Taking a live product off sale is reviewed too, so a seller can't silently empty the catalog. */
  async requestDelist(parentId: string, seller: Actor, reason: string): Promise<SubmissionSummary> {
    const parent = await this.ownParent(parentId, seller);
    if (parent.submissions.length) throw new InvalidSubmissionStateError(`Product ${parent.code} already has an open submission (${parent.submissions[0].reference})`);
    if (!isLive(parent.variants)) throw new InvalidSubmissionStateError(`Product ${parent.code} is not live`);
    return this.create(parent.id, 'DELIST', {}, seller, { source: 'FORM', fileName: null, note: reason });
  }

  async withdraw(reference: string, seller: Actor): Promise<SubmissionSummary> {
    const s = await this.ownSubmission(reference, seller);
    const row = await this.transition(s.id, ['SUBMITTED', 'CHANGES_REQUESTED'], 'WITHDRAWN', seller, null, {
      decidedAt: new Date(),
    });
    return this.summary(row);
  }

  // ── Seller: stock (applies without review) ────────────────────────────────

  /**
   * Sets stock levels on the seller's own SKUs at once (no review: a queued
   * stock update sells things that don't exist). Rows are locked first, so a
   * concurrent checkout is never lost (NFR-08); each change is a SELLER stock
   * movement, and a drop to zero is logged as an alert.
   */
  async updateStock(seller: Actor, items: { sku: string; quantity: number }[], reason = 'Seller stock update') {
    const errors: { sku: string; reason: string }[] = [];
    const seen = new Set<string>();
    const unique = items.filter((i) => {
      if (seen.has(i.sku)) {
        errors.push({ sku: i.sku, reason: 'SKU appears more than once' });
        return false;
      }
      seen.add(i.sku);
      return true;
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      const skus = unique.map((i) => i.sku);
      await tx.$queryRaw`SELECT id FROM products WHERE sku = ANY(${skus}::text[]) AND merchant_id = ${seller.id}::uuid AND deleted = false FOR UPDATE`;
      const current = new Map(
        (await tx.product.findMany({ where: { sku: { in: skus }, merchantId: seller.id, deleted: false } })).map((p) => [p.sku, p]),
      );
      const changes: StockChange[] = [];
      for (const item of unique) {
        const product = current.get(item.sku);
        if (!product) {
          errors.push({ sku: item.sku, reason: 'Unknown SKU' });
          continue;
        }
        if (product.stockQuantity === item.quantity) continue;
        await tx.product.update({ where: { id: product.id }, data: { stockQuantity: item.quantity, version: { increment: 1 } } });
        await tx.stockMovement.create({
          data: {
            productId: product.id,
            delta: item.quantity - product.stockQuantity,
            quantityAfter: item.quantity,
            source: 'SELLER',
            reason: reason.slice(0, 500),
            actor: seller.email,
          },
        });
        changes.push({ sku: item.sku, from: product.stockQuantity, to: item.quantity });
      }
      return changes;
    }, TX.default);
    for (const c of updated.filter((c) => c.to === 0 && c.from > 0)) {
      log.warn(`Stock alert: ${seller.email} set ${c.sku} from ${c.from} to 0`);
    }
    return { updated, errors };
  }

  // ── Seller: read ──────────────────────────────────────────────────────────

  /** The seller's products with the state the seller portal shows. */
  async myProducts(seller: Actor, pageable: Pageable) {
    const where: Prisma.ParentProductWhereInput = { merchantId: seller.id, deleted: false };
    const [rows, total] = await Promise.all([
      this.prisma.parentProduct.findMany({
        where,
        include: {
          variants: { where: { deleted: false }, select: { sku: true, status: true, price: true, stockQuantity: true }, orderBy: { sku: 'asc' } },
          submissions: { where: { status: { in: [...OPEN] } }, select: { reference: true, kind: true, status: true } },
        },
        orderBy: orderBy(pageable),
        ...skipTake(pageable),
      }),
      this.prisma.parentProduct.count({ where }),
    ]);
    return toPage(
      rows.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        brand: p.brand,
        state: listingState(p.variants, p.submissions[0]),
        openSubmission: p.submissions[0] ?? null,
        variants: p.variants.map((v) => ({ sku: v.sku, status: v.status, price: v.price, stockQuantity: v.stockQuantity })),
        updatedAt: p.updatedAt,
      })),
      total,
      pageable,
    );
  }

  async mySubmissions(seller: Actor, filter: { status?: SubmissionStatus }, pageable: Pageable) {
    return this.list({ merchantId: seller.id, ...(filter.status ? { status: filter.status } : {}) }, pageable);
  }

  async mySubmission(reference: string, seller: Actor) {
    return this.detail(await this.ownSubmission(reference, seller));
  }

  // ── Catalog team: review ──────────────────────────────────────────────────

  /** The review queue: open submissions by default, oldest first. */
  async queue(filter: { status?: SubmissionStatus; kind?: SubmissionKind; merchantId?: string }, pageable: Pageable) {
    return this.list(
      {
        status: filter.status ?? { in: ['SUBMITTED', 'IN_REVIEW'] },
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.merchantId ? { merchantId: filter.merchantId } : {}),
      },
      pageable,
    );
  }

  async counts() {
    const grouped = await this.prisma.productSubmission.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(SUBMISSION_STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0]));
  }

  async get(reference: string) {
    return this.detail(await this.find(reference));
  }

  /** A reviewer takes it: the seller can no longer change it until a decision. */
  async claim(reference: string, reviewer: Actor) {
    const s = await this.find(reference);
    if (s.status === 'IN_REVIEW' && s.reviewerId === reviewer.id) return this.detail(s);
    await this.transition(s.id, ['SUBMITTED'], 'IN_REVIEW', reviewer, null, { reviewerId: reviewer.id, reviewStartedAt: new Date() });
    return this.get(reference);
  }

  /**
   * Publishes the change. NEW_PRODUCT: the drafts take their requested status.
   * EDIT: the rows are imported as the seller (only their own products), stock
   * untouched. DELIST: every variant is archived. A failed import leaves the
   * submission in review with the reasons.
   */
  async approve(reference: string, reviewer: Actor, note?: string) {
    let s = await this.find(reference);
    if (s.status === 'SUBMITTED') {
      await this.transition(s.id, ['SUBMITTED'], 'IN_REVIEW', reviewer, null, { reviewerId: reviewer.id, reviewStartedAt: new Date() });
      s = await this.find(reference);
    }
    if (s.status !== 'IN_REVIEW') throw new InvalidSubmissionStateError(`Submission ${reference} is ${s.status}; only submissions waiting for review can be approved`);

    if (s.kind === 'EDIT') {
      const rows = (s.payload as unknown as EditPayload).rows.map((r, i) => new ImportRow(i + 1, new Map(Object.entries(r))));
      const headers = [...new Set(rows.flatMap((r) => Object.keys(r.toRecord())))];
      const result = await this.importer.importRows(`submission ${s.reference}`, headers, rows, s.merchantId, {
        staff: false,
        actor: reviewer.email,
        atomic: true,
        keepStock: true,
      });
      if (result.errors.length) {
        throw new InvalidSubmissionStateError(
          `Submission ${reference} can't be applied: ${result.errors.map((e) => `${e.sku ?? `row ${e.row}`}: ${e.reason}`).join('; ')}`,
        );
      }
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const decided = await this.transitionIn(tx, s.id, ['IN_REVIEW'], 'APPROVED', reviewer, note ?? null, {
        reviewNote: note ?? null,
        decidedAt: new Date(),
      });
      if (s.kind === 'NEW_PRODUCT') {
        for (const [sku, status] of Object.entries((s.payload as unknown as NewProductPayload).requestedStatus)) {
          await tx.product.updateMany({
            where: { sku, parentId: s.parentProductId, status: 'DRAFT', deleted: false },
            data: { status, version: { increment: 1 } },
          });
        }
      } else if (s.kind === 'DELIST') {
        await tx.product.updateMany({
          where: { parentId: s.parentProductId, deleted: false, status: { not: 'ARCHIVED' } },
          data: { status: 'ARCHIVED', version: { increment: 1 } },
        });
      }
      return decided;
    }, TX.default);
    await this.notify(row, `approved${s.kind === 'DELIST' ? ': the product is no longer on sale' : ' and live'}`, note);
    return this.get(reference);
  }

  async requestChanges(reference: string, reviewer: Actor, note: string) {
    const s = await this.find(reference);
    const row = await this.transition(s.id, ['SUBMITTED', 'IN_REVIEW'], 'CHANGES_REQUESTED', reviewer, note, {
      reviewerId: reviewer.id,
      reviewNote: note,
    });
    await this.notify(row, 'returned with changes requested', note);
    return this.get(reference);
  }

  /** Closes it with a reason. A new product's drafts are archived; a live product is untouched. */
  async reject(reference: string, reviewer: Actor, reason: string) {
    const s = await this.find(reference);
    const row = await this.prisma.$transaction(async (tx) => {
      const decided = await this.transitionIn(tx, s.id, ['SUBMITTED', 'IN_REVIEW'], 'REJECTED', reviewer, reason, {
        reviewerId: reviewer.id,
        reviewNote: reason,
        decidedAt: new Date(),
      });
      if (s.kind === 'NEW_PRODUCT') {
        const skus = Object.keys((s.payload as unknown as NewProductPayload).requestedStatus);
        await tx.product.updateMany({
          where: { sku: { in: skus }, parentId: s.parentProductId, status: 'DRAFT', deleted: false },
          data: { status: 'ARCHIVED', version: { increment: 1 } },
        });
      }
      return decided;
    }, TX.default);
    await this.notify(row, 'rejected', reason);
    return this.get(reference);
  }

  /** Seller stock drops to zero in the last `days` days, newest first. */
  async stockAlerts(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.stockMovement.findMany({
      where: { source: 'SELLER', quantityAfter: 0, delta: { lt: 0 }, createdAt: { gte: since } },
      include: { product: { select: { id: true, sku: true, name: true, status: true, merchantId: true, parent: { select: { code: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((m) => ({
      at: m.createdAt,
      sku: m.product.sku,
      productId: m.product.id,
      parentProductCode: m.product.parent.code,
      name: m.product.name,
      status: m.product.status,
      from: m.quantityAfter - m.delta,
      to: m.quantityAfter,
      seller: m.actor,
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async list(where: Prisma.ProductSubmissionWhereInput, pageable: Pageable) {
    const [rows, total] = await Promise.all([
      this.prisma.productSubmission.findMany({ where, include: SUBMISSION_INCLUDE, orderBy: orderBy(pageable), ...skipTake(pageable) }),
      this.prisma.productSubmission.count({ where }),
    ]);
    return toPage(
      rows.map((s) => ({
        ...this.summary(s),
        source: s.source,
        merchant: s.merchant,
        reviewer: s.reviewer,
        submittedAt: s.submittedAt,
        decidedAt: s.decidedAt,
      })),
      total,
      pageable,
    );
  }

  /** The submission with its before/after and history. */
  private async detail(s: SubmissionRow) {
    const events = await this.prisma.productSubmissionEvent.findMany({
      where: { submissionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: { status: true, actorEmail: true, note: true, createdAt: true },
    });
    return {
      ...this.summary(s),
      source: s.source,
      fileName: s.fileName,
      sellerNote: s.sellerNote,
      reviewNote: s.reviewNote,
      merchant: s.merchant,
      reviewer: s.reviewer,
      submittedAt: s.submittedAt,
      reviewStartedAt: s.reviewStartedAt,
      decidedAt: s.decidedAt,
      changes: await this.changes(s),
      events,
    };
  }

  /**
   * Before and after, per SKU. EDIT: the live row against the submitted one
   * (recomputed, so it's always against what customers see now); NEW_PRODUCT
   * and DELIST: the product's current rows, with the status each SKU moves to.
   */
  private async changes(s: SubmissionRow) {
    if (s.kind === 'EDIT') {
      const rows = (s.payload as unknown as EditPayload).rows;
      const live = await this.exporter.records(rows.map((r) => r[SKU]));
      const categories = await this.categories();
      return rows.map((r) => {
        const before = live.get(r[SKU]);
        return before
          ? { sku: r[SKU], action: 'UPDATE' as const, fields: diff(before, r, categories) }
          : { sku: r[SKU], action: 'ADD' as const, fields: added(r) };
      });
    }
    const variants = await this.prisma.product.findMany({
      where: { parentId: s.parentProductId, deleted: false },
      select: { sku: true },
      orderBy: { sku: 'asc' },
    });
    const current = await this.exporter.records(variants.map((v) => v.sku));
    const requested = s.kind === 'NEW_PRODUCT' ? (s.payload as unknown as NewProductPayload).requestedStatus : null;
    return variants
      .filter((v) => !requested || v.sku in requested)
      .map((v) => {
        const record = current.get(v.sku) ?? {};
        const to = requested ? requested[v.sku] : 'ARCHIVED';
        return {
          sku: v.sku,
          action: s.kind === 'NEW_PRODUCT' ? ('ADD' as const) : ('DELIST' as const),
          fields:
            s.kind === 'NEW_PRODUCT'
              ? added({ ...record, [COLUMNS.PRODUCT_STATUS.header]: to })
              : [{ column: COLUMNS.PRODUCT_STATUS.header, before: record[COLUMNS.PRODUCT_STATUS.header] ?? '', after: to }],
        };
      });
  }

  private summary(s: SubmissionRow): SubmissionSummary {
    const skus =
      s.kind === 'EDIT'
        ? (s.payload as unknown as EditPayload).rows.map((r) => r[SKU])
        : s.kind === 'NEW_PRODUCT'
          ? Object.keys((s.payload as unknown as NewProductPayload).requestedStatus)
          : [];
    return {
      reference: s.reference,
      kind: s.kind as SubmissionKind,
      status: s.status as SubmissionStatus,
      parentProductId: s.parentProductId,
      parentProductCode: s.parentProduct.code,
      productName: s.parentProduct.name,
      skus,
    };
  }

  private async transition(
    id: string,
    from: SubmissionStatus[],
    to: SubmissionStatus,
    actor: Actor,
    note: string | null,
    data: Prisma.ProductSubmissionUncheckedUpdateManyInput = {},
  ) {
    return this.prisma.$transaction((tx) => this.transitionIn(tx, id, from, to, actor, note, data), TX.default);
  }

  /** A conditional update: two reviewers (or a reviewer and the seller) can't both move it. */
  private async transitionIn(
    tx: Prisma.TransactionClient,
    id: string,
    from: SubmissionStatus[],
    to: SubmissionStatus,
    actor: Actor,
    note: string | null,
    data: Prisma.ProductSubmissionUncheckedUpdateManyInput = {},
  ) {
    const { count } = await tx.productSubmission.updateMany({ where: { id, status: { in: from } }, data: { ...data, status: to } });
    const row = await tx.productSubmission.findUniqueOrThrow({ where: { id }, include: SUBMISSION_INCLUDE });
    if (!count) {
      throw new InvalidSubmissionStateError(`Submission ${row.reference} is ${row.status}; it can't move to ${to}`);
    }
    await tx.productSubmissionEvent.create({ data: { submissionId: id, status: to, actorId: actor.id, actorEmail: actor.email, note } });
    return row;
  }

  private async find(reference: string): Promise<SubmissionRow> {
    const s = await this.prisma.productSubmission.findUnique({ where: { reference: reference.toUpperCase() }, include: SUBMISSION_INCLUDE });
    if (!s) throw new SubmissionNotFoundError(reference);
    return s;
  }

  /** Another seller's submission is a 404, never a 403: references don't leak. */
  private async ownSubmission(reference: string, seller: Actor): Promise<SubmissionRow> {
    const s = await this.find(reference);
    if (s.merchantId !== seller.id) throw new SubmissionNotFoundError(reference);
    return s;
  }

  private async ownParent(parentId: string, seller: Actor) {
    const parent = await this.prisma.parentProduct.findFirst({
      where: { id: parentId, merchantId: seller.id, deleted: false },
      include: {
        variants: { where: { deleted: false }, select: { sku: true, status: true } },
        submissions: { where: { status: { in: [...OPEN] } } },
      },
    });
    if (!parent) throw new ProductNotFoundError(parentId);
    return parent;
  }

  private async categories() {
    return this.prisma.productCategory.findMany({ where: { deleted: false } });
  }

  /** The seller hears about every decision (log-only mailer for now). */
  private async notify(s: SubmissionRow, outcome: string, note: string | null | undefined) {
    await this.mailer.send({
      template: 'SUBMISSION_UPDATE',
      to: s.merchant.email,
      userId: s.merchantId,
      subject: `${this.storeName}: submission ${s.reference} ${outcome.split(':')[0]}`,
      body:
        `Hi ${s.merchant.fullName}, your submission ${s.reference} for ${s.parentProduct.name} (${s.parentProduct.code}) was ${outcome}.` +
        (note ? `\n\nNote from the catalog team:\n${note}` : ''),
    });
  }
}

/** Live: on sale or suspended. A product with only DRAFT or ARCHIVED SKUs goes through review as new. */
function isLive(variants: { status: string }[]): boolean {
  return variants.some((v) => v.status === 'ACTIVE' || v.status === 'INACTIVE');
}

export function listingState(variants: { status: string }[], open: { kind: string; status: string } | undefined): ListingState {
  if (open) return open.kind === 'NEW_PRODUCT' ? (open.status as ListingState) : 'CHANGE_PENDING';
  if (variants.some((v) => v.status === 'ACTIVE')) return 'LIVE';
  if (variants.some((v) => v.status === 'INACTIVE')) return 'SUSPENDED';
  if (variants.some((v) => v.status === 'DRAFT')) return 'DRAFT';
  return 'ARCHIVED';
}

/** The submitted row's columns that differ from the live row (export headers, normalized keys). */
export function diff(live: Record<string, string>, submitted: Record<string, string>, categories: ProductCategory[]): FieldChange[] {
  const before = new Map(Object.entries(live).map(([h, v]) => [normalizeHeader(h), { header: h, value: v }]));
  const department = (value: string) => resolveCategory(categories.filter((c) => !c.parentId), value);
  const changes: FieldChange[] = [];
  for (const [key, raw] of Object.entries(submitted)) {
    if (NOT_COMPARED.has(key)) continue;
    const after = raw.trim();
    const old = before.get(key);
    const was = old?.value ?? '';
    let same: boolean;
    if (NUMERIC.has(key)) same = sameNumber(was, after);
    else if (CASE_INSENSITIVE.has(key)) same = was.toUpperCase() === after.toUpperCase();
    else if (key === keyOf(COLUMNS.CATEGORY)) same = department(was)?.id === department(after)?.id && !!department(after);
    else if (key === keyOf(COLUMNS.SUBCATEGORY)) {
      const dept = department(submitted[keyOf(COLUMNS.CATEGORY)] ?? live[COLUMNS.CATEGORY.header] ?? '');
      const sections = dept ? categories.filter((c) => c.parentId === dept.id) : [];
      same = (resolveCategory(sections, was)?.id ?? was) === (resolveCategory(sections, after)?.id ?? after);
    } else same = was === after;
    if (!same) changes.push({ column: old?.header ?? headerOf(key), before: was, after });
  }
  return changes;
}

/** Every filled column of a row that adds a SKU. */
function added(record: Record<string, string>): FieldChange[] {
  return Object.entries(record)
    .filter(([key, v]) => v.trim() !== '' && normalizeHeader(key) !== SKU)
    .map(([key, v]) => ({ column: headerOf(normalizeHeader(key)), before: '', after: v.trim() }));
}

const HEADERS = new Map(ALL_COLUMNS.map((c) => [keyOf(c), c.header]));
/** The template's spelling of a normalized header; attribute columns keep theirs. */
const headerOf = (key: string) => HEADERS.get(key) ?? key;

function resolveCategory(candidates: ProductCategory[], value: string): ProductCategory | undefined {
  const key = value.trim().toLowerCase();
  if (!key) return undefined;
  return (
    candidates.find((c) => c.slug.toLowerCase() === key) ??
    candidates.find((c) => c.name.toLowerCase() === key) ??
    candidates.find((c) => c.code?.toLowerCase() === key)
  );
}

function sameNumber(a: string, b: string): boolean {
  if (a === '' || b === '') return a === b;
  try {
    return new Prisma.Decimal(a.replace(/,/g, '')).eq(new Prisma.Decimal(b.replace(/,/g, '')));
  } catch {
    return a === b;
  }
}

/** The headers a re-run needs: the rows now always carry SKU_ID, Parent_Product_ID and Product_Status. */
function withCodeHeaders(headers: string[]): string[] {
  return [...new Set([...headers, SKU, PARENT, STATUS])];
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const i of items) out.set(key(i), [...(out.get(key(i)) ?? []), i]);
  return out;
}
