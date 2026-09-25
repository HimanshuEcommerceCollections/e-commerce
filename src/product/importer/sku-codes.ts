/**
 * Building blocks of generated catalog codes, following the PRD convention:
 * parent products are `GS-<CATEGORY>-<SUBCATEGORY>-<SEQUENCE>` (GS-CL-MEN-001)
 * and variant SKUs append attribute codes (GS-CL-MEN-001-BLK-M). Every
 * function here returns only characters a SKU_ID may hold.
 */

export const SKU_PREFIX = 'GS';

/** Codes of the PRD's categories, matched on a word of the category's name or slug. */
const CATEGORY_CODES: [RegExp, string][] = [
  [/\bclothing\b|\bapparel\b|\bfashion\b/, 'CL'],
  [/\belectronics?\b/, 'EL'],
  [/\bhome\b|\bkitchen\b/, 'HK'],
  [/\bgrocery\b|\bfood\b/, 'GF'],
  [/\bbeauty\b|\bpersonal care\b/, 'BP'],
  [/\btoys?\b/, 'KT'],
  [/\bsports?\b|\bfitness\b/, 'SF'],
];

const COLOR_CODES: Record<string, string> = {
  black: 'BLK', white: 'WHT', navy: 'NVY', grey: 'GRY', gray: 'GRY', red: 'RED', blue: 'BLU',
  green: 'GRN', brown: 'BRN', pink: 'PNK', purple: 'PRP', yellow: 'YLW', orange: 'ORG',
  beige: 'BGE', olive: 'OLV', cream: 'CRM', silver: 'SLV', gold: 'GLD', maroon: 'MRN',
};

const SIZE_CODES: Record<string, string> = { 'one size': 'OS', 'free size': 'FS' };

const words = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** "Clothing & Fashion" → CL. Unknown categories use their initials ("Pet Supplies" → PS). */
export function categoryCode(name: string, slug: string): string {
  const text = `${name} ${slug.replace(/-/g, ' ')}`.toLowerCase();
  for (const [pattern, code] of CATEGORY_CODES) if (pattern.test(text)) return code;
  const w = words(name).filter((x) => x.toLowerCase() !== 'and');
  const code = w.length > 1 ? w.map((x) => x[0]).join('').slice(0, 3) : (w[0] ?? 'XX').slice(0, 2);
  return code.toUpperCase();
}

/** "Men" → MEN, "Women" → WOM, "Home Decor" → HD; no subcategory → GEN. */
export function subcategoryCode(subcategory: string): string {
  const w = words(subcategory).filter((x) => x.toLowerCase() !== 'and');
  if (w.length === 0) return 'GEN';
  return (w.length > 1 ? w.map((x) => x[0]).join('').slice(0, 3) : w[0].slice(0, 3)).toUpperCase();
}

/** A word's code: its first letter and next consonants ("Stone" → STN), padded from the word. */
function wordCode(word: string): string {
  const upper = word.toUpperCase();
  if (/^\d/.test(upper)) return upper;
  let code = upper[0] + upper.slice(1).replace(/[AEIOU]/g, '');
  if (code.length < 3) code = upper;
  return code.slice(0, 3);
}

/**
 * "Black" → BLK, "Stone" → STN, "Light Blue" → LGHBLU. Every word is coded, so
 * "Blue Stripe" (BLUSTR) and "Black Stripe" (BLKSTR) stay apart.
 */
export function colorCode(color: string): string {
  return words(color)
    .map((w) => COLOR_CODES[w.toLowerCase()] ?? wordCode(w))
    .join('')
    .toUpperCase()
    .slice(0, 12);
}

/** "M" → M, "4-5Y" → 45Y, "One Size" → OS, "32" → 32. */
export function sizeCode(size: string): string {
  const known = SIZE_CODES[size.trim().toLowerCase()];
  if (known) return known;
  const w = words(size);
  if (w.length > 1 && w.every((x) => /^[A-Za-z]/.test(x))) return w.map((x) => x[0]).join('').toUpperCase();
  return w.join('').toUpperCase().slice(0, 10);
}

/** Code for a variant name when a row has no colour or size ("Pack of 6" → PO6). */
export function variantCode(variantName: string): string {
  const w = words(variantName);
  return (w.length > 1 ? w.map((x) => (/^\d/.test(x) ? x : x[0])).join('') : (w[0] ?? '').slice(0, 6))
    .toUpperCase()
    .slice(0, 10);
}

/**
 * The product's name without the variant part the sheet appends to it:
 * "Northbank Crew Neck T-Shirt — Black, M" → "Northbank Crew Neck T-Shirt".
 * The trailing part after a dash, bar or opening parenthesis is dropped only
 * when it names the row's colour or size, so "Wi-Fi Router - Dual Band" stays whole.
 */
export function baseProductName(name: string, color: string | null, size: string | null): string {
  const match = /^(.*\S)\s*(?:\s[—–|-]\s|\()\s*([^—–|(]+?)\)?\s*$/.exec(name);
  if (!match) return name;
  const tail = ` ${words(match[2]).join(' ').toLowerCase()} `;
  const names = (v: string | null) => !!v && tail.includes(` ${words(v).join(' ').toLowerCase()} `);
  return names(color) || names(size) ? match[1] : name;
}
