import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient, type ProductCategory } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import { loadConfig } from '../config';
import { ALL_COLUMNS, isKnownHeader, normalizeHeader } from '../product/importer/columns';
import { imageUrls, planDemoCatalog } from './demo-plan';

/**
 * Writes the demo catalog as an import file in the catalog template (FR-IM-01),
 * for loading a deployed store through POST /api/catalog/import or the admin
 * panel instead of seeding the database directly. SKU codes and slugs match
 * seed-demo.ts, so importing it over a seeded catalog is an upsert (FR-IM-09).
 *
 *   npm run demo:csv -- --image-base https://<web-client>/daylora [--out demo-catalog.csv]
 *
 * Image URLs must be absolute and reachable (FR-IM-08): point them at the
 * web client's public/daylora folder on its deployed domain. Category and
 * subcategory codes are read from DATABASE_URL, which should be (a copy of)
 * the target database, as the codes are part of every SKU.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function demoCatalogCsv(categories: ProductCategory[], imageBase: string, currency: string): { csv: string; rows: number } {
  const plan = planDemoCatalog(categories);
  const attributeNames = [...new Set(plan.flatMap((p) => Object.keys(p.attributes)))]
    .filter((name) => !isKnownHeader(normalizeHeader(name)))
    .sort((a, b) => a.localeCompare(b));
  const headers = [...ALL_COLUMNS.map((c) => c.header), ...attributeNames];

  const records = plan.flatMap((p) => {
    const urls = imageUrls(imageBase, p.images);
    return p.variants.map((v) => {
      const discount = v.mrp && v.mrp.gt(v.price) ? v.mrp.minus(v.price).div(v.mrp).mul(100).toFixed(0) : '';
      const record: Record<string, string> = {
        SKU_ID: v.sku,
        Parent_Product_ID: p.code,
        Product_Name: p.name,
        Brand: p.brand,
        Category: p.department.slug,
        Subcategory: p.section.slug,
        Product_Type: p.productType,
        Product_Status: 'ACTIVE',
        Featured: p.featured ? 'TRUE' : 'FALSE',
        Variant_Name: v.variantName ?? '',
        Color: v.color ?? '',
        Size: v.size ?? '',
        Material: v.material ?? '',
        MRP: v.mrp?.toFixed(2) ?? '',
        Selling_Price: v.price.toFixed(2),
        Cost: v.cost.toFixed(2),
        Discount: discount,
        Tax_Code: v.taxCode,
        Tax_Rate: v.taxRate.toFixed(2),
        Currency: currency,
        Inventory_Qty: String(v.stock),
        Supplier_ID: v.supplierId,
        Warehouse_ID: v.warehouseId,
        Shipping_Class: v.shippingClass,
        Short_Description: p.shortDescription,
        Long_Description: p.description,
        Key_Features: p.keyFeatures,
        Specifications: v.specifications ?? '',
        Usage_Instructions: p.usageInstructions ?? '',
        Warranty: p.warranty ?? '',
        SEO_Title: v.seoTitle,
        Meta_Description: v.metaDescription,
        Search_Keywords: v.searchKeywords,
        URL_Slug: v.urlSlug,
        ...Object.fromEntries(urls.slice(0, 5).map((url, i) => [`Image_${i + 1}_URL`, url])),
      };
      for (const name of attributeNames) record[name] = p.attributes[name] ?? '';
      return headers.map((h) => record[h] ?? '');
    });
  });

  const csv = '﻿' + stringify([headers, ...records], { record_delimiter: '\r\n' });
  return { csv, rows: records.length };
}

async function main() {
  const imageBase = arg('image-base');
  const out = arg('out') ?? 'demo-catalog.csv';
  if (!imageBase || !/^https?:\/\/[^/]/.test(imageBase)) {
    throw new Error('--image-base must be an absolute http(s) URL, e.g. https://<web-client>/daylora');
  }
  const config = loadConfig({ JWT_SECRET: 'x'.repeat(32), ...process.env });
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    const categories = await prisma.productCategory.findMany({ where: { deleted: false } });
    const { csv, rows } = demoCatalogCsv(categories, imageBase, config.order.currency);
    writeFileSync(out, csv, 'utf8');
    console.log(`Wrote ${out}: ${rows} SKU rows, images under ${imageBase}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
}
