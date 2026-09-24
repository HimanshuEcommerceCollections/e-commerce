import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidImportFileError } from '../src/common/errors';
import { ALL_COLUMNS } from '../src/product/importer/columns';
import { templateCsv } from '../src/product/importer/template';
import { harness } from './support/harness';

/**
 * FR-IM-01 (bulk import from the template) and FR-IM-02 (parent products with
 * variant SKUs), against the real schema. (CatalogImportIT)
 */
const { prisma, container, fixtures } = harness();
const importer = container.catalogImport;

const HEADER =
  'SKU_ID,Parent_Product_ID,Product_Name,Brand,Category,Product_Status,' +
  'Variant_Name,Color,Size,Selling_Price,Inventory_Qty,Long_Description,Image_1_URL,Image_2_URL,MRP';

let merchantId: string;
let run: string;
let clothing: { id: string; name: string; slug: string };
let electronics: { id: string; name: string; slug: string };

beforeEach(async () => {
  merchantId = randomUUID();
  run = randomUUID().slice(0, 8).toUpperCase();
  clothing = await fixtures.newCategory(`Clothing ${run}`, `clothing-${run.toLowerCase()}`);
  electronics = await fixtures.newCategory(`Electronics ${run}`, `electronics-${run.toLowerCase()}`);
});

const sku = (suffix: string) => `T-${run}-${suffix}`;
const img = (n: string) => `https://cdn.test.local/products/${run}-${n}.jpg`;
/** One CSV line, quoting every cell. */
const row = (...cells: string[]) => cells.map((c) => `"${c.replaceAll('"', '""')}"`).join(',');
const csv = (...rows: string[]) => ({
  originalname: 'catalog.csv',
  buffer: Buffer.from(`${HEADER}\n${rows.join('\n')}\n`, 'utf8'),
});
const importCsv = (...rows: string[]) => importer.importFile(csv(...rows), merchantId);

const variantsOf = async (code: string) => {
  const parent = await prisma.parentProduct.findUniqueOrThrow({ where: { code } });
  const variants = await prisma.product.findMany({
    where: { parentId: parent.id, deleted: false },
    include: { images: { orderBy: { position: 'asc' } } },
    orderBy: { sku: 'asc' },
  });
  return { parent, variants };
};

describe('catalog import', () => {
  it('imports variants under one parent and standalone products under their own', async () => {
    const parent = `GS-CL-${run}`;
    const report = await importCsv(
      row(sku('BLK-M'), parent, 'Crew Tee', 'Nexus', clothing.slug, 'ACTIVE', 'Black / M', 'Black', 'M', '499.00', '50', 'Soft tee', img('1'), img('2'), '999'),
      row(sku('WHT-L'), parent, 'Crew Tee', 'Nexus', clothing.name, 'draft', 'White / L', 'White', 'L', '549.5', '0', '', img('3'), '', ''),
      row(sku('SOLO'), '', 'Earbuds', 'Sonic', electronics.slug, 'ACTIVE', '', '', '', '1,299.00', '10', '', img('4'), '', ''),
    );

    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ totalRows: 3, importedRows: 3, parentProductsCreated: 2, ignoredColumns: ['MRP'] });

    const tee = await variantsOf(parent);
    expect(tee.parent).toMatchObject({ name: 'Crew Tee', brand: 'Nexus', categoryId: clothing.id, merchantId });
    expect(tee.variants.map((v) => v.sku)).toEqual([sku('BLK-M'), sku('WHT-L')]);

    const [black, white] = tee.variants;
    expect(black.price.toFixed(2)).toBe('499.00');
    expect(black).toMatchObject({ stockQuantity: 50, status: 'ACTIVE', color: 'Black', size: 'M', categoryId: clothing.id });
    expect(black.images.map((i) => i.url)).toEqual([img('1'), img('2')]);
    expect(black.images[0].isPrimary).toBe(true);
    expect(white.price.toFixed(2)).toBe('549.50');
    expect(white.status).toBe('DRAFT');

    const solo = await variantsOf(sku('SOLO'));
    expect(solo.variants).toHaveLength(1);
    expect(solo.variants[0].price.toFixed(2)).toBe('1299.00');
  });

  it('rejects bad rows with reasons and still imports the rest', async () => {
    const existingSku = (await fixtures.newActiveProduct(5, '10.00')).sku;
    const parent = `GS-CL-${run}`;
    const c = clothing.slug;

    const report = await importCsv(
      /* row 2 */ row(sku('OK'), parent, 'Tee', '', c, 'ACTIVE', '', '', '', '10', '1', '', img('1'), '', ''),
      /* row 3 */ row(sku('NOPRICE'), '', 'Tee', '', c, 'ACTIVE', '', '', '', '', '1', '', img('2'), '', ''),
      /* row 4 */ row(sku('NOCAT'), '', 'Tee', '', 'no-such-category', 'ACTIVE', '', '', '', '10', '1', '', img('3'), '', ''),
      /* row 5 */ row(sku('BADIMG'), '', 'Tee', '', c, 'ACTIVE', '', '', '', '10', '1', '', 'ftp://x/y.jpg', '', ''),
      /* row 6 */ row(sku('DUP'), '', 'Tee', '', c, 'ACTIVE', '', '', '', '10', '1', '', img('4'), '', ''),
      /* row 7 */ row(sku('DUP'), '', 'Tee', '', c, 'ACTIVE', '', '', '', '10', '1', '', img('5'), '', ''),
      /* row 8 */ row(existingSku, '', 'Tee', '', c, 'ACTIVE', '', '', '', '10', '1', '', img('6'), '', ''),
      /* row 9 */ row(sku('WRONGCAT'), parent, 'Tee', '', electronics.slug, 'ACTIVE', '', '', '', '10', '1', '', img('7'), '', ''),
      /* row 10 */ row('', '', '', '', '', 'LIVE', '', '', '', '-1', '1.5', '', '', '', ''),
    );

    expect(report).toMatchObject({ totalRows: 9, importedRows: 1, failedRows: 8 });
    const byRow = new Map(report.errors.map((e) => [e.row, e]));
    expect([...byRow.keys()]).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(byRow.get(3)).toEqual({ row: 3, sku: sku('NOPRICE'), reason: 'Selling_Price is required' });
    expect(byRow.get(4)!.reason).toBe("Unknown category 'no-such-category'");
    expect(byRow.get(5)!.reason).toMatch(/Image_1_URL .* is not an http\(s\) URL/);
    expect(byRow.get(6)!.reason).toBe('SKU_ID appears more than once in the file (rows 6, 7)');
    expect(byRow.get(7)!.reason).toBe(byRow.get(6)!.reason);
    expect(byRow.get(8)!.reason).toBe('SKU_ID already exists in the catalog');
    expect(byRow.get(9)!.reason).toContain(`differs from the other variants of '${parent}' (row 2`);
    expect(byRow.get(10)!.sku).toBeNull();
    for (const part of [
      'SKU_ID is required',
      'Product_Name is required',
      'Category is required',
      "Product_Status 'LIVE' is not one of",
      'Selling_Price must be greater than 0',
      "Inventory_Qty '1.5' is not a whole number",
      'At least one image URL',
    ]) {
      expect(byRow.get(10)!.reason).toContain(part);
    }

    expect(await prisma.product.count({ where: { sku: sku('OK') } })).toBe(1);
    expect(await prisma.product.count({ where: { sku: { in: [sku('NOPRICE'), sku('DUP')] } } })).toBe(0);
  });

  it("a later import adds variants to an existing parent, but not to another merchant's", async () => {
    const parent = `GS-CL-${run}`;
    const c = clothing.slug;
    await importCsv(row(sku('A'), parent, 'Tee', '', c, 'ACTIVE', '', '', 'S', '10', '1', '', img('1'), '', ''));

    const second = await importCsv(
      row(sku('B'), parent, 'Renamed Tee', '', c, 'ACTIVE', '', '', 'M', '10', '1', '', img('2'), '', ''),
      row(sku('C'), parent, 'Tee', '', electronics.slug, 'ACTIVE', '', '', 'L', '10', '1', '', img('3'), '', ''),
    );
    expect(second.importedRows).toBe(1);
    expect(second.parentProductsCreated).toBe(0);
    expect(second.errors).toHaveLength(1);
    expect(second.errors[0].reason).toContain('does not match the existing parent product');

    const existing = await variantsOf(parent);
    expect(existing.parent.name).toBe('Tee'); // the existing parent keeps its details
    expect(existing.variants.map((v) => v.sku)).toEqual([sku('A'), sku('B')]);

    const otherMerchant = await importer.importFile(
      csv(row(sku('D'), parent, 'Tee', '', c, 'ACTIVE', '', '', 'XL', '10', '1', '', img('4'), '', '')),
      randomUUID(),
    );
    expect(otherMerchant.importedRows).toBe(0);
    expect(otherMerchant.errors[0].reason).toContain('already used by another product');
  });

  it('reads Excel workbooks, including numeric cells and spaced headers', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Master');
    sheet.addRow(['SKU ID', 'Product Name', 'Category', 'Product Status', 'Selling Price', 'Inventory Qty', 'Image 1 URL']);
    sheet.addRow([sku('XL'), 'Kettle', clothing.slug, 'ACTIVE', 1499.5, 12, img('1')]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const report = await importer.importFile({ originalname: 'catalog.xlsx', buffer }, merchantId);

    expect(report.errors).toEqual([]);
    expect(report.importedRows).toBe(1);
    const product = await prisma.product.findUniqueOrThrow({ where: { sku: sku('XL') } });
    expect(product.price.toFixed(2)).toBe('1499.50');
    expect(product.stockQuantity).toBe(12);
  });

  it('file-level problems reject the whole file', async () => {
    const file = (name: string, text: string) => ({ originalname: name, buffer: Buffer.from(text, 'utf8') });

    await expect(
      importer.importFile(file('c.csv', 'SKU_ID,Product_Name,Category,Product_Status,Inventory_Qty\nA,B,C,ACTIVE,1\n'), merchantId),
    ).rejects.toThrow(new InvalidImportFileError('Missing required columns: Selling_Price, Image_1_URL'));
    await expect(importer.importFile(file('c.json', '{}'), merchantId)).rejects.toThrow(/Unsupported file type/);
    await expect(importer.importFile(file('c.csv', `${HEADER}\n`), merchantId)).rejects.toThrow(/no data rows/);
    await expect(importer.importFile(file('c.xlsx', 'not a workbook'), merchantId)).rejects.toThrow(
      /could not be read as an Excel workbook/,
    );
    await expect(importer.importFile(file('c.csv', ''), merchantId)).rejects.toThrow(/empty/);
  });

  it('the template has every column and its example rows parse', async () => {
    const template = templateCsv();
    const header = template.split(/\r?\n/)[0];
    for (const column of ALL_COLUMNS) expect(header).toContain(column.header);

    // The examples name category 'clothing', which may not exist here; every
    // other check must pass, so that is the only reason given.
    const report = await importer.importFile({ originalname: 'template.csv', buffer: Buffer.from(template) }, merchantId);
    expect(report.totalRows).toBe(2);
    for (const e of report.errors) {
      expect(["Unknown category 'clothing'", 'SKU_ID already exists in the catalog']).toContain(e.reason);
    }
  });
});
