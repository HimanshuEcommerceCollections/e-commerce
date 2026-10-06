import type { Prisma, PrismaClient } from '@prisma/client';
import { PRODUCT_STATUSES, type ProductStatus } from '../../common/enums';
import { InvalidImportFileError } from '../../common/errors';
import { logger } from '../../common/logger';
import { TX } from '../../db';
import { COLUMNS, keyOf, type ImportColumn } from './columns';
import type { CatalogFileReader, UploadedFile } from './file-reader';
import { RowResult, parseInteger, parseMoney, parsePercent, type RowError } from './import.service';

const log = logger('catalog-update');

/** FR-IM-10: the columns a bulk update may change, besides the SKU_ID key. */
export const UPDATE_COLUMNS: ImportColumn[] = [
  COLUMNS.SELLING_PRICE,
  COLUMNS.MRP,
  COLUMNS.INVENTORY_QTY,
  COLUMNS.PRODUCT_STATUS,
  COLUMNS.TAX_RATE,
  COLUMNS.LOW_STOCK_THRESHOLD,
];

const KEY_COLUMN: ImportColumn = { header: COLUMNS.SKU_ID.header, requiredColumn: true };

export interface BulkUpdateReport {
  fileName: string;
  totalRows: number;
  updatedRows: number;
  /** Rows whose values already matched the catalog. */
  unchangedRows: number;
  failedRows: number;
  /** The update columns the file has. */
  columns: string[];
  errors: RowError[];
  durationMs: number;
}

interface Parsed {
  r: RowResult;
  price: Prisma.Decimal | null;
  /** Undefined: leave alone; null: clear (MRP 0). */
  mrp: Prisma.Decimal | null | undefined;
  quantity: number | null;
  status: ProductStatus | null;
  taxRate: Prisma.Decimal | null;
  lowStockThreshold: number | null;
}

/**
 * Bulk price, stock and status update after go-live (FR-IM-10/11): a CSV/XLSX
 * keyed by SKU_ID with any of the UPDATE_COLUMNS, without re-uploading
 * content. Blank cells leave the value alone; MRP 0 removes the MRP.
 * Inventory_Qty sets the stock level, recorded as a BULK_UPDATE stock movement
 * under a row lock, so a concurrent checkout is never lost (NFR-08).
 */
export class CatalogBulkUpdateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: CatalogFileReader,
  ) {}

  async updateFile(file: UploadedFile | undefined, actor: string | null): Promise<BulkUpdateReport> {
    const started = Date.now();
    const parsed = await this.reader.read(file, [KEY_COLUMN]);
    const columns = UPDATE_COLUMNS.filter((c) => parsed.headers.includes(keyOf(c)));
    if (!columns.length) {
      throw new InvalidImportFileError(`Add at least one column to update: ${UPDATE_COLUMNS.map((c) => c.header).join(', ')}`);
    }

    const rows: Parsed[] = parsed.rows.map((row) => {
      const r = new RowResult(row);
      r.sku = row.get(COLUMNS.SKU_ID);
      if (!r.sku) r.reject('SKU_ID is required');
      const mrp = parseMoney(r, COLUMNS.MRP, { positive: false });
      const statusText = row.get(COLUMNS.PRODUCT_STATUS).toUpperCase() as ProductStatus;
      if (statusText && !PRODUCT_STATUSES.includes(statusText)) {
        r.reject(`Product_Status '${row.get(COLUMNS.PRODUCT_STATUS)}' is not one of ${PRODUCT_STATUSES.join(', ')}`);
      }
      const p: Parsed = {
        r,
        price: parseMoney(r, COLUMNS.SELLING_PRICE, { positive: true }),
        mrp: mrp === null ? undefined : mrp.isZero() ? null : mrp,
        quantity: parseInteger(r, COLUMNS.INVENTORY_QTY, false),
        status: statusText && PRODUCT_STATUSES.includes(statusText) ? statusText : null,
        taxRate: parsePercent(r, COLUMNS.TAX_RATE),
        lowStockThreshold: parseInteger(r, COLUMNS.LOW_STOCK_THRESHOLD, false),
      };
      return p;
    });

    const bySku = new Map<string, Parsed[]>();
    for (const p of rows) if (p.r.sku) bySku.set(p.r.sku, [...(bySku.get(p.r.sku) ?? []), p]);
    for (const group of bySku.values()) {
      if (group.length < 2) continue;
      const list = group.map((p) => p.r.row.rowNumber).join(', ');
      for (const p of group) p.r.reject(`SKU_ID appears more than once in the file (rows ${list})`);
    }

    let updated = 0;
    let unchanged = 0;
    const reason = `Bulk update ${file!.originalname}`.slice(0, 500);
    const valid = rows.filter((p) => p.r.valid);
    if (valid.length) {
      [updated, unchanged] = await this.prisma.$transaction(async (tx) => {
        const skus = valid.map((p) => p.r.sku);
        // Row locks first: the stock levels read below can't change before the write (NFR-08).
        await tx.$queryRaw`SELECT id FROM products WHERE sku = ANY(${skus}::text[]) AND deleted = false FOR UPDATE`;
        const current = new Map(
          (await tx.product.findMany({ where: { sku: { in: skus }, deleted: false, parent: { deleted: false } } })).map((p) => [p.sku, p]),
        );
        let changed = 0;
        let same = 0;
        const movements: Prisma.StockMovementCreateManyInput[] = [];
        for (const p of valid) {
          const product = current.get(p.r.sku);
          if (!product) {
            p.r.reject('Unknown SKU_ID');
            continue;
          }
          const price = p.price ?? product.price;
          const mrp = p.mrp === undefined ? product.mrp : p.mrp;
          if (mrp && mrp.lt(price)) {
            p.r.reject(`MRP ${mrp.toFixed(2)} must not be less than Selling_Price ${price.toFixed(2)}`);
            continue;
          }
          const data: Prisma.ProductUpdateInput = {};
          if (p.price && !p.price.eq(product.price)) data.price = p.price;
          if (p.mrp !== undefined && !(p.mrp === null ? product.mrp === null : product.mrp?.eq(p.mrp))) data.mrp = p.mrp;
          if (p.quantity !== null && p.quantity !== product.stockQuantity) data.stockQuantity = p.quantity;
          if (p.status && p.status !== product.status) data.status = p.status;
          if (p.taxRate && !product.taxRate?.eq(p.taxRate)) data.taxRate = p.taxRate;
          if (p.lowStockThreshold !== null && p.lowStockThreshold !== product.lowStockThreshold) {
            data.lowStockThreshold = p.lowStockThreshold;
          }
          if (Object.keys(data).length === 0) {
            same++;
            continue;
          }
          await tx.product.update({ where: { id: product.id }, data: { ...data, version: { increment: 1 } } });
          if (data.stockQuantity !== undefined) {
            movements.push({
              productId: product.id,
              delta: p.quantity! - product.stockQuantity,
              quantityAfter: p.quantity!,
              source: 'BULK_UPDATE',
              reason,
              actor,
            });
          }
          changed++;
        }
        if (movements.length) await tx.stockMovement.createMany({ data: movements });
        return [changed, same];
      }, TX.catalogImport);
    }

    const errors = rows
      .filter((p) => !p.r.valid)
      .map((p) => ({ row: p.r.row.rowNumber, sku: p.r.sku || null, reason: p.r.reasons.join('; ') }));
    const report: BulkUpdateReport = {
      fileName: file!.originalname,
      totalRows: rows.length,
      updatedRows: updated,
      unchangedRows: unchanged,
      failedRows: errors.length,
      columns: columns.map((c) => c.header),
      errors,
      durationMs: Date.now() - started,
    };
    log.info(
      `Bulk update '${report.fileName}' by ${actor ?? 'unknown'}: ${report.totalRows} rows, ${updated} updated, ` +
        `${unchanged} unchanged, ${errors.length} rejected`,
    );
    return report;
  }
}
