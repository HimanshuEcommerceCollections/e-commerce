/**
 * The master-sheet columns of the catalog template (FR-IM-01), named as in the
 * PRD. Headers match case-insensitively, and spaces or hyphens count as
 * underscores ("Image 1 URL" is IMAGE_1_URL). Columns of the category
 * attribute sheets (Gender, Fit, Connectivity…) are listed in attributes.ts.
 */
export interface ImportColumn {
  /** Header as written in the template. */
  header: string;
  /** Whether the column must exist in the file (not whether each cell must be filled). */
  requiredColumn: boolean;
}

const col = (header: string, requiredColumn = false): ImportColumn => ({ header, requiredColumn });

export const COLUMNS = {
  // Identification. Rows without a SKU_ID (and Parent_Product_ID) get generated codes.
  SKU_ID: col('SKU_ID'),
  PARENT_PRODUCT_ID: col('Parent_Product_ID'),
  PRODUCT_NAME: col('Product_Name', true),
  BRAND: col('Brand'),
  CATEGORY: col('Category', true),
  SUBCATEGORY: col('Subcategory'),
  PRODUCT_TYPE: col('Product_Type'),
  PRODUCT_STATUS: col('Product_Status', true),
  FEATURED: col('Featured'),
  // Variants
  VARIANT_NAME: col('Variant_Name'),
  COLOR: col('Color'),
  SIZE: col('Size'),
  MATERIAL: col('Material'),
  PATTERN: col('Pattern'),
  STYLE: col('Style'),
  // Commercial
  MRP: col('MRP'),
  SELLING_PRICE: col('Selling_Price', true),
  COST: col('Cost'),
  DISCOUNT: col('Discount'),
  TAX_CODE: col('Tax_Code'),
  TAX_RATE: col('Tax_Rate'),
  CURRENCY: col('Currency'),
  INVENTORY_QTY: col('Inventory_Qty', true),
  LOW_STOCK_THRESHOLD: col('Low_Stock_Threshold'),
  SUPPLIER_ID: col('Supplier_ID'),
  WAREHOUSE_ID: col('Warehouse_ID'),
  SHIPPING_CLASS: col('Shipping_Class'),
  // Content
  SHORT_DESCRIPTION: col('Short_Description'),
  LONG_DESCRIPTION: col('Long_Description'),
  KEY_FEATURES: col('Key_Features'),
  SPECIFICATIONS: col('Specifications'),
  DIMENSIONS: col('Dimensions'),
  WEIGHT: col('Weight'),
  WHATS_INCLUDED: col('Whats_Included'),
  USAGE_INSTRUCTIONS: col('Usage_Instructions'),
  WARRANTY: col('Warranty'),
  // Images. At least one gallery URL is mandatory per row; Image_1_URL must be
  // present as a column so the template can't silently drop the image block.
  IMAGE_1_URL: col('Image_1_URL', true),
  IMAGE_2_URL: col('Image_2_URL'),
  IMAGE_3_URL: col('Image_3_URL'),
  IMAGE_4_URL: col('Image_4_URL'),
  IMAGE_5_URL: col('Image_5_URL'),
  THUMBNAIL_URL: col('Thumbnail_URL'),
  LIFESTYLE_IMAGE_URL: col('Lifestyle_Image_URL'),
  SIZE_CHART_URL: col('Size_Chart_URL'),
  INFOGRAPHIC_URL: col('Infographic_URL'),
  // SEO
  SEO_TITLE: col('SEO_Title'),
  META_DESCRIPTION: col('Meta_Description'),
  SEARCH_KEYWORDS: col('Search_Keywords'),
  URL_SLUG: col('URL_Slug'),
} as const;

export const ALL_COLUMNS: ImportColumn[] = Object.values(COLUMNS);

/** The SKU's gallery, in position order. */
export const IMAGE_COLUMNS = [
  COLUMNS.IMAGE_1_URL,
  COLUMNS.IMAGE_2_URL,
  COLUMNS.IMAGE_3_URL,
  COLUMNS.IMAGE_4_URL,
  COLUMNS.IMAGE_5_URL,
];

/** Images stored on the parent product. */
export const PARENT_IMAGE_COLUMNS = [COLUMNS.LIFESTYLE_IMAGE_URL, COLUMNS.SIZE_CHART_URL, COLUMNS.INFOGRAPHIC_URL];

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
    return this.getKey(keyOf(column));
  }

  /** Trimmed cell text by normalized header. */
  getKey(key: string): string {
    return (this.values.get(key) ?? '').trim();
  }

  /** Whether the file has this column (a re-import only overwrites the columns it has). */
  has(column: ImportColumn): boolean {
    return this.values.has(keyOf(column));
  }

  hasKey(key: string): boolean {
    return this.values.has(key);
  }
}
