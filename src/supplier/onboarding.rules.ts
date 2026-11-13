import { z } from 'zod';
import { optionalString } from '../common/validation';
import { usStateCode } from '../support/us-states';

/**
 * Supplier onboarding rules: the application form, the automatic screening,
 * the SUP-001 scorecard and the documents a supplier must provide. Shared by
 * the applicant, seller and admin endpoints.
 */

// ── Stages ──────────────────────────────────────────────────────────────────

export const SUPPLIER_STAGES = [
  'DRAFT',
  'APPLIED',
  'SCREENED',
  'SCORECARD',
  'DOCUMENTS',
  'APPROVED',
  'DECLINED',
  'AUTO_REJECTED',
  'SUSPENDED',
] as const;
export type SupplierStage = (typeof SUPPLIER_STAGES)[number];

/** Stages where the catalog team scores the application. APPLIED = a lead from the old "Sell with us" form. */
export const SCORING_STAGES: readonly SupplierStage[] = ['APPLIED', 'SCREENED', 'SCORECARD'];

/** Admin list views (the design's tabs). */
export const SUPPLIER_VIEWS = ['todo', 'docs', 'active', 'closed', 'all'] as const;
export type SupplierView = (typeof SUPPLIER_VIEWS)[number];

// ── Application form ────────────────────────────────────────────────────────

export const BUSINESS_TYPES = ['Manufacturer', 'Brand owner', 'Wholesaler or distributor', 'Dropship supplier'] as const;
export const YEARS_IN_BUSINESS = ['Less than 1', '1–2', '3–5', '6–10', 'More than 10'] as const;
export const SUPPLIER_CATEGORIES = [
  'Home & decor',
  'Kitchen & dining',
  'Bedding & bath',
  'Apparel',
  'Kids & baby',
  'Outdoor & garden',
  'Pet supplies',
  'Electronics & audio',
  'Beauty & personal care',
  'Toys & games',
] as const;
export const PRODUCT_COUNTS = ['Under 50', '50–200', '200–1,000', 'Over 1,000'] as const;
export const OWN_BRAND = ['yes', 'no', 'both'] as const;
export const YES_NO = ['yes', 'no'] as const;
export const HANDLING_TIMES = ['Same day', '1 business day', '2 business days', '3–5 business days'] as const;
export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'Other'] as const;
export const PRODUCT_DATA = ['csv', 'shopify', 'woo', 'api', 'none'] as const;
export const PRODUCT_DATA_LABEL: Record<(typeof PRODUCT_DATA)[number], string> = {
  csv: 'Spreadsheet (CSV or Excel)',
  shopify: 'Shopify store',
  woo: 'WooCommerce store',
  api: 'Our own API',
  none: 'Not ready',
};

const text = (max: number) => optionalString({ max, sizeMessage: `Must not exceed ${max} characters` });
const list = (max: number) =>
  z
    .array(z.string().max(100, 'Too long'), { invalid_type_error: 'must be a list' })
    .max(max, 'Too many values')
    .nullish()
    .transform((v) => v ?? undefined);

/** The draft: every field optional and only length-checked, so a half-filled step can be saved. */
export const ApplicationFormSchema = z.object({
  legalName: text(200),
  tradingName: text(200),
  ein: text(10),
  website: text(255),
  businessType: text(60),
  yearsInBusiness: text(30),
  phone: text(30),
  street: text(255),
  city: text(100),
  state: text(2),
  zip: text(10),
  categories: list(SUPPLIER_CATEGORIES.length),
  productCount: text(30),
  ownBrand: text(10),
  brands: text(500),
  usWarehouse: text(3),
  warehouseState: text(2),
  shipsAllStates: text(3),
  handlingTime: text(30),
  carriers: list(CARRIERS.length),
  productData: text(20),
  moq: text(9),
  notes: text(2000),
});
export type ApplicationForm = z.output<typeof ApplicationFormSchema>;

export const SaveDraftSchema = z.object({
  step: z
    .number({ invalid_type_error: 'must be a number' })
    .int('must be a whole number')
    .min(0, 'must be between 0 and 4')
    .max(4, 'must be between 0 and 4')
    .nullish()
    .transform((v) => v ?? undefined),
  companyName: text(200),
  form: ApplicationFormSchema.nullish().transform((v) => v ?? undefined),
});

export const SubmitApplicationSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: 'Tick the box to confirm' }) }),
});

const isOneOf = (values: readonly string[], v: string | undefined) => v !== undefined && values.includes(v);
const blank = (v: string | undefined) => !v || !v.trim();

/** The form's steps and the fields each one owns (step 4 is "Check and submit"). */
export const FORM_STEPS: ReadonlyArray<ReadonlyArray<keyof ApplicationForm>> = [
  ['legalName', 'tradingName', 'ein', 'website', 'businessType', 'yearsInBusiness', 'phone', 'street', 'city', 'state', 'zip'],
  ['categories', 'productCount', 'ownBrand', 'brands'],
  ['usWarehouse', 'warehouseState', 'shipsAllStates', 'handlingTime', 'carriers'],
  ['productData', 'moq', 'notes'],
];

/** Submit-time checks, with the form's own messages. Empty when the application is complete. */
export function formErrors(f: ApplicationForm): Record<string, string> {
  const e: Record<string, string> = {};
  // Your company
  if ((f.legalName?.trim().length ?? 0) < 2) e.legalName = 'Enter your legal business name';
  if (!/^\d{2}-\d{7}$/.test(f.ein ?? '')) e.ein = 'Enter all 9 digits, like 12-3456789';
  if (f.website && !/^https?:\/\/\S+\.\S+/.test(f.website)) e.website = 'Start with https://';
  if (!isOneOf(BUSINESS_TYPES, f.businessType)) e.businessType = 'Choose your business type';
  if (!isOneOf(YEARS_IN_BUSINESS, f.yearsInBusiness)) e.yearsInBusiness = 'Choose one';
  if ((f.phone ?? '').replace(/\D/g, '').length < 10) e.phone = 'Enter a 10-digit phone number';
  if ((f.street?.trim().length ?? 0) < 4) e.street = 'Enter your street address';
  if (blank(f.city)) e.city = 'Enter the city';
  if (!f.state || !usStateCode(f.state)) e.state = 'Choose a state';
  if (!/^\d{5}(-\d{4})?$/.test(f.zip ?? '')) e.zip = 'Enter a 5-digit ZIP';
  // What you sell
  if (!f.categories?.length || !f.categories.every((c) => isOneOf(SUPPLIER_CATEGORIES, c))) e.categories = 'Choose at least one category';
  if (!isOneOf(PRODUCT_COUNTS, f.productCount)) e.productCount = 'Choose one';
  if (!isOneOf(OWN_BRAND, f.ownBrand)) e.ownBrand = 'Choose one';
  if (blank(f.brands)) e.brands = 'List at least one brand';
  // Shipping
  if (!isOneOf(YES_NO, f.usWarehouse)) e.usWarehouse = 'Choose yes or no';
  if (f.usWarehouse === 'yes' && (!f.warehouseState || !usStateCode(f.warehouseState))) e.warehouseState = 'Choose the warehouse state';
  if (!isOneOf(YES_NO, f.shipsAllStates)) e.shipsAllStates = 'Choose yes or no';
  if (!isOneOf(HANDLING_TIMES, f.handlingTime)) e.handlingTime = 'Choose your handling time';
  if (f.carriers && !f.carriers.every((c) => isOneOf(CARRIERS, c))) e.carriers = 'Choose from the list';
  // Product data
  if (!isOneOf(PRODUCT_DATA, f.productData)) e.productData = 'Choose how you’ll share product data';
  if (!/^\d+$/.test(f.moq ?? '') || Number(f.moq) < 1) e.moq = 'Enter a whole number, 1 or more';
  return e;
}

// ── Automatic screening ─────────────────────────────────────────────────────

export interface ScreeningCheck {
  key: string;
  label: string;
  passed: boolean;
  /** What the applicant is told when it fails. */
  reason: string;
}

/** Critical requirements, run on submit: any failure auto-rejects. */
export function screen(f: ApplicationForm): ScreeningCheck[] {
  return [
    { key: 'usWarehouse', label: 'Ships from a US warehouse', passed: f.usWarehouse === 'yes', reason: 'You don’t ship from a US warehouse' },
    { key: 'allStates', label: 'Ships to all 50 states', passed: f.shipsAllStates === 'yes', reason: 'You can’t ship to all 50 states' },
    { key: 'productData', label: 'Usable product data', passed: f.productData !== 'none', reason: 'Your product data isn’t ready to share yet' },
  ];
}

// ── Scorecard (SUP-001) ─────────────────────────────────────────────────────

export const SCORECARD = [
  { key: 'fit', label: 'Product fit', description: 'Matches our categories and customers', weight: 25 },
  { key: 'data', label: 'Catalog data quality', description: 'Clean titles, photos 1000 px+, complete fields', weight: 20 },
  { key: 'price', label: 'Price competitiveness', description: 'Wholesale price leaves room for our margin', weight: 20 },
  { key: 'ship', label: 'Fulfilment speed', description: 'Handling time and carrier coverage', weight: 15 },
  { key: 'quality', label: 'Quality & returns record', description: 'Defect/return history, references', weight: 10 },
  { key: 'stable', label: 'Business stability', description: 'Years trading, ability to supply steadily', weight: 10 },
] as const;
export const SCORE_PASS_MARK = 70;
export type Scores = Partial<Record<(typeof SCORECARD)[number]['key'], number>>;

const rating = z
  .number({ invalid_type_error: 'must be a number' })
  .int('must be a whole number')
  .min(1, 'must be between 1 and 5')
  .max(5, 'must be between 1 and 5')
  .nullish();

export const ScorecardSchema = z.object({
  scores: z.object(Object.fromEntries(SCORECARD.map((c) => [c.key, rating])) as Record<(typeof SCORECARD)[number]['key'], typeof rating>),
  note: optionalString({ max: 2000, sizeMessage: 'Note must not exceed 2000 characters' }),
});

export const ScoreOverrideSchema = z
  .object({
    score: z
      .number({ invalid_type_error: 'must be a number' })
      .int('must be a whole number')
      .min(0, 'must be between 0 and 100')
      .max(100, 'must be between 0 and 100')
      .nullable(),
    reason: optionalString({ max: 500, sizeMessage: 'Reason must not exceed 500 characters' }),
  })
  .refine((v) => v.score === null || (v.reason?.trim().length ?? 0) >= 5, { message: 'Add a reason', path: ['reason'] });

/** Weighted total out of 100, or null until every criterion has a 1–5 rating. */
export function weightedScore(scores: Scores): number | null {
  if (!SCORECARD.every((c) => typeof scores[c.key] === 'number')) return null;
  return Math.round(SCORECARD.reduce((sum, c) => sum + ((scores[c.key] as number) / 5) * c.weight, 0));
}

// ── Documents ───────────────────────────────────────────────────────────────

export const DOCUMENT_TYPES = [
  { type: 'W9', label: 'W-9 form', expires: false },
  { type: 'AGREEMENT', label: 'Signed seller agreement', expires: false },
  { type: 'INSURANCE', label: 'Certificate of insurance', expires: true },
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number]['type'];
export const DOCUMENT_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documentLabel = (type: string) => DOCUMENT_TYPES.find((d) => d.type === type)?.label ?? type;

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** Days before an insurance certificate expires when the supplier is reminded (and the admin list flags it). */
export const EXPIRY_WARNING_DAYS = 30;

export const DocumentReviewSchema = z.object({
  expiresAt: optionalString({ pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: 'Use YYYY-MM-DD' }),
});
export const DocumentRejectSchema = z.object({
  note: z
    .string({ required_error: 'Tell the supplier what to fix', invalid_type_error: 'must be a string' })
    .trim()
    .min(1, 'Tell the supplier what to fix')
    .max(1000, 'Note must not exceed 1000 characters'),
});

// ── Decisions ───────────────────────────────────────────────────────────────

const reason = (min: number, max: number, message: string) =>
  z
    .string({ required_error: message, invalid_type_error: 'must be a string' })
    .trim()
    .min(min, message)
    .max(max, `Must not exceed ${max} characters`);

export const DeclineSchema = z.object({ reason: reason(5, 2000, 'Add a reason') });
export const SUSPENSION_REASONS = ['Insurance expired', 'Quality or compliance issues', 'Repeated late shipments', 'Other'] as const;
export const SuspendSchema = z.object({ reason: reason(2, 500, 'Choose a reason') });
export const ApproveSchema = z.object({
  resaleCertificate: z.literal(true, { errorMap: () => ({ message: 'Tick “Ready to issue” for Form E-595E first' }) }),
});
export const RemindSchema = z.object({
  message: optionalString({ max: 1000, sizeMessage: 'Message must not exceed 1000 characters' }),
});
