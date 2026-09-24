import { stringify } from 'csv-stringify/sync';
import { ALL_COLUMNS } from './columns';

// One parent product (GS-CL-MEN-001) with two variant SKUs, in column order.
const EXAMPLE_ROWS = [
  [
    'GS-CL-MEN-001-BLK-M', 'GS-CL-MEN-001', "Men's Cotton Crew T-Shirt", 'Nexus Basics',
    'clothing', 'ACTIVE', 'Black / M', 'Black', 'M', 'Cotton', 'Solid', 'Casual',
    '499.00', '50', 'Soft cotton crew neck tee',
    'A breathable 100% cotton crew neck t-shirt for everyday wear.',
    'https://cdn.yourstore.com/products/GS-CL-MEN-001-BLK-01.jpg',
    'https://cdn.yourstore.com/products/GS-CL-MEN-001-BLK-02.jpg', '', '', '',
  ],
  [
    'GS-CL-MEN-001-WHT-L', 'GS-CL-MEN-001', "Men's Cotton Crew T-Shirt", 'Nexus Basics',
    'clothing', 'ACTIVE', 'White / L', 'White', 'L', 'Cotton', 'Solid', 'Casual',
    '499.00', '35', 'Soft cotton crew neck tee',
    'A breathable 100% cotton crew neck t-shirt for everyday wear.',
    'https://cdn.yourstore.com/products/GS-CL-MEN-001-WHT-01.jpg', '', '', '', '',
  ],
];

/** The downloadable import template: every column the importer reads, plus example rows. */
export function templateCsv(): string {
  return stringify([ALL_COLUMNS.map((c) => c.header), ...EXAMPLE_ROWS], { record_delimiter: '\r\n' });
}
