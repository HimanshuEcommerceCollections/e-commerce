import { stringify } from 'csv-stringify/sync';
import { ALL_COLUMNS } from './columns';

const shared = {
  Parent_Product_ID: 'GS-CL-MEN-001',
  Product_Name: "Men's Cotton Crew T-Shirt",
  Brand: 'Nexus Basics',
  Category: 'clothing',
  Subcategory: 'Men',
  Product_Type: 'T-shirts & polos',
  Product_Status: 'ACTIVE',
  Featured: 'FALSE',
  Material: 'Cotton',
  Pattern: 'Solid',
  Style: 'Casual',
  MRP: '24.99',
  Selling_Price: '19.99',
  Cost: '9.50',
  Discount: '20',
  Tax_Code: 'CL-STD',
  Tax_Rate: '8.25',
  Currency: 'USD',
  Low_Stock_Threshold: '5',
  Supplier_ID: 'SUP-NEXUS',
  Warehouse_ID: 'WH-PDX',
  Shipping_Class: 'standard',
  Short_Description: 'Soft cotton crew neck tee',
  Long_Description: 'A breathable 100% cotton crew neck t-shirt for everyday wear.',
  Key_Features: '100% cotton | Regular fit | Machine washable',
  Specifications: 'Fabric weight: 180 gsm',
  Dimensions: '',
  Weight: '0.2 kg',
  Whats_Included: '1 t-shirt',
  Usage_Instructions: 'Machine wash cold; tumble dry low.',
  Warranty: '',
  Lifestyle_Image_URL: 'https://cdn.yourstore.com/products/GS-CL-MEN-001-LIFE.jpg',
  Size_Chart_URL: 'https://cdn.yourstore.com/size-charts/mens-tops.jpg',
  Infographic_URL: '',
  Search_Keywords: 'tee, t-shirt, crew neck, cotton',
};

// One parent product (GS-CL-MEN-001) with two variant SKUs. Leave SKU_ID and
// Parent_Product_ID blank to have them generated. Fit and Gender come from the
// Clothing attribute sheet: add the department's attribute columns after the
// master columns.
const EXAMPLES: Record<string, string>[] = [
  {
    ...shared,
    SKU_ID: 'GS-CL-MEN-001-BLK-M',
    Variant_Name: 'Black / M',
    Color: 'Black',
    Size: 'M',
    Inventory_Qty: '50',
    Image_1_URL: 'https://cdn.yourstore.com/products/GS-CL-MEN-001-BLK-01.jpg',
    Image_2_URL: 'https://cdn.yourstore.com/products/GS-CL-MEN-001-BLK-02.jpg',
    Thumbnail_URL: '',
    SEO_Title: "Men's Cotton Crew T-Shirt, Black",
    Meta_Description: 'Soft, breathable cotton crew neck tee in black.',
    URL_Slug: 'mens-cotton-crew-t-shirt-black-m',
    Gender: 'Men',
    Fit: 'Regular',
  },
  {
    ...shared,
    SKU_ID: 'GS-CL-MEN-001-WHT-L',
    Variant_Name: 'White / L',
    Color: 'White',
    Size: 'L',
    Inventory_Qty: '35',
    Image_1_URL: 'https://cdn.yourstore.com/products/GS-CL-MEN-001-WHT-01.jpg',
    SEO_Title: "Men's Cotton Crew T-Shirt, White",
    Meta_Description: 'Soft, breathable cotton crew neck tee in white.',
    URL_Slug: '',
    Gender: 'Men',
    Fit: 'Regular',
  },
];

const ATTRIBUTE_EXAMPLE_COLUMNS = ['Gender', 'Fit'];

/** The downloadable import template: every master column, two attribute columns, and example rows. */
export function templateCsv(): string {
  const headers = [...ALL_COLUMNS.map((c) => c.header), ...ATTRIBUTE_EXAMPLE_COLUMNS];
  return stringify([headers, ...EXAMPLES.map((e) => headers.map((h) => e[h] ?? ''))], { record_delimiter: '\r\n' });
}
