/**
 * The master-sheet columns the importer reads (FR-IM-01), named as in the PRD
 * catalog template. Headers match case-insensitively, and spaces or hyphens
 * count as underscores ("Image 1 URL" is IMAGE_1_URL). Other template columns
 * (MRP, Tax_Code, SEO fields, …) are accepted and reported back as ignored
 * until the schema holds them.
 */
export interface ImportColumn {
  /** Header as written in the template. */
  header: string;
  /** Whether the column must exist in the file (not whether each cell must be filled). */
  requiredColumn: boolean;
}

const col = (header: string, requiredColumn = false): ImportColumn => ({ header, requiredColumn });

export const COLUMNS = {
  // Optional: rows without a SKU_ID (and Parent_Product_ID) get generated codes.
  SKU_ID: col('SKU_ID'),
  PARENT_PRODUCT_ID: col('Parent_Product_ID'),
  PRODUCT_NAME: col('Product_Name', true),
  BRAND: col('Brand'),
  CATEGORY: col('Category', true),
  // Not stored yet; read for the subcategory segment of generated codes.
  SUBCATEGORY: col('Subcategory'),
  PRODUCT_STATUS: col('Product_Status', true),
  VARIANT_NAME: col('Variant_Name'),
  COLOR: col('Color'),
  SIZE: col('Size'),
  MATERIAL: col('Material'),
  PATTERN: col('Pattern'),
  STYLE: col('Style'),
  SELLING_PRICE: col('Selling_Price', true),
  INVENTORY_QTY: col('Inventory_Qty', true),
  SHORT_DESCRIPTION: col('Short_Description'),
  LONG_DESCRIPTION: col('Long_Description'),
  // At least one image URL is mandatory per row; Image_1_URL must be present
  // as a column so the template can't silently drop the image block.
  IMAGE_1_URL: col('Image_1_URL', true),
  IMAGE_2_URL: col('Image_2_URL'),
  IMAGE_3_URL: col('Image_3_URL'),
  IMAGE_4_URL: col('Image_4_URL'),
  IMAGE_5_URL: col('Image_5_URL'),
} as const;

export const ALL_COLUMNS: ImportColumn[] = Object.values(COLUMNS);

export const IMAGE_COLUMNS = [
  COLUMNS.IMAGE_1_URL,
  COLUMNS.IMAGE_2_URL,
  COLUMNS.IMAGE_3_URL,
  COLUMNS.IMAGE_4_URL,
  COLUMNS.IMAGE_5_URL,
];

export function normalizeHeader(header: string): string {
  return header.replace(/﻿/g, ' ').trim().replace(/[\s-]+/g, '_').toUpperCase();
}

export const keyOf = (column: ImportColumn) => normalizeHeader(column.header);

const KNOWN = new Set(ALL_COLUMNS.map(keyOf));

export const isKnownHeader = (normalized: string) => KNOWN.has(normalized);

/**
 * One data row of an import file. `rowNumber` is the row as the user sees it
 * in Excel or a text editor: the header is row 1, the first data row row 2.
 */
export class ImportRow {
  constructor(
    readonly rowNumber: number,
    private readonly values: Map<string, string>,
  ) {}

  /** Trimmed cell text; empty string when the column or cell is absent. */
  get(column: ImportColumn): string {
    return (this.values.get(keyOf(column)) ?? '').trim();
  }
}
