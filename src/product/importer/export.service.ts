import type { Prisma, PrismaClient } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { attributesOf } from '../product.mapper';
import { ALL_COLUMNS, COLUMNS, isKnownHeader, normalizeHeader } from './columns';

const EXPORT_INCLUDE = {
  parent: { include: { category: { include: { parent: true } }, subcategory: true } },
  category: { include: { parent: true } },
  images: { where: { deleted: false }, orderBy: { position: 'asc' } },
} satisfies Prisma.ProductInclude;

type ExportProduct = Prisma.ProductGetPayload<{ include: typeof EXPORT_INCLUDE }>;

/** Columns written as numbers in a workbook. */
const NUMERIC = new Set<string>([
  COLUMNS.MRP.header,
  COLUMNS.SELLING_PRICE.header,
  COLUMNS.COST.header,
  COLUMNS.DISCOUNT.header,
  COLUMNS.TAX_RATE.header,
  COLUMNS.INVENTORY_QTY.header,
  COLUMNS.LOW_STOCK_THRESHOLD.header,
]);

export interface CatalogExport {
  fileName: string;
  contentType: string;
  body: Buffer;
  rows: number;
}

/**
 * NFR-06: the whole catalog as the import template — the master columns, then
 * every category attribute in use — one row per live SKU. The file re-imports
 * as is (an upsert that changes nothing), so the catalog is never locked in.
 */
export class CatalogExportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly currency: string,
  ) {}

  async export(format: 'csv' | 'xlsx'): Promise<CatalogExport> {
    const products = await this.prisma.product.findMany({
      where: { deleted: false, parent: { deleted: false } },
      include: EXPORT_INCLUDE,
      orderBy: [{ parent: { code: 'asc' } }, { sku: 'asc' }],
    });

    const attributeNames = [
      ...new Set(products.flatMap((p) => Object.keys(attributesOf(p.parent.attributes)))),
    ]
      .filter((name) => !isKnownHeader(normalizeHeader(name)))
      .sort((a, b) => a.localeCompare(b));
    const headers = [...ALL_COLUMNS.map((c) => c.header), ...attributeNames];
    const records = products.map((p) => this.record(p, attributeNames));

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      const body = Buffer.from(
        '﻿' + stringify([headers, ...records.map((r) => headers.map((h) => r[h] ?? ''))], { record_delimiter: '\r\n' }),
        'utf8',
      );
      return { fileName: `catalog-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body, rows: records.length };
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Master');
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of records) {
      sheet.addRow(
        headers.map((h) => {
          const v = r[h] ?? '';
          return NUMERIC.has(h) && v !== '' ? Number(v) : v;
        }),
      );
    }
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      fileName: `catalog-${stamp}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body,
      rows: records.length,
    };
  }

  private record(p: ExportProduct, attributeNames: string[]): Record<string, string> {
    const parent = p.parent;
    const assigned = parent.category ?? p.category;
    const department = assigned?.parentId ? assigned.parent : assigned;
    const subcategory = parent.subcategory ?? (assigned?.parentId ? assigned : null);
    const urls = p.images.map((i) => i.url);
    const discount = p.mrp && p.mrp.gt(0) && p.mrp.gt(p.price) ? p.mrp.minus(p.price).div(p.mrp).mul(100).toFixed(0) : '';
    const attrs = attributesOf(parent.attributes);
    const s = (v: string | null | undefined) => v ?? '';
    const record: Record<string, string> = {
      SKU_ID: p.sku,
      Parent_Product_ID: parent.code,
      Product_Name: p.name,
      Brand: s(parent.brand),
      Category: s(department?.slug),
      Subcategory: s(subcategory?.slug),
      Product_Type: s(parent.productType),
      Product_Status: p.status,
      Featured: parent.featured ? 'TRUE' : 'FALSE',
      Variant_Name: s(p.variantName),
      Color: s(p.color),
      Size: s(p.size),
      Material: s(p.material),
      Pattern: s(p.pattern),
      Style: s(p.style),
      MRP: p.mrp ? p.mrp.toFixed(2) : '',
      Selling_Price: p.price.toFixed(2),
      Cost: p.cost ? p.cost.toFixed(2) : '',
      Discount: discount,
      Tax_Code: s(p.taxCode),
      Tax_Rate: p.taxRate ? p.taxRate.toFixed(2) : '',
      Currency: this.currency,
      Inventory_Qty: String(p.stockQuantity),
      Low_Stock_Threshold: p.lowStockThreshold === null ? '' : String(p.lowStockThreshold),
      Supplier_ID: s(p.supplierId),
      Warehouse_ID: s(p.warehouseId),
      Shipping_Class: s(p.shippingClass),
      Short_Description: s(parent.shortDescription),
      Long_Description: s(parent.description ?? p.description),
      Key_Features: s(parent.keyFeatures),
      Specifications: s(p.specifications),
      Dimensions: s(p.dimensions),
      Weight: s(p.weight),
      Whats_Included: s(parent.whatsIncluded),
      Usage_Instructions: s(parent.usageInstructions),
      Warranty: s(parent.warranty),
      Image_1_URL: s(urls[0]),
      Image_2_URL: s(urls[1]),
      Image_3_URL: s(urls[2]),
      Image_4_URL: s(urls[3]),
      Image_5_URL: s(urls[4]),
      Thumbnail_URL: '',
      Lifestyle_Image_URL: s(parent.lifestyleImageUrl),
      Size_Chart_URL: s(parent.sizeChartUrl),
      Infographic_URL: s(parent.infographicUrl),
      SEO_Title: s(p.seoTitle),
      Meta_Description: s(p.metaDescription),
      Search_Keywords: s(p.searchKeywords),
      URL_Slug: s(p.urlSlug),
    };
    for (const name of attributeNames) record[name] = s(attrs[name]);
    return record;
  }
}
