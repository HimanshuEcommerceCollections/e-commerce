/**
 * Storefront listing model (contract A1–A4), ported from the web client's
 * plpModel.ts / DayloraSearch.tsx so the server answers exactly as the
 * client-side filtering did: one item per parent product, disjunctive facets,
 * the same price buckets and attribute names, keyword search with AND
 * matching, synonyms and spelling correction, and the same sort rules.
 * Pure functions over already-loaded parents (see storefront.service.ts).
 */

/** One live (ACTIVE, not deleted) variant SKU. */
export interface CatalogVariant {
  id: string;
  sku: string;
  price: number;
  priceText: string;
  mrp: number | null;
  mrpText: string | null;
  stock: number;
  color: string | null;
  size: string | null;
  material: string | null;
  keywords: string | null;
  slug: string | null;
  lowStockThreshold: number | null;
  createdAt: Date;
  imageUrl: string | null;
  unitsSold: number;
}

export interface Named {
  slug: string;
  name: string;
}

/** A parent product with its live variants (newest first) and what the PLP derives from them. */
export interface CatalogItem {
  parentId: string;
  code: string;
  name: string;
  brand: string | null;
  productType: string | null;
  attributes: Record<string, string>;
  featured: boolean;
  ratingAvg: number;
  ratingCount: number;
  createdAt: Date;
  dept: Named | null;
  sec: Named | null;
  variants: CatalogVariant[];
  /** Position in "newest SKU first" order: the tie-breaker everywhere. */
  rank: number;
  // Derived (see derive()).
  lead: CatalogVariant;
  /** The variant whose price the card shows: cheapest in stock, else cheapest. */
  priced: CatalogVariant;
  prices: number[];
  colors: string[];
  sizes: string[];
  stock: number;
  unitsSold: number;
  isNew: boolean;
  onSale: boolean;
  /** Fraction off MRP on the card price. */
  discount: number;
  /** Highest saving among the variants, as a fraction of MRP (deals sort). */
  bestDiscount: number;
  attrs: Partial<Record<AttrKey, string[]>>;
}

/** The parent's attribute sheet, keyed as the URL facet (plpModel ATTR_FACETS, plus gender). */
export const ATTR_FACETS = {
  fit: 'Fit',
  material: 'Material',
  conn: 'Connectivity',
  diet: 'Dietary',
  skin: 'Skin & hair type',
  format: 'Format',
  age: 'Age',
  activity: 'Activity',
  occasion: 'Occasion',
  gender: 'Gender',
} as const;
export type AttrKey = keyof typeof ATTR_FACETS;
export const ATTR_KEYS = Object.keys(ATTR_FACETS) as AttrKey[];

export const FACET_KEYS = ['dept', 'g', 'type', 'brand', 'color', 'size', 'price', ...ATTR_KEYS] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

export const PRICES = [
  { k: 'u10', t: 'Under $10', f: (x: number) => x < 10 },
  { k: '10-25', t: '$10 – $25', f: (x: number) => x >= 10 && x < 25 },
  { k: '25-50', t: '$25 – $50', f: (x: number) => x >= 25 && x < 50 },
  { k: '50-100', t: '$50 – $100', f: (x: number) => x >= 50 && x < 100 },
  { k: 'o100', t: '$100 & over', f: (x: number) => x >= 100 },
];

export const SORTS = ['rel', 'pop', 'new', 'asc', 'desc', 'discount', 'rating'] as const;
export type SortKey = (typeof SORTS)[number];

const NEW_DAYS = 30;
const DAY_MS = 86_400_000;

const split = (v: string | null | undefined) =>
  v ? v.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean) : [];
const uniq = (vals: (string | null)[]) => Array.from(new Set(vals.filter((v): v is string => !!v)));

/** Letter sizes in wearing order; anything else numerically, then alphabetically (catalog.ts). */
const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL'];
export function compareSizes(a: string, b: string): number {
  const ia = SIZE_ORDER.indexOf(a.toUpperCase());
  const ib = SIZE_ORDER.indexOf(b.toUpperCase());
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  const na = parseFloat(a), nb = parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

const disc = (v: CatalogVariant) => (v.mrp && v.mrp > v.price ? (v.mrp - v.price) / v.mrp : 0);

/** Fills the derived fields of a loaded parent (variants newest first). */
export function derive(
  base: Omit<CatalogItem, 'lead' | 'priced' | 'prices' | 'colors' | 'sizes' | 'stock' | 'unitsSold' | 'isNew' | 'onSale' | 'discount' | 'bestDiscount' | 'attrs'>,
  now = Date.now(),
): CatalogItem {
  const v = base.variants;
  const inStock = v.filter((s) => s.stock > 0);
  const pool = inStock.length ? inStock : v;
  const priced = [...pool].sort((a, b) => a.price - b.price)[0];
  const attrs: Partial<Record<AttrKey, string[]>> = {};
  for (const k of ATTR_KEYS) {
    const vals = split(base.attributes[ATTR_FACETS[k]]);
    if (k === 'material' && !vals.length) vals.push(...uniq(v.map((s) => s.material)));
    if (vals.length) attrs[k] = vals;
  }
  const discount = disc(priced);
  return {
    ...base,
    lead: inStock[0] ?? v[0],
    priced,
    prices: Array.from(new Set(pool.map((s) => s.price))),
    colors: uniq(v.map((s) => s.color)),
    sizes: uniq(v.map((s) => s.size)).sort(compareSizes),
    stock: v.reduce((n, s) => n + Math.max(0, s.stock), 0),
    unitsSold: v.reduce((n, s) => n + s.unitsSold, 0),
    isNew: now - base.createdAt.getTime() < NEW_DAYS * DAY_MS,
    onSale: v.some((s) => !!s.mrp && s.mrp > s.price),
    discount,
    bestDiscount: v.reduce((best, s) => Math.max(best, disc(s)), 0),
    attrs,
  };
}

/* --------------------------------------------------------------- facets */

export function facetValues(k: FacetKey, x: CatalogItem): string[] {
  switch (k) {
    case 'dept': return x.dept ? [x.dept.slug] : [];
    case 'g': return x.sec ? [x.sec.slug] : [];
    case 'type': return x.productType ? [x.productType] : [];
    case 'brand': return x.brand ? [x.brand] : [];
    case 'color': return x.colors;
    case 'size': return x.sizes;
    case 'price': return PRICES.filter((r) => x.prices.some(r.f)).map((r) => r.k);
    default: return x.attrs[k] ?? [];
  }
}

export type Selection = Partial<Record<FacetKey, Set<string>>>;

/** Applied to every facet count and the results alike. */
export interface Toggles {
  inStock: boolean;
  onSale: boolean;
  priceMin: number | null;
  priceMax: number | null;
}

/**
 * Whether an item has a selected value. Department and section match
 * case-insensitively; a section also matches by name or slug suffix
 * ("g=men" finds "clothing-men"), as the listing page's URL did.
 */
function selected(k: FacetKey, x: CatalogItem, s: Set<string>): boolean {
  if (k === 'dept') return !!x.dept && s.has(x.dept.slug.toLowerCase());
  if (k === 'g') {
    if (!x.sec) return false;
    const slug = x.sec.slug.toLowerCase();
    const name = x.sec.name.toLowerCase();
    for (const v of s) if (v === slug || v === name || slug.endsWith(`-${v}`)) return true;
    return false;
  }
  return facetValues(k, x).some((v) => s.has(v));
}

/** Disjunctive matching: a facet's own selection is skipped when counting its options. */
export function matches(x: CatalogItem, sel: Selection, t: Toggles, skip?: FacetKey): boolean {
  for (const k of FACET_KEYS) {
    const s = sel[k];
    if (k === skip || !s || !s.size) continue;
    if (!selected(k, x, s)) return false;
  }
  if (t.inStock && x.stock <= 0) return false;
  if (t.onSale && !x.onSale) return false;
  if (t.priceMin !== null && x.priced.price < t.priceMin) return false;
  if (t.priceMax !== null && x.priced.price > t.priceMax) return false;
  return true;
}

/** Option order inside a facet (plpModel orderValues). */
export function orderValues(k: FacetKey, vals: string[]): string[] {
  if (k === 'price') return PRICES.map((r) => r.k).filter((v) => vals.includes(v));
  if (k === 'fit') {
    const order = ['Slim', 'Regular', 'Relaxed'];
    return [...vals].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  }
  if (k === 'age') return [...vals].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
  if (k === 'size') return [...vals].sort(compareSizes);
  return [...vals].sort((a, b) => a.localeCompare(b));
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/** Every value present in the scope, with its disjunctive count (possibly 0). */
export function facetCounts(scope: CatalogItem[], sel: Selection, t: Toggles): Record<FacetKey, FacetOption[]> {
  const out = {} as Record<FacetKey, FacetOption[]>;
  for (const k of FACET_KEYS) {
    const counts = new Map<string, number>();
    const labels = new Map<string, string>();
    for (const x of scope) {
      const vals = facetValues(k, x);
      const hit = matches(x, sel, t, k);
      for (const v of vals) {
        counts.set(v, (counts.get(v) ?? 0) + (hit ? 1 : 0));
        if (!labels.has(v)) labels.set(v, labelOf(k, v, x));
      }
    }
    out[k] = orderValues(k, [...counts.keys()]).map((v) => ({ value: v, label: labels.get(v) ?? v, count: counts.get(v) ?? 0 }));
  }
  return out;
}

function labelOf(k: FacetKey, v: string, x: CatalogItem): string {
  if (k === 'price') return PRICES.find((r) => r.k === v)?.t ?? v;
  if (k === 'dept') return x.dept?.name ?? v;
  if (k === 'g') return x.sec?.name ?? v;
  return v;
}

/* ----------------------------------------------------------------- sort */

const tie = (a: CatalogItem, b: CatalogItem) => a.rank - b.rank;

export function sorter(sort: SortKey, opts: { scores: Map<string, number> | null; deals: boolean }) {
  const pop = (x: CatalogItem) =>
    x.unitsSold + (x.isNew ? 8 : 0) + (x.featured ? 4 : 0) + (opts.deals ? x.discount * 40 : 0);
  switch (sort) {
    case 'pop': return (a: CatalogItem, b: CatalogItem) => b.unitsSold - a.unitsSold || tie(a, b);
    case 'new': return (a: CatalogItem, b: CatalogItem) => b.createdAt.getTime() - a.createdAt.getTime() || tie(a, b);
    case 'asc': return (a: CatalogItem, b: CatalogItem) => a.priced.price - b.priced.price || tie(a, b);
    case 'desc': return (a: CatalogItem, b: CatalogItem) => b.priced.price - a.priced.price || tie(a, b);
    case 'discount': return (a: CatalogItem, b: CatalogItem) => b.bestDiscount - a.bestDiscount || b.unitsSold - a.unitsSold || tie(a, b);
    case 'rating':
      return (a: CatalogItem, b: CatalogItem) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount || tie(a, b);
    default: {
      const s = opts.scores;
      if (s) return (a: CatalogItem, b: CatalogItem) => (s.get(b.parentId) ?? 0) - (s.get(a.parentId) ?? 0) || tie(a, b);
      return (a: CatalogItem, b: CatalogItem) => pop(b) - pop(a) || tie(a, b);
    }
  }
}

/* --------------------------------------------------------------- search */

const STOP = new Set(['a', 'an', 'the', 'and', 'for', 'of', 'with', 'in', 'on', 'to', '&']);
/** US shopper words → catalog words. */
const SYN: Record<string, string> = {
  tee: 'tshirt', tees: 'tshirt', 't-shirt': 'tshirt', trouser: 'pant', trousers: 'pant', jumper: 'sweater',
  pullover: 'sweater', earphone: 'earbud', headset: 'headphone', mens: 'men', ladies: 'women', womens: 'women',
  lady: 'women', guy: 'men', sneaker: 'shoe', trainer: 'shoe', cellphone: 'phone', mobile: 'phone',
  notepad: 'notebook', journal: 'notebook', perfume: 'parfum', cologne: 'parfum', lipstick: 'lip',
  tumbler: 'bottle', flask: 'bottle', kid: 'kids', child: 'kids', children: 'kids', pot: 'cookware',
  jean: 'jeans', denims: 'denim', hoody: 'hoodie',
};
const stem = (w: string) => {
  w = w.toLowerCase().replace(/['’]/g, '');
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
};
export const toks = (t: string) =>
  String(t).toLowerCase().replace(/[^a-z0-9%'’-]+/g, ' ').split(/[\s-]+/).filter((w) => w && !STOP.has(w)).map(stem);
const dtoks = (t: string) => [
  ...toks(t),
  ...(String(t).toLowerCase().match(/[a-z]+-[a-z]+/g) ?? []).map((w) => stem(w.replace('-', ''))),
];

type Query = string | string[];
interface Doc {
  id: string;
  pop: number;
  f: [number, string[]][];
  skus: string[];
}

/** Field weights: a hit in the name beats one in the keywords. */
function docOf(x: CatalogItem): Doc {
  const keywords = uniq(x.variants.map((s) => s.keywords)).join(' ');
  const fields: [number, string][] = [
    [4, x.name],
    [3, x.productType ?? ''],
    [3, x.brand ?? ''],
    [2, x.sec?.name ?? ''],
    [1, x.dept?.name ?? ''],
    [1, x.colors.join(' ')],
    [1, Object.values(x.attrs).flat().join(' ')],
    [1, keywords],
  ];
  return {
    id: x.parentId,
    pop: x.unitsSold,
    f: fields.map(([w, t]) => [w, dtoks(t)]),
    skus: [x.code, ...x.variants.map((s) => s.sku)].map((s) => s.toLowerCase()),
  };
}

const hit = (q: string, w: string) => (q.length >= 3 ? w.startsWith(q) : w === q);
function tokScore1(q: string, d: Doc) {
  let best = 0;
  for (const [wt, ws] of d.f) {
    for (const w of ws) {
      if (w === q) best = Math.max(best, wt * 1.5);
      else if (hit(q, w)) best = Math.max(best, wt);
    }
  }
  return best;
}
function tokScore(q: Query, d: Doc): number {
  if (Array.isArray(q)) return Math.max(...q.map((v) => tokScore(v, d)));
  if (q.length > 3 && q.endsWith('y')) return Math.max(tokScore1(q, d), tokScore1(q.slice(0, -1) + 'ie', d));
  return tokScore1(q, d);
}
function run(docs: Doc[], qt: Query[], mode: 'and' | 'or') {
  const out = new Map<string, number>();
  for (const d of docs) {
    let sc = 0, ok = 0;
    for (const q of qt) {
      const s = tokScore(q, d);
      if (s) {
        ok++;
        sc += s;
      }
    }
    if (mode === 'and' ? ok === qt.length : ok > 0) out.set(d.id, sc + d.pop / 100 + (ok === qt.length ? 5 : 0));
  }
  return out;
}
function lev(a: string, b: string) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  let p = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const c = [i];
    for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[n];
}

export interface SearchResult {
  /** parentId → relevance. */
  scores: Map<string, number>;
  mode: 'exact' | 'corrected' | 'partial' | 'none';
  /** What the results are for: the query, or its spelling correction. */
  shown: string;
}

export interface SearchIndex {
  docs: Doc[];
  vocab: Map<string, string>;
}

export function buildIndex(items: CatalogItem[]): SearchIndex {
  const vocab = new Map<string, string>();
  for (const x of items) {
    [x.name, x.productType, x.brand, x.sec?.name, x.dept?.name, ...x.colors]
      .filter(Boolean)
      .join(' ')
      .split(/[^A-Za-z0-9']+/)
      .forEach((w) => {
        if (w.length > 2) {
          const k = stem(w);
          if (!vocab.has(k)) vocab.set(k, w.toLowerCase());
        }
      });
  }
  return { docs: items.map(docOf), vocab };
}

/**
 * Every word must match (AND) across name, type, brand, section, department,
 * colours, attributes and Search_Keywords; an exact SKU or parent code
 * matches too. No hits → spelling correction (unless `exact`), then
 * any-word matches.
 */
export function search(index: SearchIndex, raw: string, exact = false): SearchResult {
  const query = raw.trim().slice(0, 80);
  const lower = query.toLowerCase();
  const bySku = index.docs.filter((d) => d.skus.includes(lower));
  if (bySku.length) return { scores: new Map(bySku.map((d) => [d.id, 100])), mode: 'exact', shown: query };

  const qt: Query[] = toks(query).map((w) => (SYN[w] ? [w, stem(SYN[w])] : w));
  if (!qt.length) return { scores: new Map(), mode: 'none', shown: query };
  let res = run(index.docs, qt, 'and');
  if (res.size) return { scores: res, mode: 'exact', shown: query };
  if (exact) return { scores: res, mode: 'none', shown: query };

  const keys = Array.from(index.vocab.keys());
  const correct = (q: string) => {
    if (keys.some((v) => hit(q, v))) return q;
    let best: string | null = null, bd = 9;
    for (const v of keys) {
      const d = lev(q, v);
      if (d < bd || (best && d === bd && v.length < best.length)) {
        bd = d;
        best = v;
      }
    }
    return best && bd <= (q.length > 5 ? 2 : 1) ? best : q;
  };
  const fixed = qt.map((q) => (Array.isArray(q) ? q : correct(q)));
  if (JSON.stringify(fixed) !== JSON.stringify(qt)) {
    res = run(index.docs, fixed, 'and');
    if (res.size) {
      const shown = fixed.map((w) => (Array.isArray(w) ? w[0] : index.vocab.get(w) ?? w)).join(' ');
      return { scores: res, mode: 'corrected', shown };
    }
  }
  if (qt.length > 1) {
    res = run(index.docs, fixed, 'or');
    if (res.size) return { scores: res, mode: 'partial', shown: query };
  }
  return { scores: new Map(), mode: 'none', shown: query };
}

/* ----------------------------------------------------------- suggestions */

const norm = (t: string) => t.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9&%]+/g, ' ').trim();
const words = (t: string) => norm(t).split(' ').filter((w) => w && w !== '&');
/** "Stainless Steel Cookware Set, 10-Piece" → "Stainless Steel Cookware Set". */
const cleanName = (n: string) =>
  n.replace(/,.*$/, '').replace(/\s+\d[\d,.]*[- ]?(Piece|Pieces|Pack|oz|lb|ml|in|mm|L)\b.*$/i, '').trim();

interface Entry {
  t: string;
  pop: number;
  /** "deptSlug|type" → products. */
  cats: Record<string, number>;
  noScope?: boolean;
}

export interface SuggestIndex {
  entries: Entry[];
  /** Busiest product types. */
  popularTypes: string[];
  products: { x: CatalogItem; hay: string[]; pop: number }[];
}

/** The header autocomplete's dictionary (DayloraSearch.tsx buildIndex). */
export function buildSuggestIndex(items: CatalogItem[]): SuggestIndex {
  const dict = new Map<string, Entry>();
  const add = (phrase: string | null | undefined, x: CatalogItem, pop: number, boost = 0) => {
    if (!phrase) return null;
    const k = norm(phrase);
    if (k.length < 2) return null;
    const e = dict.get(k) ?? { t: phrase.toLowerCase(), pop: 0, cats: {} };
    e.pop += pop + boost;
    if (x.productType) {
      const c = `${x.dept?.slug ?? ''}|${x.productType}`;
      e.cats[c] = (e.cats[c] ?? 0) + 1;
    }
    dict.set(k, e);
    return e;
  };
  const typePop = new Map<string, number>();
  const products = items.map((x) => {
    const pop = Math.min(100, 10 + Math.sqrt(x.unitsSold) * 10);
    const name = cleanName(x.name);
    add(name, x, pop, 10);
    add(x.productType, x, pop, 20);
    add(x.brand, x, pop);
    for (const c of x.colors) {
      const e = add(c, x, 2);
      if (e) e.noScope = true;
    }
    const w = name.toLowerCase().replace(/[^a-z0-9'’ -]+/g, ' ').split(/\s+/).filter(Boolean);
    if (w.length > 2) add(w.slice(-2).join(' '), x, pop, 15);
    if (w.length > 1) add(w[w.length - 1], x, pop, 5);
    const sub = x.sec?.name ?? null;
    if (x.dept?.slug === 'clothing' && sub && /^(men|women)$/i.test(sub) && w.length) {
      const last = w[w.length - 1];
      add(`${sub.toLowerCase()}'s ${last}${/s$/.test(last) ? '' : 's'}`, x, pop, 8);
    }
    if (x.productType) typePop.set(x.productType, (typePop.get(x.productType) ?? 0) + pop);
    const hay = words([x.name, x.brand, x.productType, sub, ...x.colors].filter(Boolean).join(' '));
    return { x, hay, pop };
  });
  const popularTypes = Array.from(typePop.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);
  for (const q of popularTypes) {
    const e = dict.get(norm(q));
    if (e) e.pop += 400;
  }
  return { entries: Array.from(dict.values()), popularTypes, products };
}

/** Up to 7 query completions, plus the top one scoped to its main product type. */
export function querySuggestions(index: SuggestIndex, q: string) {
  const qw = words(q);
  if (!qw.length) return { suggestions: [] as string[], scoped: null };
  const last = qw[qw.length - 1];
  const full = qw.slice(0, -1);
  const scored: { e: Entry; score: number }[] = [];
  for (const e of index.entries) {
    const ew = words(e.t);
    const okFull = full.every((f) => ew.some((w) => w === f || w === f + 's' || w + 's' === f));
    const okLast = ew.some((w) => w.startsWith(last));
    if (!okFull || !okLast) continue;
    const starts = norm(e.t).startsWith(norm(q));
    scored.push({ e, score: e.pop + (starts ? 1000 : 0) - ew.length * 5 });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const { e } of scored) {
    const k = norm(e.t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length === 7) break;
  }
  let scoped: { query: string; type: string; label: string; dept: string | null } | null = null;
  const top = out[0];
  if (top && !top.noScope) {
    const cat = Object.entries(top.cats).sort((a, b) => b[1] - a[1])[0];
    if (cat) {
      const [dept, type] = cat[0].split('|');
      if (type && norm(type) !== norm(top.t)) scoped = { query: top.t, type, label: `in ${type}`, dept: dept || null };
    }
  }
  return { suggestions: out.map((e) => e.t), scoped };
}

/** Up to 3 products whose words start with what was typed. */
export function productMatches(index: SuggestIndex, q: string): CatalogItem[] {
  const qw = words(q);
  if (!qw.length) return [];
  return index.products
    .filter(({ hay }) =>
      qw.every((w, i) => hay.some((h) => (i === qw.length - 1 ? h.startsWith(w) : h === w || h === w + 's' || h + 's' === w))),
    )
    .sort((a, b) => b.pop - a.pop)
    .slice(0, 3)
    .map((p) => p.x);
}
