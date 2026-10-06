import { randomUUID } from 'node:crypto';
import { Prisma, type ParentProduct, type PrismaClient, type ProductCategory } from '@prisma/client';
import { PRODUCT_STATUSES, type ProductStatus } from '../../common/enums';
import { logger } from '../../common/logger';
import { TX } from '../../db';
import type { ImageCheckService, UrlCheck } from '../image-check';
import { attributeKeysFor, attributeName } from './attributes';
import { CodeAssigner, type ParentRef } from './code-assigner';
import {
  COLUMNS,
  IMAGE_COLUMNS,
  PARENT_IMAGE_COLUMNS,
  isKnownHeader,
  type ImportColumn,
  type ImportRow,
} from './columns';
import type { CatalogFileReader, UploadedFile } from './file-reader';
import { baseProductName } from './sku-codes';
import { MAX_SLUG_LENGTH, SLUG, nextFree, slugify } from './slugs';

const log = logger('catalog-import');

const CODE = /^[A-Za-z0-9._-]+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const THOUSANDS = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const MAX_MONEY = new Prisma.Decimal('9999999999.99'); // numeric(12,2)
const MAX_INT = 2_147_483_647;
/** Time the import waits for image URL checks; the rest finish in the background. */
const IMAGE_CHECK_BUDGET_MS = 30_000;

export interface RowError {
  row: number;
  sku: string | null;
  reason: string;
}

export interface ImportWarning {
  row: number;
  sku: string | null;
  message: string;
}

/** An image URL that failed its check (FR-IM-08); the product is imported anyway. */
export interface ImportImageError {
  row: number;
  sku: string | null;
  column: string;
  url: string;
  reason: string;
}

export interface ImportedRow {
  row: number;
  sku: string;
  parentProductId: string;
  /** Whether the importer generated the SKU (the row had no SKU_ID). */
  generated: boolean;
  action: 'CREATED' | 'UPDATED';
}

/** Outcome of one import file. Valid rows import even when others fail (FR-IM-06/07). */
export interface CatalogImportReport {
  fileName: string;
  totalRows: number;
  importedRows: number;
  createdRows: number;
  updatedRows: number;
  failedRows: number;
  parentProductsCreated: number;
  parentProductsUpdated: number;
  /** File columns the importer doesn't read (not in the template or the department's attribute sheet). */
  ignoredColumns: string[];
  /** The SKU and parent code of every imported row, generated or given. */
  imported: ImportedRow[];
  errors: RowError[];
  warnings: ImportWarning[];
  imageErrors: ImportImageError[];
  /** False when image URL checks are switched off (IMAGE_CHECKS_ENABLED=false). */
  imagesChecked: boolean;
  durationMs: number;
}

export interface ImportOptions {
  /** Catalog staff (admins, ROLE_CATALOG) manage every product; a merchant only its own. */
  staff?: boolean;
  /** Who imports, for the stock movement log. */
  actor?: string | null;
  /**
   * `upsert` (default): a row naming an existing SKU updates it (FR-IM-09).
   * `create`: every row is a new SKU and together they form one new parent product (Add product).
   */
  mode?: 'upsert' | 'create';
  /** Write nothing unless every row is valid (Add product). */
  atomic?: boolean;
}

type Existing = Prisma.ProductGetPayload<{ include: { parent: true; images: true } }>;

/** Validation state of one row; the parsed fields are meaningful only while it is valid. */
export class RowResult {
  readonly reasons: string[] = [];
  /** Given in the file, or generated when `generated`; empty until then. */
  sku = '';
  /** True when the row had no SKU_ID, so the importer assigns one. */
  generated = false;
  /** True when the parent code is generated (no Parent_Product_ID, and the SKU doesn't name a parent). */
  parentGenerated = false;
  /** Given, the row's own SKU, the existing SKU's parent, or generated; empty until then. */
  parentCode = '';
  /** The SKU already in the catalog that this row updates. */
  existing: Existing | null = null;
  name: string | null = null;
  /** Product_Name without the variant part, e.g. " — Black, M"; names a new parent. */
  baseName = '';
  /** The department. */
  category: ProductCategory | null = null;
  subcategory: ProductCategory | null = null;
  status: ProductStatus | null = null;
  price: Prisma.Decimal | null = null;
  quantity: number | null = null;
  mrp: Prisma.Decimal | null = null;
  cost: Prisma.Decimal | null = null;
  taxRate: Prisma.Decimal | null = null;
  lowStockThreshold: number | null = null;
  featured: boolean | null = null;
  imageUrls: string[] = [];
  /** Text cells by column header, null when blank. */
  readonly text = new Map<string, string | null>();
  /** Category attribute values by attribute name; null clears it on a re-import. */
  readonly attributes: Record<string, string | null> = {};
  urlSlug: string | null = null;
  /** The SKU's products.id once saved. */
  productId: string | null = null;

  constructor(readonly row: ImportRow) {}

  reject(reason: string) {
    this.reasons.push(reason);
  }

  get valid() {
    return this.reasons.length === 0;
  }

  str(column: ImportColumn): string | null {
    return this.text.get(column.header) ?? null;
  }

  get brand() {
    return this.str(COLUMNS.BRAND);
  }
  get color() {
    return this.str(COLUMNS.COLOR);
  }
  get size() {
    return this.str(COLUMNS.SIZE);
  }
  get variantName() {
    return this.str(COLUMNS.VARIANT_NAME);
  }
}

/** Text columns, with their maximum length (the column's size). */
const TEXT_COLUMNS: [ImportColumn, number][] = [
  [COLUMNS.BRAND, 100],
  [COLUMNS.PRODUCT_TYPE, 100],
  [COLUMNS.VARIANT_NAME, 150],
  [COLUMNS.COLOR, 50],
  [COLUMNS.SIZE, 50],
  [COLUMNS.MATERIAL, 100],
  [COLUMNS.PATTERN, 100],
  [COLUMNS.STYLE, 100],
  [COLUMNS.TAX_CODE, 50],
  [COLUMNS.SUPPLIER_ID, 100],
  [COLUMNS.WAREHOUSE_ID, 100],
  [COLUMNS.SHIPPING_CLASS, 50],
  [COLUMNS.SHORT_DESCRIPTION, 1000],
  [COLUMNS.LONG_DESCRIPTION, 10000],
  [COLUMNS.KEY_FEATURES, 5000],
  [COLUMNS.SPECIFICATIONS, 10000],
  [COLUMNS.DIMENSIONS, 255],
  [COLUMNS.WEIGHT, 100],
  [COLUMNS.WHATS_INCLUDED, 5000],
  [COLUMNS.USAGE_INSTRUCTIONS, 5000],
  [COLUMNS.WARRANTY, 500],
  [COLUMNS.SEO_TITLE, 255],
  [COLUMNS.META_DESCRIPTION, 500],
  [COLUMNS.SEARCH_KEYWORDS, 1000],
];

/**
 * Bulk catalog import from the structured template (FR-IM-01..09): parent
 * products with their variant SKUs, every master column, the department's
 * attribute columns, upsert by SKU_ID and image URL checks.
 *
 * Each row either passes every check or is rejected with all of its reasons;
 * rejected rows never stop valid ones from importing (FR-IM-06/07). Checks:
 *  1. mandatory fields, formats and lengths; the category and subcategory exist (FR-IM-04);
 *  2. SKU_ID unique within the file — every row sharing a SKU is rejected (FR-IM-05);
 *  3. a SKU_ID already in the catalog is updated in place (FR-IM-09), if the
 *     importer may edit it and the row keeps its parent product;
 *  4. rows of one parent product agree on its category;
 *  5. URL_Slug unique.
 *
 * Rows sharing a Parent_Product_ID become variants of one parent; a row without
 * one is a single-variant product whose parent code is its SKU. A parent takes
 * its details from its first valid row in the file; on a re-import only the
 * columns the file has are overwritten (a blank cell clears a value).
 *
 * Valid rows are written in one transaction, which holds a lock so concurrent
 * imports never pick the same generated codes. Image URLs are checked after
 * the write (FR-IM-08): a broken image never stops its product importing.
 */
export class CatalogImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: CatalogFileReader,
    private readonly images: ImageCheckService,
    private readonly currency: string,
  ) {}

  async importFile(file: UploadedFile | undefined, merchantId: string, options: ImportOptions = {}): Promise<CatalogImportReport> {
    const parsed = await this.reader.read(file);
    return this.importRows(file!.originalname, parsed.headers, parsed.rows, merchantId, options);
  }

  async importRows(
    fileName: string,
    headers: string[],
    rows: ImportRow[],
    merchantId: string,
    options: ImportOptions = {},
  ): Promise<CatalogImportReport> {
    const started = Date.now();
    const mode = options.mode ?? 'upsert';
    const staff = options.staff ?? false;
    const categories = new CategoryLookup(await this.prisma.productCategory.findMany({ where: { deleted: false } }));
    const attributeHeaders = headers.filter((h) => !isKnownHeader(h) && attributeName(h) !== undefined);
    const usedAttributeHeaders = new Set<string>();

    const results = rows.map((row) => validate(row, categories, this.currency, mode, attributeHeaders, usedAttributeHeaders));
    rejectDuplicatesInFile(results, (r) => (r.generated ? '' : r.sku), (list) => `SKU_ID appears more than once in the file (rows ${list})`);
    const warnings = thumbnailWarnings(results);

    let parentsCreated = 0;
    let parentsUpdated = 0;
    const writable = () => (options.atomic ? results.every((r) => r.valid) : results.some((r) => r.valid));
    if (writable()) {
      [parentsCreated, parentsUpdated] = await this.prisma.$transaction(async (tx) => {
        // Serializes imports, so concurrent ones never pick the same codes or slugs.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('catalog-import-codes'))`;
        await checkExistingSkus(tx, results, merchantId, mode, staff);
        const parents = await rejectParentConflicts(tx, results, merchantId, staff);
        if (results.some((r) => r.valid && (r.generated || r.parentGenerated))) {
          await new CodeAssigner(tx, merchantId, parents, {
            staff,
            forceNewParent: mode === 'create',
            allowUpdates: mode === 'upsert',
          }).assign(results);
        }
        await loadExisting(tx, results);
        await assignSlugs(tx, results);
        if (!writable()) return [0, 0];
        return save(tx, results.filter((r) => r.valid), parents, merchantId, `${options.actor ?? ''}`.trim() || null, fileName);
      }, TX.catalogImport);
    }
    // Nothing was written when an atomic import has an invalid row.
    const valid = writable() ? results.filter((r) => r.valid).sort((a, b) => a.row.rowNumber - b.row.rowNumber) : [];

    const imageErrors = await this.checkImages(valid);

    const errors = results
      .filter((r) => !r.valid)
      .sort((a, b) => a.row.rowNumber - b.row.rowNumber)
      .map((r) => ({ row: r.row.rowNumber, sku: r.sku || null, reason: r.reasons.join('; ') }));
    const imported = valid.map((r) => ({
      row: r.row.rowNumber,
      sku: r.sku,
      parentProductId: r.parentCode,
      generated: r.generated,
      action: r.existing ? ('UPDATED' as const) : ('CREATED' as const),
    }));
    const updatedRows = imported.filter((i) => i.action === 'UPDATED').length;

    const report: CatalogImportReport = {
      fileName,
      totalRows: results.length,
      importedRows: valid.length,
      createdRows: valid.length - updatedRows,
      updatedRows,
      failedRows: errors.length,
      parentProductsCreated: parentsCreated,
      parentProductsUpdated: parentsUpdated,
      ignoredColumns: headers.filter((h) => !isKnownHeader(h) && !usedAttributeHeaders.has(h)),
      imported,
      errors,
      warnings: warnings.filter((w) => valid.some((r) => r.row.rowNumber === w.row)),
      imageErrors,
      imagesChecked: this.images.enabled,
      durationMs: Date.now() - started,
    };
    log.info(
      `Catalog import '${fileName}' by ${options.actor ?? merchantId}: ${report.totalRows} rows, ` +
        `${report.createdRows} created, ${report.updatedRows} updated, ${report.failedRows} rejected, ` +
        `${report.imageErrors.length} image errors, ${report.durationMs} ms`,
    );
    return report;
  }

  /** FR-IM-08: checks the imported rows' image URLs; broken ones are flagged, never fatal. */
  private async checkImages(valid: RowResult[]): Promise<ImportImageError[]> {
    if (!this.images.enabled || valid.length === 0) return [];
    const deadline = Date.now() + IMAGE_CHECK_BUDGET_MS;
    const ids = valid.map((r) => r.productId).filter((id): id is string => !!id);
    const gallery = await this.images.checkProducts(ids, deadline);
    const parentUrls = valid.flatMap((r) => PARENT_IMAGE_COLUMNS.map((c) => r.str(c)).filter((u): u is string => !!u));
    const parentChecks = parentUrls.length ? await this.images.check(parentUrls, deadline) : new Map<string, UrlCheck>();

    const errors: ImportImageError[] = [];
    for (const r of valid) {
      for (const column of [...IMAGE_COLUMNS, COLUMNS.THUMBNAIL_URL, ...PARENT_IMAGE_COLUMNS]) {
        const url = r.str(column);
        if (!url) continue;
        const result = gallery.get(url) ?? parentChecks.get(url);
        if (result && !result.ok) {
          errors.push({ row: r.row.rowNumber, sku: r.sku, column: column.header, url, reason: result.error ?? 'Unreachable' });
        }
      }
    }
    return errors;
  }
}

// ── Row validation ──────────────────────────────────────────────────────────

function validate(
  row: ImportRow,
  categories: CategoryLookup,
  currency: string,
  mode: 'upsert' | 'create',
  attributeHeaders: string[],
  usedAttributeHeaders: Set<string>,
): RowResult {
  const r = new RowResult(row);

  r.sku = row.get(COLUMNS.SKU_ID);
  if (!r.sku) r.generated = true;
  else checkCode(r, COLUMNS.SKU_ID, r.sku);

  const parentCode = row.get(COLUMNS.PARENT_PRODUCT_ID);
  if (parentCode) checkCode(r, COLUMNS.PARENT_PRODUCT_ID, parentCode);
  if (parentCode) r.parentCode = parentCode;
  else if (r.generated || mode === 'create') r.parentGenerated = true;
  else r.parentCode = r.sku; // may become the existing SKU's parent (checkExistingSkus)

  r.name = required(r, COLUMNS.PRODUCT_NAME, 255);
  for (const [column, max] of TEXT_COLUMNS) r.text.set(column.header, optional(r, column, max));
  // Key features: one per line, or separated by '|'.
  const features = r.str(COLUMNS.KEY_FEATURES);
  if (features) r.text.set(COLUMNS.KEY_FEATURES.header, features.split(/\s*\|\s*|\r?\n/).map((f) => f.trim()).filter(Boolean).join('\n'));
  if (r.name) r.baseName = baseProductName(r.name, r.color, r.size);

  const category = row.get(COLUMNS.CATEGORY);
  if (!category) r.reject('Category is required');
  else {
    const found = categories.department(category, r);
    if (found) {
      r.category = found.department;
      r.subcategory = found.subcategory;
    }
  }
  const subcategory = row.get(COLUMNS.SUBCATEGORY);
  if (subcategory && r.category) {
    const sub = categories.subcategory(r.category, subcategory);
    if (!sub) r.reject(`Unknown subcategory '${subcategory}' for category '${r.category.name}'`);
    else if (r.subcategory && r.subcategory.id !== sub.id) {
      r.reject(`Subcategory '${subcategory}' does not match category '${category}'`);
    } else r.subcategory = sub;
  }

  r.status = parseStatus(r);
  r.featured = parseFlag(r, COLUMNS.FEATURED);
  r.price = parseMoney(r, COLUMNS.SELLING_PRICE, { required: true, positive: true });
  r.mrp = parseMoney(r, COLUMNS.MRP, { positive: false });
  if (r.mrp?.isZero()) r.mrp = null; // 0 means "no MRP"
  if (r.mrp && r.price && r.mrp.lt(r.price)) r.reject('MRP must not be less than Selling_Price');
  r.cost = parseMoney(r, COLUMNS.COST, { positive: false });
  r.taxRate = parsePercent(r, COLUMNS.TAX_RATE);
  parsePercent(r, COLUMNS.DISCOUNT); // derived from MRP and Selling_Price; checked, not stored
  r.quantity = parseInteger(r, COLUMNS.INVENTORY_QTY, true);
  r.lowStockThreshold = parseInteger(r, COLUMNS.LOW_STOCK_THRESHOLD, false);
  const rowCurrency = row.get(COLUMNS.CURRENCY);
  if (rowCurrency && rowCurrency.toUpperCase() !== currency) {
    r.reject(`Currency '${rowCurrency}' is not the store currency ${currency}`);
  }
  r.imageUrls = parseImages(r);

  const slug = row.get(COLUMNS.URL_SLUG);
  if (slug) {
    const lower = slug.toLowerCase();
    if (lower.length > MAX_SLUG_LENGTH) r.reject(`URL_Slug must be at most ${MAX_SLUG_LENGTH} characters`);
    else if (!SLUG.test(lower)) r.reject(`URL_Slug '${slug}' may contain only lowercase letters, digits and single hyphens`);
    else r.urlSlug = lower;
  }

  if (r.category) {
    const allowed = attributeKeysFor(r.category);
    for (const header of attributeHeaders) {
      if (!allowed.has(header)) continue;
      usedAttributeHeaders.add(header);
      const value = row.getKey(header);
      const name = attributeName(header)!;
      if (value.length > 255) r.reject(`${name} must be at most 255 characters`);
      else r.attributes[name] = value || null;
    }
  }
  return r;
}

function checkCode(r: RowResult, column: ImportColumn, value: string) {
  if (value.length > 100) r.reject(`${column.header} must be at most 100 characters`);
  else if (!CODE.test(value)) r.reject(`${column.header} may contain only letters, digits, '.', '_' and '-'`);
}

function required(r: RowResult, column: ImportColumn, maxLength: number): string | null {
  const value = r.row.get(column);
  if (!value) {
    r.reject(`${column.header} is required`);
    return null;
  }
  return checkLength(r, column, value, maxLength);
}

function optional(r: RowResult, column: ImportColumn, maxLength: number): string | null {
  const value = r.row.get(column);
  return value ? checkLength(r, column, value, maxLength) : null;
}

function checkLength(r: RowResult, column: ImportColumn, value: string, maxLength: number): string | null {
  if (value.length > maxLength) {
    r.reject(`${column.header} must be at most ${maxLength} characters`);
    return null;
  }
  return value;
}

function parseStatus(r: RowResult): ProductStatus | null {
  const value = r.row.get(COLUMNS.PRODUCT_STATUS);
  if (!value) {
    r.reject('Product_Status is required');
    return null;
  }
  const upper = value.toUpperCase() as ProductStatus;
  if (!PRODUCT_STATUSES.includes(upper)) {
    r.reject(`Product_Status '${value}' is not one of DRAFT, ACTIVE, INACTIVE, ARCHIVED`);
    return null;
  }
  return upper;
}

const TRUE = new Set(['TRUE', 'YES', 'Y', '1']);
const FALSE = new Set(['FALSE', 'NO', 'N', '0']);

function parseFlag(r: RowResult, column: ImportColumn): boolean | null {
  const value = r.row.get(column);
  if (!value) return r.row.has(column) ? false : null;
  if (TRUE.has(value.toUpperCase())) return true;
  if (FALSE.has(value.toUpperCase())) return false;
  r.reject(`${column.header} '${value}' is not one of TRUE, FALSE`);
  return null;
}

function parseNumber(value: string): Prisma.Decimal | null {
  const plain = THOUSANDS.test(value) ? value.replaceAll(',', '') : value;
  return NUMBER.test(plain) ? new Prisma.Decimal(plain) : null;
}

export function parseMoney(r: RowResult, column: ImportColumn, rules: { required?: boolean; positive: boolean }): Prisma.Decimal | null {
  const value = r.row.get(column);
  if (!value) {
    if (rules.required) r.reject(`${column.header} is required`);
    return null;
  }
  const n = parseNumber(value);
  if (!n) r.reject(`${column.header} '${value}' is not a number`);
  else if (rules.positive && n.lte(0)) r.reject(`${column.header} must be greater than 0`);
  else if (n.lt(0)) r.reject(`${column.header} must not be negative`);
  else if (n.decimalPlaces() > 2) r.reject(`${column.header} must have at most 2 decimal places`);
  else if (n.gt(MAX_MONEY)) r.reject(`${column.header} is too large`);
  else return n;
  return null;
}

/** Percent 0–100 with up to 2 decimals; "18%" is read as 18. */
export function parsePercent(r: RowResult, column: ImportColumn): Prisma.Decimal | null {
  const value = r.row.get(column);
  if (!value) return null;
  const n = parseNumber(value.replace(/\s*%$/, ''));
  if (!n) r.reject(`${column.header} '${value}' is not a number`);
  else if (n.lt(0) || n.gt(100)) r.reject(`${column.header} must be between 0 and 100`);
  else if (n.decimalPlaces() > 2) r.reject(`${column.header} must have at most 2 decimal places`);
  else return n;
  return null;
}

export function parseInteger(r: RowResult, column: ImportColumn, isRequired: boolean): number | null {
  const value = r.row.get(column);
  if (!value) {
    if (isRequired) r.reject(`${column.header} is required`);
    return null;
  }
  const n = parseNumber(value);
  if (!n || !n.isInteger()) r.reject(`${column.header} '${value}' is not a whole number`);
  else if (n.lt(0)) r.reject(`${column.header} must not be negative`);
  else if (n.gt(MAX_INT)) r.reject(`${column.header} is too large`);
  else return n.toNumber();
  return null;
}

/** Image URLs are only read from the template, never embedded (FR-IM-03). */
function parseImages(r: RowResult): string[] {
  const urls: string[] = [];
  for (const column of [...IMAGE_COLUMNS, COLUMNS.THUMBNAIL_URL, ...PARENT_IMAGE_COLUMNS]) {
    const value = r.row.get(column);
    if (!value) continue;
    if (value.length > 2048) r.reject(`${column.header} must be at most 2048 characters`);
    else if (!isHttpUrl(value)) r.reject(`${column.header} '${value}' is not an http(s) URL`);
    else {
      r.text.set(column.header, value);
      if (IMAGE_COLUMNS.includes(column)) urls.push(value);
    }
  }
  // The thumbnail stands in for the gallery only when the row has no other image.
  const thumbnail = r.str(COLUMNS.THUMBNAIL_URL);
  if (urls.length === 0 && thumbnail) urls.push(thumbnail);
  if (urls.length === 0 && !IMAGE_COLUMNS.some((c) => r.row.get(c)) && !r.row.get(COLUMNS.THUMBNAIL_URL)) {
    r.reject('At least one image URL (Image_1_URL … Image_5_URL) is required');
  }
  return [...new Set(urls)];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** Every row sharing a key is rejected: the importer can't know which one is right. */
function rejectDuplicatesInFile(results: RowResult[], keyOf: (r: RowResult) => string, reason: (rows: string) => string) {
  const byKey = new Map<string, RowResult[]>();
  for (const r of results) {
    const key = keyOf(r);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue;
    const list = rows.map((r) => r.row.rowNumber).join(', ');
    for (const r of rows) r.reject(reason(list));
  }
}

function thumbnailWarnings(results: RowResult[]): ImportWarning[] {
  const first = results.find((r) => {
    const t = r.str(COLUMNS.THUMBNAIL_URL);
    return t && r.imageUrls.length > 0 && !r.imageUrls.includes(t);
  });
  return first
    ? [{
        row: first.row.rowNumber,
        sku: first.sku || null,
        message: 'Thumbnail_URL is not stored when a row has Image_N_URL images: the storefront uses the first image as the thumbnail',
      }]
    : [];
}

// ── Cross-row checks (in the import transaction) ─────────────────────────────

/**
 * FR-IM-05/09: a SKU_ID in the catalog is updated in place — when the importer
 * may edit it (catalog staff: any; a merchant: its own) and the row keeps the
 * SKU's parent product. A row without a Parent_Product_ID stays with it.
 */
async function checkExistingSkus(
  tx: Prisma.TransactionClient,
  results: RowResult[],
  merchantId: string,
  mode: 'upsert' | 'create',
  staff: boolean,
) {
  const candidates = [...new Set(results.filter((r) => r.valid && !r.generated).map((r) => r.sku))];
  if (!candidates.length) return;
  const existing = new Map(
    (
      await tx.product.findMany({
        where: { sku: { in: candidates } },
        select: { sku: true, deleted: true, merchantId: true, parent: { select: { code: true } } },
      })
    ).map((p) => [p.sku, p]),
  );
  for (const r of results) {
    const p = r.valid && !r.generated ? existing.get(r.sku) : undefined;
    if (!p) continue;
    const given = r.row.get(COLUMNS.PARENT_PRODUCT_ID);
    if (mode === 'create' || p.deleted || (!staff && p.merchantId !== merchantId)) {
      r.reject('SKU_ID already exists in the catalog');
    } else if (given && given !== p.parent.code) {
      r.reject(`SKU_ID belongs to parent product '${p.parent.code}', not '${given}'`);
    } else {
      r.parentCode = p.parent.code;
    }
  }
}

/**
 * Variants of one parent share its category. An existing parent fixes it;
 * otherwise the group's first valid row does. Returns the existing parents
 * the valid rows attach to, keyed by code.
 */
async function rejectParentConflicts(tx: Prisma.TransactionClient, results: RowResult[], merchantId: string, staff: boolean) {
  const codes = [...new Set(results.filter((r) => r.valid && r.parentCode).map((r) => r.parentCode))];
  const existing = new Map<string, ParentProduct & { category: ProductCategory | null }>();
  if (codes.length) {
    for (const p of await tx.parentProduct.findMany({ where: { code: { in: codes } }, include: { category: true } })) {
      existing.set(p.code, p);
    }
  }

  const firstRowOfGroup = new Map<string, RowResult>();
  for (const r of results) {
    if (!r.valid || !r.parentCode) continue;
    const parent = existing.get(r.parentCode);
    if (parent) {
      if (parent.deleted || (!staff && parent.merchantId !== merchantId)) {
        r.reject(`Parent_Product_ID '${r.parentCode}' is already used by another product`);
      } else if (parent.categoryId !== r.category!.id) {
        r.reject(
          `Category '${r.category!.name}' does not match the existing parent product '${r.parentCode}' ` +
            `(${parent.category?.name ?? 'no category'})`,
        );
      }
      continue;
    }
    const first = firstRowOfGroup.get(r.parentCode);
    if (!first) {
      firstRowOfGroup.set(r.parentCode, r);
    } else if (first.category!.id !== r.category!.id) {
      r.reject(
        `Category '${r.category!.name}' differs from the other variants of '${r.parentCode}' ` +
          `(row ${first.row.rowNumber}: ${first.category!.name})`,
      );
    }
  }
  const parents = new Map<string, ParentRef>();
  for (const [code, p] of existing) parents.set(code, { id: p.id, categoryId: p.categoryId });
  return parents;
}

/** The catalog rows of the SKUs being updated, locked against concurrent checkouts (NFR-08). */
async function loadExisting(tx: Prisma.TransactionClient, results: RowResult[]) {
  const skus = results.filter((r) => r.valid && r.sku).map((r) => r.sku);
  if (!skus.length) return;
  await tx.$queryRaw`SELECT id FROM products WHERE sku = ANY(${skus}::text[]) AND deleted = false FOR UPDATE`;
  const found = new Map(
    (
      await tx.product.findMany({
        where: { sku: { in: skus }, deleted: false },
        include: { parent: true, images: { where: { deleted: false }, orderBy: { position: 'asc' } } },
      })
    ).map((p) => [p.sku, p]),
  );
  for (const r of results) if (r.valid) r.existing = found.get(r.sku) ?? null;
}

/**
 * NFR-04: every SKU gets a unique URL slug. A given URL_Slug must be free (or
 * already the SKU's own); a blank one keeps the SKU's slug, or is generated
 * from the product name and variant ("crew-tee-black-m", then "-2"…).
 */
async function assignSlugs(tx: Prisma.TransactionClient, results: RowResult[]) {
  rejectDuplicatesInFile(
    results.filter((r) => r.valid),
    (r) => r.urlSlug ?? '',
    (list) => `URL_Slug appears more than once in the file (rows ${list})`,
  );
  const given = results.filter((r) => r.valid && r.urlSlug);
  if (given.length) {
    const owners = new Map(
      (
        await tx.product.findMany({ where: { urlSlug: { in: given.map((r) => r.urlSlug!) } }, select: { sku: true, urlSlug: true } })
      ).map((p) => [p.urlSlug!, p.sku]),
    );
    for (const r of given) {
      const owner = owners.get(r.urlSlug!);
      if (owner && owner !== r.sku) r.reject(`URL_Slug '${r.urlSlug}' is already used by SKU ${owner}`);
    }
  }

  const taken = new Set(results.filter((r) => r.valid && r.urlSlug).map((r) => r.urlSlug!));
  const pending: RowResult[] = [];
  for (const r of results) {
    if (!r.valid || r.urlSlug) continue;
    if (r.existing?.urlSlug) {
      taken.add(r.existing.urlSlug);
      continue;
    }
    const variant = [r.color, r.size].filter(Boolean).join(' ') || r.variantName || '';
    const base = slugify(`${r.baseName} ${variant}`) || slugify(r.sku) || 'product';
    r.urlSlug = nextFree(base, taken);
    pending.push(r);
  }
  // A generated slug may belong to a product outside this file.
  while (pending.length) {
    const clash = new Set(
      (await tx.product.findMany({ where: { urlSlug: { in: pending.map((r) => r.urlSlug!) } }, select: { urlSlug: true } })).map(
        (p) => p.urlSlug!,
      ),
    );
    const again = pending.filter((r) => clash.has(r.urlSlug!));
    for (const r of again) r.urlSlug = nextFree(r.urlSlug!, taken);
    pending.splice(0, pending.length, ...again);
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Only the columns the file has: undefined leaves a stored value alone on a re-import. */
const ifPresent = <T>(r: RowResult, column: ImportColumn, value: T): T | undefined => (r.row.has(column) ? value : undefined);

function parentContent(r: RowResult) {
  const keyed = (c: ImportColumn) => ifPresent(r, c, r.str(c));
  return {
    name: r.baseName,
    brand: keyed(COLUMNS.BRAND),
    shortDescription: keyed(COLUMNS.SHORT_DESCRIPTION),
    description: keyed(COLUMNS.LONG_DESCRIPTION),
    subcategoryId: r.subcategory ? r.subcategory.id : r.row.has(COLUMNS.SUBCATEGORY) ? null : undefined,
    productType: keyed(COLUMNS.PRODUCT_TYPE),
    keyFeatures: keyed(COLUMNS.KEY_FEATURES),
    whatsIncluded: keyed(COLUMNS.WHATS_INCLUDED),
    usageInstructions: keyed(COLUMNS.USAGE_INSTRUCTIONS),
    warranty: keyed(COLUMNS.WARRANTY),
    lifestyleImageUrl: keyed(COLUMNS.LIFESTYLE_IMAGE_URL),
    sizeChartUrl: keyed(COLUMNS.SIZE_CHART_URL),
    infographicUrl: keyed(COLUMNS.INFOGRAPHIC_URL),
    featured: r.featured ?? undefined,
  };
}

function variantContent(r: RowResult) {
  const keyed = (c: ImportColumn) => ifPresent(r, c, r.str(c));
  const hasDescription = r.row.has(COLUMNS.LONG_DESCRIPTION) || r.row.has(COLUMNS.SHORT_DESCRIPTION);
  return {
    name: r.name!,
    description: hasDescription ? (r.str(COLUMNS.LONG_DESCRIPTION) ?? r.str(COLUMNS.SHORT_DESCRIPTION)) : undefined,
    price: r.price!,
    status: r.status!,
    variantName: keyed(COLUMNS.VARIANT_NAME),
    color: keyed(COLUMNS.COLOR),
    size: keyed(COLUMNS.SIZE),
    material: keyed(COLUMNS.MATERIAL),
    pattern: keyed(COLUMNS.PATTERN),
    style: keyed(COLUMNS.STYLE),
    mrp: ifPresent(r, COLUMNS.MRP, r.mrp),
    cost: ifPresent(r, COLUMNS.COST, r.cost),
    taxCode: keyed(COLUMNS.TAX_CODE),
    taxRate: ifPresent(r, COLUMNS.TAX_RATE, r.taxRate),
    lowStockThreshold: ifPresent(r, COLUMNS.LOW_STOCK_THRESHOLD, r.lowStockThreshold),
    urlSlug: r.urlSlug ?? undefined,
    seoTitle: keyed(COLUMNS.SEO_TITLE),
    metaDescription: keyed(COLUMNS.META_DESCRIPTION),
    searchKeywords: keyed(COLUMNS.SEARCH_KEYWORDS),
    specifications: keyed(COLUMNS.SPECIFICATIONS),
    dimensions: keyed(COLUMNS.DIMENSIONS),
    weight: keyed(COLUMNS.WEIGHT),
    shippingClass: keyed(COLUMNS.SHIPPING_CLASS),
    supplierId: keyed(COLUMNS.SUPPLIER_ID),
    warehouseId: keyed(COLUMNS.WAREHOUSE_ID),
  };
}

/** Existing attributes with the row's values applied (a blank cell removes the attribute). */
function mergeAttributes(current: Prisma.JsonValue, updates: Record<string, string | null>) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  return base as Prisma.InputJsonObject;
}

const sameUrls = (a: string[], b: string[]) => a.length === b.length && a.every((u, i) => u === b[i]);

/** Writes the valid rows; returns [parents created, parents updated]. */
async function save(
  tx: Prisma.TransactionClient,
  valid: RowResult[],
  knownParents: Map<string, ParentRef>,
  merchantId: string,
  actor: string | null,
  fileName: string,
): Promise<[number, number]> {
  if (!valid.length) return [0, 0];
  const parentIds = new Map(knownParents);

  // Parents: created from, or updated with, their first valid row.
  const leads = new Map<string, RowResult>();
  for (const r of valid) if (!leads.has(r.parentCode)) leads.set(r.parentCode, r);
  const toUpdate = [...leads.keys()].filter((code) => parentIds.has(code));
  const stored = new Map(
    (await tx.parentProduct.findMany({ where: { id: { in: toUpdate.map((c) => parentIds.get(c)!.id) } } })).map((p) => [p.id, p]),
  );
  const newParents: Prisma.ParentProductCreateManyInput[] = [];
  for (const [code, lead] of leads) {
    const ref = parentIds.get(code);
    if (ref) {
      const current = stored.get(ref.id)!;
      await tx.parentProduct.update({
        where: { id: ref.id },
        data: { ...parentContent(lead), attributes: mergeAttributes(current.attributes, lead.attributes) },
      });
      continue;
    }
    const id = randomUUID();
    parentIds.set(code, { id, categoryId: lead.category!.id });
    const content = parentContent(lead);
    newParents.push({
      ...content,
      id,
      code,
      featured: content.featured ?? false,
      categoryId: lead.category!.id,
      subcategoryId: lead.subcategory?.id ?? null,
      attributes: mergeAttributes({}, lead.attributes),
      merchantId,
    });
  }
  if (newParents.length) await tx.parentProduct.createMany({ data: newParents });

  const products: Prisma.ProductCreateManyInput[] = [];
  const images: Prisma.ProductImageCreateManyInput[] = [];
  const movements: Prisma.StockMovementCreateManyInput[] = [];
  const replaceImagesOf: string[] = [];
  const reason = `Catalog import ${fileName}`.slice(0, 500);
  const addImages = (r: RowResult, productId: string) => {
    const altText = (r.variantName ? `${r.name} – ${r.variantName}` : r.name!).slice(0, 255);
    r.imageUrls.forEach((url, i) => images.push({ productId, url, altText, position: i, isPrimary: i === 0 }));
  };

  for (const r of valid) {
    const parent = parentIds.get(r.parentCode)!;
    const content = variantContent(r);
    if (r.existing) {
      const e = r.existing;
      r.productId = e.id;
      await tx.product.update({
        where: { id: e.id },
        data: { ...content, stockQuantity: r.quantity!, version: { increment: 1 } },
      });
      if (r.quantity! !== e.stockQuantity) {
        movements.push({ productId: e.id, delta: r.quantity! - e.stockQuantity, quantityAfter: r.quantity!, source: 'IMPORT', reason, actor });
      }
      if (!sameUrls(e.images.map((i) => i.url), r.imageUrls)) {
        replaceImagesOf.push(e.id);
        addImages(r, e.id);
      }
      continue;
    }
    const productId = randomUUID();
    r.productId = productId;
    products.push({
      ...content,
      id: productId,
      sku: r.sku,
      stockQuantity: r.quantity!,
      categoryId: parent.categoryId,
      parentId: parent.id,
      merchantId,
      version: 0n,
    });
    if (r.quantity! > 0) {
      movements.push({ productId, delta: r.quantity!, quantityAfter: r.quantity!, source: 'IMPORT', reason, actor });
    }
    addImages(r, productId);
  }

  if (products.length) await tx.product.createMany({ data: products });
  if (replaceImagesOf.length) await tx.productImage.deleteMany({ where: { productId: { in: replaceImagesOf } } });
  if (images.length) await tx.productImage.createMany({ data: images });
  if (movements.length) await tx.stockMovement.createMany({ data: movements });
  return [newParents.length, toUpdate.length];
}

/**
 * Resolves the template's Category cell to a department (FR-IM-04): by slug,
 * then name, then code, case-insensitive. A section's slug ("clothing-men")
 * names its department and the section. Subcategory resolves among the
 * department's sections by slug ("clothing-men" or "men"), name or code.
 */
class CategoryLookup {
  private readonly byId = new Map<string, ProductCategory>();
  private readonly children = new Map<string, ProductCategory[]>();

  constructor(private readonly categories: ProductCategory[]) {
    for (const c of categories) {
      this.byId.set(c.id, c);
      if (c.parentId) this.children.set(c.parentId, [...(this.children.get(c.parentId) ?? []), c]);
    }
  }

  department(value: string, r: RowResult): { department: ProductCategory; subcategory: ProductCategory | null } | null {
    const key = value.toLowerCase();
    const bySlug = this.categories.find((c) => c.slug.toLowerCase() === key);
    if (bySlug) return this.split(bySlug);
    for (const matches of [
      this.categories.filter((c) => !c.parentId && c.name.toLowerCase() === key),
      this.categories.filter((c) => c.name.toLowerCase() === key),
      this.categories.filter((c) => !c.parentId && c.code?.toLowerCase() === key),
    ]) {
      if (matches.length === 1) return this.split(matches[0]);
      if (matches.length > 1) {
        r.reject(`Category name '${value}' matches several categories; use its slug`);
        return null;
      }
    }
    r.reject(`Unknown category '${value}'`);
    return null;
  }

  subcategory(department: ProductCategory, value: string): ProductCategory | null {
    const key = value.toLowerCase();
    const sections = this.children.get(department.id) ?? [];
    return (
      sections.find((c) => c.slug.toLowerCase() === key || c.slug.toLowerCase() === `${department.slug.toLowerCase()}-${slugify(key)}`) ??
      sections.find((c) => c.name.toLowerCase() === key) ??
      sections.find((c) => c.code?.toLowerCase() === key) ??
      null
    );
  }

  private split(c: ProductCategory) {
    const parent = c.parentId ? this.byId.get(c.parentId) : undefined;
    return parent ? { department: parent, subcategory: c } : { department: c, subcategory: null };
  }
}
