import { randomUUID } from 'node:crypto';
import { Prisma, type ParentProduct, type PrismaClient, type ProductCategory } from '@prisma/client';
import { PRODUCT_STATUSES, type ProductStatus } from '../../common/enums';
import { logger } from '../../common/logger';
import { TX } from '../../db';
import { COLUMNS, IMAGE_COLUMNS, isKnownHeader, type ImportColumn, type ImportRow } from './columns';
import type { CatalogFileReader, UploadedFile } from './file-reader';

const log = logger('catalog-import');

const CODE = /^[A-Za-z0-9._-]+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const THOUSANDS = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const MAX_PRICE = new Prisma.Decimal('9999999999.99'); // numeric(12,2)

export interface RowError {
  row: number;
  sku: string | null;
  reason: string;
}

/** Outcome of one import file. Valid rows import even when others fail (FR-IM-06/07). */
export interface CatalogImportReport {
  fileName: string;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  parentProductsCreated: number;
  /** File columns the importer doesn't read yet. */
  ignoredColumns: string[];
  errors: RowError[];
}

/** Validation state of one row; the parsed fields are meaningful only while it is valid. */
class RowResult {
  readonly reasons: string[] = [];
  sku = '';
  parentCode = '';
  name: string | null = null;
  brand: string | null = null;
  variantName: string | null = null;
  color: string | null = null;
  size: string | null = null;
  material: string | null = null;
  pattern: string | null = null;
  style: string | null = null;
  shortDescription: string | null = null;
  longDescription: string | null = null;
  category: ProductCategory | null = null;
  status: ProductStatus | null = null;
  price: Prisma.Decimal | null = null;
  quantity: number | null = null;
  imageUrls: string[] = [];

  constructor(readonly row: ImportRow) {}

  reject(reason: string) {
    this.reasons.push(reason);
  }

  get valid() {
    return this.reasons.length === 0;
  }
}

/**
 * Bulk catalog import from the structured template (FR-IM-01), creating parent
 * products with their variant SKUs (FR-IM-02).
 *
 * The file is checked in full before anything is written. Each row either
 * passes every check or is rejected with all of its reasons; rejected rows
 * never stop valid ones from importing. Checks, in order:
 *  1. mandatory fields, formats and lengths, and that the category exists;
 *  2. SKU_ID unique within the file — every row sharing a SKU is rejected, as
 *     the importer can't know which one is right;
 *  3. SKU_ID not already in the catalog;
 *  4. rows sharing a Parent_Product_ID agree on category, with each other and
 *     with an existing parent of that code.
 *
 * Rows sharing a Parent_Product_ID become variants of one parent; a row without
 * one is a single-variant product whose parent code is its SKU. A new parent
 * takes its details from its first valid row; an existing code (imported
 * earlier) gains the new variants and keeps its own details.
 *
 * Valid rows are written in one transaction, as three bulk inserts.
 */
export class CatalogImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: CatalogFileReader,
  ) {}

  async importFile(file: UploadedFile | undefined, merchantId: string): Promise<CatalogImportReport> {
    const parsed = await this.reader.read(file);
    const categories = new CategoryLookup(await this.prisma.productCategory.findMany({ where: { deleted: false } }));

    const results = parsed.rows.map((row) => validate(row, categories));

    rejectDuplicateSkusInFile(results);
    await this.rejectSkusAlreadyInCatalog(results);
    const existingParents = await this.rejectParentConflicts(results, merchantId);

    const valid = results.filter((r) => r.valid);
    const parentsCreated = await this.save(valid, existingParents, merchantId);

    const errors = results
      .filter((r) => !r.valid)
      .sort((a, b) => a.row.rowNumber - b.row.rowNumber)
      .map((r) => ({ row: r.row.rowNumber, sku: r.sku || null, reason: r.reasons.join('; ') }));

    const fileName = file!.originalname;
    log.info(
      `Catalog import '${fileName}' by merchant ${merchantId}: ${results.length} rows, ` +
        `${valid.length} imported, ${errors.length} rejected, ${parentsCreated} parents created`,
    );

    return {
      fileName,
      totalRows: results.length,
      importedRows: valid.length,
      failedRows: errors.length,
      parentProductsCreated: parentsCreated,
      ignoredColumns: parsed.headers.filter((h) => !isKnownHeader(h)),
      errors,
    };
  }

  // ── Cross-row checks ─────────────────────────────────────────────────────

  /** FR-IM-05, against the catalog (soft-deleted SKUs included — the DB constraint is global). */
  private async rejectSkusAlreadyInCatalog(results: RowResult[]) {
    const candidates = [...new Set(results.filter((r) => r.valid).map((r) => r.sku))];
    if (!candidates.length) return;
    const existing = new Set(
      (await this.prisma.product.findMany({ where: { sku: { in: candidates } }, select: { sku: true } })).map((p) => p.sku),
    );
    for (const r of results) {
      if (r.valid && existing.has(r.sku)) r.reject('SKU_ID already exists in the catalog');
    }
  }

  /**
   * Variants of one parent share its category. An existing parent fixes it;
   * otherwise the group's first valid row does. Returns the existing parents
   * the valid rows attach to, keyed by code.
   */
  private async rejectParentConflicts(results: RowResult[], merchantId: string) {
    const codes = [...new Set(results.filter((r) => r.valid).map((r) => r.parentCode))];
    const existing = new Map<string, ParentProduct & { category: ProductCategory | null }>();
    if (codes.length) {
      for (const p of await this.prisma.parentProduct.findMany({ where: { code: { in: codes } }, include: { category: true } })) {
        existing.set(p.code, p);
      }
    }

    const firstRowOfGroup = new Map<string, RowResult>();
    for (const r of results) {
      if (!r.valid) continue;
      const parent = existing.get(r.parentCode);
      if (parent) {
        if (parent.deleted || parent.merchantId !== merchantId) {
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
    return existing;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Writes the valid rows; returns how many parent products were created. */
  private async save(valid: RowResult[], existingParents: Map<string, ParentProduct>, merchantId: string) {
    const parentIds = new Map<string, { id: string; categoryId: string | null }>();
    for (const [code, p] of existingParents) parentIds.set(code, { id: p.id, categoryId: p.categoryId });

    const newParents: Prisma.ParentProductCreateManyInput[] = [];
    for (const r of valid) {
      if (parentIds.has(r.parentCode)) continue;
      const id = randomUUID();
      parentIds.set(r.parentCode, { id, categoryId: r.category!.id });
      newParents.push({
        id,
        code: r.parentCode,
        name: r.name!,
        brand: r.brand,
        shortDescription: r.shortDescription,
        description: r.longDescription,
        categoryId: r.category!.id,
        merchantId,
      });
    }

    const products: Prisma.ProductCreateManyInput[] = [];
    const images: Prisma.ProductImageCreateManyInput[] = [];
    for (const r of valid) {
      const parent = parentIds.get(r.parentCode)!;
      const productId = randomUUID();
      products.push({
        id: productId,
        name: r.name!,
        description: r.longDescription ?? r.shortDescription,
        price: r.price!,
        stockQuantity: r.quantity!,
        sku: r.sku,
        status: r.status!,
        categoryId: parent.categoryId,
        parentId: parent.id,
        variantName: r.variantName,
        color: r.color,
        size: r.size,
        material: r.material,
        pattern: r.pattern,
        style: r.style,
        merchantId,
        version: 0n,
      });
      const altText = (r.variantName ? `${r.name} – ${r.variantName}` : r.name!).slice(0, 255);
      r.imageUrls.forEach((url, i) =>
        images.push({ productId, url, altText, position: i, isPrimary: i === 0 }),
      );
    }

    if (valid.length) {
      await this.prisma.$transaction(async (tx) => {
        if (newParents.length) await tx.parentProduct.createMany({ data: newParents });
        await tx.product.createMany({ data: products });
        if (images.length) await tx.productImage.createMany({ data: images });
      }, TX.catalogImport);
    }
    return newParents.length;
  }
}

// ── Row validation ──────────────────────────────────────────────────────────

function validate(row: ImportRow, categories: CategoryLookup): RowResult {
  const r = new RowResult(row);

  r.sku = row.get(COLUMNS.SKU_ID);
  if (!r.sku) r.reject('SKU_ID is required');
  else checkCode(r, COLUMNS.SKU_ID, r.sku);

  const parentCode = row.get(COLUMNS.PARENT_PRODUCT_ID);
  if (parentCode) checkCode(r, COLUMNS.PARENT_PRODUCT_ID, parentCode);
  r.parentCode = parentCode || r.sku;

  r.name = required(r, COLUMNS.PRODUCT_NAME, 255);
  r.brand = optional(r, COLUMNS.BRAND, 100);
  r.variantName = optional(r, COLUMNS.VARIANT_NAME, 150);
  r.color = optional(r, COLUMNS.COLOR, 50);
  r.size = optional(r, COLUMNS.SIZE, 50);
  r.material = optional(r, COLUMNS.MATERIAL, 100);
  r.pattern = optional(r, COLUMNS.PATTERN, 100);
  r.style = optional(r, COLUMNS.STYLE, 100);
  r.shortDescription = optional(r, COLUMNS.SHORT_DESCRIPTION, 1000);
  r.longDescription = optional(r, COLUMNS.LONG_DESCRIPTION, 5000);

  const category = row.get(COLUMNS.CATEGORY);
  if (!category) r.reject('Category is required');
  else r.category = categories.find(category, r);

  r.status = parseStatus(r);
  r.price = parsePrice(r);
  r.quantity = parseQuantity(r);
  r.imageUrls = parseImages(r);
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

function parseNumber(value: string): Prisma.Decimal | null {
  return NUMBER.test(value) ? new Prisma.Decimal(value) : null;
}

function parsePrice(r: RowResult): Prisma.Decimal | null {
  const value = r.row.get(COLUMNS.SELLING_PRICE);
  if (!value) {
    r.reject('Selling_Price is required');
    return null;
  }
  const price = parseNumber(THOUSANDS.test(value) ? value.replaceAll(',', '') : value);
  if (!price) r.reject(`Selling_Price '${value}' is not a number`);
  else if (price.lte(0)) r.reject('Selling_Price must be greater than 0');
  else if (price.decimalPlaces() > 2) r.reject('Selling_Price must have at most 2 decimal places');
  else if (price.gt(MAX_PRICE)) r.reject('Selling_Price is too large');
  else return price;
  return null;
}

function parseQuantity(r: RowResult): number | null {
  const value = r.row.get(COLUMNS.INVENTORY_QTY);
  if (!value) {
    r.reject('Inventory_Qty is required');
    return null;
  }
  const qty = parseNumber(value);
  if (!qty || !qty.isInteger()) r.reject(`Inventory_Qty '${value}' is not a whole number`);
  else if (qty.lt(0)) r.reject('Inventory_Qty must not be negative');
  else if (qty.gt(2_147_483_647)) r.reject('Inventory_Qty is too large');
  else return qty.toNumber();
  return null;
}

/** Image URLs are only read from the template, never embedded (FR-IM-03). */
function parseImages(r: RowResult): string[] {
  const urls: string[] = [];
  let anyGiven = false;
  for (const column of IMAGE_COLUMNS) {
    const value = r.row.get(column);
    if (!value) continue;
    anyGiven = true;
    if (value.length > 2048) r.reject(`${column.header} must be at most 2048 characters`);
    else if (!isHttpUrl(value)) r.reject(`${column.header} '${value}' is not an http(s) URL`);
    else urls.push(value);
  }
  if (!anyGiven) r.reject('At least one image URL (Image_1_URL … Image_5_URL) is required');
  return urls;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** FR-IM-05, within the file. */
function rejectDuplicateSkusInFile(results: RowResult[]) {
  const bySku = new Map<string, RowResult[]>();
  for (const r of results) {
    if (!r.sku) continue;
    bySku.set(r.sku, [...(bySku.get(r.sku) ?? []), r]);
  }
  for (const rows of bySku.values()) {
    if (rows.length < 2) continue;
    const list = rows.map((r) => r.row.rowNumber).join(', ');
    for (const r of rows) r.reject(`SKU_ID appears more than once in the file (rows ${list})`);
  }
}

/**
 * Resolves the template's Category cell to an existing category (FR-IM-04): by
 * slug first, then by name, both case-insensitive. Unknown or ambiguous values
 * reject the row.
 */
class CategoryLookup {
  private readonly bySlug = new Map<string, ProductCategory>();
  private readonly byName = new Map<string, ProductCategory[]>();

  constructor(categories: ProductCategory[]) {
    for (const c of categories) {
      this.bySlug.set(c.slug.toLowerCase(), c);
      const key = c.name.toLowerCase();
      this.byName.set(key, [...(this.byName.get(key) ?? []), c]);
    }
  }

  find(value: string, r: RowResult): ProductCategory | null {
    const key = value.toLowerCase();
    const slugMatch = this.bySlug.get(key);
    if (slugMatch) return slugMatch;
    const nameMatches = this.byName.get(key) ?? [];
    if (nameMatches.length === 1) return nameMatches[0];
    r.reject(
      nameMatches.length === 0
        ? `Unknown category '${value}'`
        : `Category name '${value}' matches several categories; use its slug`,
    );
    return null;
  }
}
