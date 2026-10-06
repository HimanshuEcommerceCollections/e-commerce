import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_COLUMNS } from '../src/product/importer/columns';
import { harness } from './support/harness';

/**
 * Every template column, upsert (FR-IM-09), bulk price/stock updates
 * (FR-IM-10), export (NFR-06) and the 1,000-row import (FR-IM-12).
 */
const { prisma, container } = harness();
const importer = container.catalogImport;
const staff = { staff: true, actor: 'catalog@test.local' };

let run: string;
let dept: { id: string; slug: string };
let men: { id: string; slug: string };
let women: { id: string; slug: string };
const merchantId = randomUUID();

beforeAll(async () => {
  run = randomUUID().slice(0, 8).toUpperCase();
  // The migrations seed the frozen taxonomy: Clothing (CL) with Women and Men.
  const clothing = await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing' } });
  dept = clothing;
  men = await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing-men' } });
  women = await prisma.productCategory.findUniqueOrThrow({ where: { slug: 'clothing-women' } });
});

const sku = (s: string) => `F-${run}-${s}`;
const img = (n: string) => `https://cdn.test.local/products/${run}-${n}.jpg`;
const file = (name: string, records: Record<string, string>[], headers?: string[]) => {
  const cols = headers ?? [...new Set(records.flatMap((r) => Object.keys(r)))];
  return { originalname: name, buffer: Buffer.from(stringify([cols, ...records.map((r) => cols.map((c) => r[c] ?? ''))])) };
};

/** A complete master-sheet row plus Clothing attributes. */
const fullRow = (over: Record<string, string> = {}): Record<string, string> => ({
  SKU_ID: sku('BLK-M'),
  Parent_Product_ID: `F-${run}`,
  Product_Name: `Oxford Shirt ${run} — Black, M`,
  Brand: 'Northfold',
  Category: 'Clothing',
  Subcategory: 'Men',
  Product_Type: 'Shirts',
  Product_Status: 'ACTIVE',
  Featured: 'yes',
  Variant_Name: 'Black / M',
  Color: 'Black',
  Size: 'M',
  Material: 'Cotton',
  Pattern: 'Solid',
  Style: 'Formal',
  MRP: '59.99',
  Selling_Price: '44.99',
  Cost: '20.00',
  Discount: '25%',
  Tax_Code: 'CL-STD',
  Tax_Rate: '8.25',
  Currency: 'usd',
  Inventory_Qty: '40',
  Low_Stock_Threshold: '7',
  Supplier_ID: 'SUP-NF',
  Warehouse_ID: 'WH-PDX',
  Shipping_Class: 'standard',
  Short_Description: 'A crisp oxford shirt',
  Long_Description: 'Woven cotton oxford with a button-down collar.',
  Key_Features: 'Button-down collar | Chest pocket | Slim fit',
  Specifications: 'Fabric: 120 gsm oxford',
  Dimensions: '30 x 25 x 3 cm',
  Weight: '0.3 kg',
  Whats_Included: '1 shirt',
  Usage_Instructions: 'Machine wash cold',
  Warranty: '30-day quality guarantee',
  Image_1_URL: img('1'),
  Image_2_URL: img('2'),
  Image_3_URL: '',
  Image_4_URL: '',
  Image_5_URL: '',
  Thumbnail_URL: '',
  Lifestyle_Image_URL: img('life'),
  Size_Chart_URL: img('chart'),
  Infographic_URL: '',
  SEO_Title: `Oxford Shirt ${run}`,
  Meta_Description: 'Crisp cotton oxford shirt',
  Search_Keywords: 'oxford, shirt, button-down',
  URL_Slug: `oxford-shirt-${run.toLowerCase()}-black-m`,
  Fit: 'Slim',
  Neck_Type: 'Collar',
  Connectivity: 'Bluetooth', // an Electronics attribute: ignored for Clothing
  Shoe_Width: 'Wide', // on no attribute sheet
  ...over,
});

describe('catalog files', () => {
  it('imports every template column and the department attributes', async () => {
    const report = await importer.importFile(file('full.csv', [fullRow()]), merchantId, staff);
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ importedRows: 1, createdRows: 1, parentProductsCreated: 1 });
    expect(report.ignoredColumns).toEqual(['CONNECTIVITY', 'SHOE_WIDTH']);

    const p = await prisma.product.findUniqueOrThrow({
      where: { sku: sku('BLK-M') },
      include: { parent: true, images: { orderBy: { position: 'asc' } }, stockMovements: true },
    });
    expect(p.parent).toMatchObject({
      name: `Oxford Shirt ${run}`,
      brand: 'Northfold',
      categoryId: dept.id,
      subcategoryId: men.id,
      productType: 'Shirts',
      featured: true,
      shortDescription: 'A crisp oxford shirt',
      description: 'Woven cotton oxford with a button-down collar.',
      keyFeatures: 'Button-down collar\nChest pocket\nSlim fit',
      whatsIncluded: '1 shirt',
      usageInstructions: 'Machine wash cold',
      warranty: '30-day quality guarantee',
      lifestyleImageUrl: img('life'),
      sizeChartUrl: img('chart'),
      infographicUrl: null,
      attributes: { Fit: 'Slim', Neck_Type: 'Collar' },
    });
    expect(p).toMatchObject({
      name: `Oxford Shirt ${run} — Black, M`,
      categoryId: dept.id,
      variantName: 'Black / M',
      material: 'Cotton',
      pattern: 'Solid',
      style: 'Formal',
      taxCode: 'CL-STD',
      stockQuantity: 40,
      lowStockThreshold: 7,
      supplierId: 'SUP-NF',
      warehouseId: 'WH-PDX',
      shippingClass: 'standard',
      specifications: 'Fabric: 120 gsm oxford',
      dimensions: '30 x 25 x 3 cm',
      weight: '0.3 kg',
      seoTitle: `Oxford Shirt ${run}`,
      metaDescription: 'Crisp cotton oxford shirt',
      searchKeywords: 'oxford, shirt, button-down',
      urlSlug: `oxford-shirt-${run.toLowerCase()}-black-m`,
    });
    expect([p.price, p.mrp, p.cost, p.taxRate].map((d) => d?.toFixed(2))).toEqual(['44.99', '59.99', '20.00', '8.25']);
    expect(p.images.map((i) => [i.url, i.isPrimary, i.checkStatus])).toEqual([
      [img('1'), true, null],
      [img('2'), false, null],
    ]);
    expect(p.stockMovements).toMatchObject([{ delta: 40, quantityAfter: 40, source: 'IMPORT', actor: 'catalog@test.local' }]);
  });

  it('re-importing a SKU updates it in place (FR-IM-09)', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { sku: sku('BLK-M') } });
    const report = await importer.importFile(
      file('again.csv', [
        // Only these columns: everything else is left as it was.
        {
          SKU_ID: sku('BLK-M'),
          Product_Name: `Oxford Shirt ${run} — Black, M`,
          Category: 'clothing',
          Subcategory: 'clothing-women',
          Product_Status: 'INACTIVE',
          Selling_Price: '39.99',
          Inventory_Qty: '25',
          Image_1_URL: img('3'),
          Fit: '',
        },
        {
          SKU_ID: sku('WHT-L'),
          Parent_Product_ID: `F-${run}`,
          Product_Name: `Oxford Shirt ${run} — White, L`,
          Category: 'clothing',
          Subcategory: 'women',
          Product_Status: 'ACTIVE',
          Color: 'White',
          Size: 'L',
          Selling_Price: '44.99',
          Inventory_Qty: '5',
          Image_1_URL: img('4'),
          Fit: 'Regular',
        },
      ]),
      merchantId,
      staff,
    );
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ createdRows: 1, updatedRows: 1, parentProductsCreated: 0, parentProductsUpdated: 1 });
    expect(report.imported.map((i) => [i.sku, i.action])).toEqual([
      [sku('BLK-M'), 'UPDATED'],
      [sku('WHT-L'), 'CREATED'],
    ]);
    expect(await prisma.product.count({ where: { sku: sku('BLK-M') } })).toBe(1);

    const after = await prisma.product.findUniqueOrThrow({
      where: { sku: sku('BLK-M') },
      include: { parent: true, images: { where: { deleted: false } }, stockMovements: { orderBy: { createdAt: 'asc' } } },
    });
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ status: 'INACTIVE', stockQuantity: 25, material: 'Cotton', lowStockThreshold: 7 });
    expect(after.price.toFixed(2)).toBe('39.99');
    expect(after.mrp?.toFixed(2)).toBe('59.99'); // no MRP column: kept
    expect(after.urlSlug).toBe(before.urlSlug);
    expect(after.images.map((i) => i.url)).toEqual([img('3')]);
    expect(after.stockMovements.map((m) => [m.delta, m.quantityAfter, m.source])).toEqual([
      [40, 40, 'IMPORT'],
      [-15, 25, 'IMPORT'],
    ]);
    // The parent follows its first row: section moved, the blank Fit removed.
    expect(after.parent).toMatchObject({ subcategoryId: women.id, brand: 'Northfold', attributes: { Neck_Type: 'Collar' } });

    const white = await prisma.product.findUniqueOrThrow({ where: { sku: sku('WHT-L') } });
    expect(white.parentId).toBe(after.parentId);
    expect(white.urlSlug).toBe(`oxford-shirt-${run.toLowerCase()}-white-l`);
  });

  it('rejects unknown subcategories, MRP below price, foreign currencies and taken slugs', async () => {
    const report = await importer.importFile(
      file('bad.csv', [
        fullRow({ SKU_ID: sku('S1'), Parent_Product_ID: '', URL_Slug: '', Subcategory: 'Pets' }),
        fullRow({ SKU_ID: sku('S2'), Parent_Product_ID: '', URL_Slug: '', MRP: '10.00' }),
        fullRow({ SKU_ID: sku('S3'), Parent_Product_ID: '', URL_Slug: '', Currency: 'EUR' }),
        fullRow({ SKU_ID: sku('S4'), Parent_Product_ID: '', URL_Slug: `oxford-shirt-${run.toLowerCase()}-black-m` }),
        fullRow({ SKU_ID: sku('S5'), Parent_Product_ID: '', URL_Slug: '', Tax_Rate: '120', Featured: 'maybe' }),
        fullRow({ SKU_ID: sku('BLK-M'), Parent_Product_ID: 'SOMETHING-ELSE', URL_Slug: '' }),
      ]),
      merchantId,
      staff,
    );
    expect(report.importedRows).toBe(0);
    expect(report.errors.map((e) => e.reason)).toEqual([
      "Unknown subcategory 'Pets' for category 'Clothing'",
      'MRP must not be less than Selling_Price',
      "Currency 'EUR' is not the store currency USD",
      `URL_Slug 'oxford-shirt-${run.toLowerCase()}-black-m' is already used by SKU ${sku('BLK-M')}`,
      "Featured 'maybe' is not one of TRUE, FALSE; Tax_Rate must be between 0 and 100",
      `SKU_ID belongs to parent product 'F-${run}', not 'SOMETHING-ELSE'`,
    ]);
  });

  it('bulk-updates price, MRP, stock, status, tax and threshold by SKU (FR-IM-10)', async () => {
    const updates = container.catalogUpdates;
    const report = await updates.updateFile(
      file(
        'prices.csv',
        [
          { SKU_ID: sku('BLK-M'), Selling_Price: '35.00', Inventory_Qty: '30', Product_Status: 'active', Tax_Rate: '5', Low_Stock_Threshold: '3' },
          { SKU_ID: sku('WHT-L'), Selling_Price: '44.99', Inventory_Qty: '5' }, // already so
          { SKU_ID: sku('NOPE'), Selling_Price: '1.00' },
          { SKU_ID: sku('WHT-L'), MRP: '' },
          { SKU_ID: '', Selling_Price: 'abc' },
        ],
        ['SKU_ID', 'Selling_Price', 'MRP', 'Inventory_Qty', 'Product_Status', 'Tax_Rate', 'Low_Stock_Threshold', 'Notes'],
      ),
      'ops@test.local',
    );
    expect(report).toMatchObject({ totalRows: 5, updatedRows: 1, unchangedRows: 0, failedRows: 4 });
    expect(report.columns).toEqual(['Selling_Price', 'MRP', 'Inventory_Qty', 'Product_Status', 'Tax_Rate', 'Low_Stock_Threshold']);
    expect(report.errors.map((e) => [e.row, e.reason])).toEqual([
      [3, 'SKU_ID appears more than once in the file (rows 3, 5)'],
      [4, 'Unknown SKU_ID'],
      [5, 'SKU_ID appears more than once in the file (rows 3, 5)'],
      [6, "SKU_ID is required; Selling_Price 'abc' is not a number"],
    ]);
    const p = await prisma.product.findUniqueOrThrow({
      where: { sku: sku('BLK-M') },
      include: { stockMovements: { where: { source: 'BULK_UPDATE' } } },
    });
    expect(p).toMatchObject({ status: 'ACTIVE', stockQuantity: 30, lowStockThreshold: 3 });
    expect([p.price.toFixed(2), p.taxRate?.toFixed(2)]).toEqual(['35.00', '5.00']);
    expect(p.stockMovements).toMatchObject([{ delta: 5, quantityAfter: 30, actor: 'ops@test.local' }]);

    const again = await updates.updateFile(
      file('same.csv', [
        { SKU_ID: sku('BLK-M'), Selling_Price: '35.00' },
        { SKU_ID: sku('WHT-L'), MRP: '30.00' },
      ]),
      null,
    );
    expect(again).toMatchObject({ updatedRows: 0, unchangedRows: 1, failedRows: 1 });
    expect(again.errors[0].reason).toBe('MRP 30.00 must not be less than Selling_Price 44.99');

    await expect(updates.updateFile(file('x.csv', [{ SKU_ID: 'A', Brand: 'B' }]), null)).rejects.toThrow(/at least one column/);
  });

  it('exports the catalog in the template columns, and the export re-imports unchanged (NFR-06)', async () => {
    const exportService = container.catalogExport;
    const csv = await exportService.export('csv');
    expect(csv.fileName).toMatch(/^catalog-\d{4}-\d{2}-\d{2}\.csv$/);
    const records = parse(csv.body, { bom: true, columns: true }) as Record<string, string>[];
    const header = Object.keys(records[0]);
    expect(header.slice(0, ALL_COLUMNS.length)).toEqual(ALL_COLUMNS.map((c) => c.header));
    expect(header).toContain('Neck_Type');

    const ours = records.filter((r) => r.Parent_Product_ID === `F-${run}`);
    expect(ours.map((r) => r.SKU_ID)).toEqual([sku('BLK-M'), sku('WHT-L')]);
    expect(ours[0]).toMatchObject({
      Category: 'clothing',
      Subcategory: 'clothing-women',
      Selling_Price: '35.00',
      MRP: '59.99',
      Discount: '42',
      Currency: 'USD',
      Inventory_Qty: '30',
      Featured: 'TRUE',
      Key_Features: 'Button-down collar\nChest pocket\nSlim fit',
      Neck_Type: 'Collar',
      Image_1_URL: img('3'),
    });

    const snapshot = async () =>
      prisma.product.findMany({
        where: { parent: { code: `F-${run}` } },
        orderBy: { sku: 'asc' },
        include: { parent: true, images: { where: { deleted: false }, orderBy: { position: 'asc' } } },
      });
    const before = await snapshot();
    const strip = (rows: Awaited<ReturnType<typeof snapshot>>) =>
      // The variant's copy of the description is refreshed from the parent's Long_Description.
      rows.map(({ updatedAt: _u, version: _v, description: _d, parent: { updatedAt: _pu, ...parent }, images, ...p }) => ({
        ...p,
        parent,
        images: images.map(({ id: _i, createdAt: _c, updatedAt: _iu, ...i }) => i),
      }));

    const back = await importer.importFile(file('export.csv', ours, header), merchantId, staff);
    expect(back.errors).toEqual([]);
    expect(back.warnings).toEqual([]);
    expect(back).toMatchObject({ updatedRows: 2, createdRows: 0 });
    expect(strip(await snapshot())).toEqual(strip(before));

    const xlsx = await exportService.export('xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).getCell(1).value).toBe('SKU_ID');
    const skus: unknown[] = [];
    sheet.eachRow((row) => skus.push(row.getCell(1).value));
    expect(skus).toEqual(expect.arrayContaining([sku('BLK-M'), sku('WHT-L')]));
  });

  it(
    'imports 1,000 rows well within a minute (FR-IM-12)',
    async () => {
      const N = 1000;
      const rows = Array.from({ length: N }, (_, i) => {
        const product = Math.floor(i / 4); // 250 parents with 4 variants each
        const [color, size] = [['Black', 'S'], ['Black', 'M'], ['Navy', 'S'], ['Navy', 'M']][i % 4];
        return fullRow({
          SKU_ID: '',
          Parent_Product_ID: '',
          URL_Slug: '',
          Product_Name: `Bulk Tee ${run} ${product} — ${color}, ${size}`,
          Brand: `Bulk ${run}`,
          Variant_Name: `${color} / ${size}`,
          Color: color,
          Size: size,
          Subcategory: product % 2 ? 'Men' : 'Women',
          Image_1_URL: img(`bulk-${i}-1`),
          Image_2_URL: img(`bulk-${i}-2`),
        });
      });

      const first = await importer.importFile(file('1000.csv', rows), merchantId, staff);
      expect(first.errors).toEqual([]);
      expect(first).toMatchObject({ importedRows: N, createdRows: N, parentProductsCreated: 250 });
      expect(new Set(first.imported.map((r) => r.sku)).size).toBe(N);
      console.log(`FR-IM-12: 1,000-row import (create) took ${first.durationMs} ms`);

      // Same sheet again: every row is an update, nothing duplicated.
      const second = await importer.importFile(file('1000.csv', rows), merchantId, staff);
      expect(second).toMatchObject({ importedRows: N, updatedRows: N, parentProductsCreated: 0, parentProductsUpdated: 250 });
      console.log(`FR-IM-12: 1,000-row re-import (update) took ${second.durationMs} ms`);
      expect(first.durationMs).toBeLessThan(60_000);
      expect(second.durationMs).toBeLessThan(60_000);
      expect(await prisma.product.count({ where: { parent: { brand: `Bulk ${run}` } } })).toBe(N);
    },
    180_000,
  );
});
