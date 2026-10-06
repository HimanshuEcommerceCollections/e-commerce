import type { ProductCategory } from '@prisma/client';
import { isKnownHeader, normalizeHeader } from './columns';
import { categoryCode } from './sku-codes';

/**
 * Category attribute sheets (PRD §4): per department, the extra columns whose
 * values go into the parent product's `attributes` (facets such as Fit or
 * Connectivity). Columns the master sheet already has (Color, Size, Material,
 * Brand, Dimensions, Weight, Warranty…) are read as master columns instead.
 * A few names the storefront design uses for facets (Dietary, Format, Age,
 * Activity, "Skin & hair type") are accepted too, so exports re-import.
 */
const SHEETS: Record<string, string[]> = {
  CL: ['Gender', 'Age_Group', 'Fit', 'Neck_Type', 'Sleeve_Type', 'Occasion', 'Care_Instructions'],
  EL: ['Model', 'Compatibility', 'Connectivity', 'Power', 'Battery'],
  HK: ['Capacity', 'Shape', 'Finish', 'Usage', 'Care_Instructions'],
  GR: [
    'Food_Type', 'Veg_NonVeg', 'Net_Weight', 'Pack_Size', 'Ingredients', 'Nutrition', 'Expiry', 'Shelf_Life',
    'Storage_Instructions', 'Country_of_Origin', 'Dietary',
  ],
  BP: ['Skin_Type', 'Hair_Type', 'Concern', 'Ingredient', 'Net_Quantity', 'Fragrance', 'Form', 'Usage', 'Shelf_Life', 'Skin & hair type'],
  TK: ['Age_Group', 'Gender', 'Theme', 'Battery_Required', 'Safety_Info', 'Educational_Type', 'Age'],
  SF: ['Sport_Type', 'Skill_Level', 'Usage', 'Activity'],
  BS: ['Format', 'Author', 'Publisher', 'Language', 'Age'],
  LS: ['Occasion', 'Theme'],
};

/** The PRD's own category codes for departments whose stored code is missing or differs. */
const ALIASES: Record<string, string> = { GF: 'GR', KT: 'TK' };

/** Attribute name as stored, by normalized header. */
const NAMES = new Map<string, string>();
for (const names of Object.values(SHEETS)) {
  for (const name of names) if (!isKnownHeader(normalizeHeader(name))) NAMES.set(normalizeHeader(name), name);
}

/** Attribute headers (normalized) the department's sheet has; every sheet's when the department is unknown. */
export function attributeKeysFor(department: ProductCategory): Set<string> {
  const code = department.code?.toUpperCase() ?? categoryCode(department.name, department.slug);
  const sheet = SHEETS[ALIASES[code] ?? code];
  if (!sheet) return new Set(NAMES.keys());
  return new Set(sheet.map(normalizeHeader).filter((k) => NAMES.has(k)));
}

/** Stored attribute name for a normalized header, or undefined when no sheet has it. */
export const attributeName = (normalized: string) => NAMES.get(normalized);
