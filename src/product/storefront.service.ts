import { Prisma, type PrismaClient } from '@prisma/client';
import { money } from '../common/api-response';
import { ProductNotFoundError } from '../common/errors';
import { ValidationError } from '../common/validation';
import { attributesOf } from './product.mapper';
import {
  buildIndex,
  buildSuggestIndex,
  derive,
  FACET_KEYS,
  facetCounts,
  matches,
  productMatches,
  querySuggestions,
  search,
  SORTS,
  sorter,
  type CatalogItem,
  type CatalogVariant,
  type Selection,
  type SortKey,
  type Toggles,
} from './storefront-search';

/**
 * Storefront catalog reads (contract A1–A4): the listing/search page with
 * facets, related products, cart recommendations and header suggestions.
 *
 * One grouped query loads every live parent with its ACTIVE variants and
 * units sold (a single aggregate over paid order lines, no per-product
 * queries); filtering, facet counts, search and sorting then run in memory
 * over those parents, as the web client used to after downloading the whole
 * catalog. At ~1,000 SKUs that is a few milliseconds.
 */

/** Order states whose lines count as sold (as ProductService.unitsSold). */
const SOLD_STATUSES = ['PAID', 'CONFIRMED', 'SHIPPED', 'DELIVERED'];

interface ParentRow {
  id: string;
  code: string;
  name: string;
  brand: string | null;
  product_type: string | null;
  attributes: Prisma.JsonValue;
  featured: boolean;
  rating_avg: string;
  rating_count: number;
  created_at: Date;
  a_slug: string | null;
  a_name: string | null;
  a_has_parent: boolean | null;
  ap_slug: string | null;
  ap_name: string | null;
  s_slug: string | null;
  s_name: string | null;
  variants: {
    id: string;
    sku: string;
    price: string;
    mrp: string | null;
    stock: number;
    color: string | null;
    size: string | null;
    material: string | null;
    keywords: string | null;
    slug: string | null;
    threshold: number | null;
    created_at: string;
    image: string | null;
    sold: number;
  }[];
}

/** GET /api/products/search query, parsed. */
export interface SearchQuery {
  q: string;
  sel: Selection;
  toggles: Toggles;
  isNew: boolean;
  featured: boolean;
  exclude: string[];
  sort: SortKey;
  page: number;
  size: number;
  exact: boolean;
}

const all = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v])
    .filter((x): x is string => typeof x === 'string')
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50);
const one = (v: unknown) => all(v)[0];

/** Query string → SearchQuery; bad numbers or sorts are a 400 on that field. */
export function parseSearchQuery(query: Record<string, unknown>): SearchQuery {
  const num = (name: string) => {
    const v = one(query[name]);
    if (v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError({ [name]: 'must be a non-negative number' });
    return n;
  };
  const q = (one(query.q) ?? '').slice(0, 80);
  const sortParam = one(query.sort);
  if (sortParam !== undefined && !(SORTS as readonly string[]).includes(sortParam)) {
    throw new ValidationError({ sort: `must be one of ${SORTS.join(', ')}` });
  }
  const sel: Selection = {};
  for (const k of FACET_KEYS) {
    const vals = all(query[k]);
    if (vals.length) sel[k] = new Set(k === 'dept' || k === 'g' ? vals.map((v) => v.toLowerCase()) : vals);
  }
  const page = num('page') ?? 0;
  // `size` is the size facet, so the page size is `pageSize` (contract A1 deviation).
  const size = num('pageSize') ?? 24;
  if (!Number.isInteger(page)) throw new ValidationError({ page: 'must be an integer' });
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new ValidationError({ pageSize: 'must be between 1 and 100' });
  const flagOn = (name: string) => ['1', 'true'].includes(one(query[name]) ?? '');
  return {
    q,
    sel,
    toggles: { inStock: flagOn('inStock'), onSale: flagOn('onSale'), priceMin: num('priceMin'), priceMax: num('priceMax') },
    isNew: flagOn('new'),
    featured: flagOn('featured'),
    exclude: all(query.exclude).map((v) => v.toLowerCase()),
    sort: (sortParam as SortKey | undefined) ?? (q ? 'rel' : 'new'),
    page,
    size,
    exact: flagOn('exact'),
  };
}

export class StorefrontService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly lowStockThreshold: number,
  ) {}

  /** A1: one page of parent products with facets and the search outcome. */
  async search(query: SearchQuery) {
    const items = await this.loadCatalog();
    const result = query.q ? search(buildIndex(items), query.q, query.exact) : null;
    const excluded = new Set(query.exclude);
    const scope = items.filter(
      (x) =>
        (!result || result.scores.has(x.parentId)) &&
        (!query.isNew || x.isNew) &&
        (!query.featured || x.featured) &&
        !excluded.has(x.parentId) &&
        !x.variants.some((v) => excluded.has(v.id)),
    );
    const list = scope
      .filter((x) => matches(x, query.sel, query.toggles))
      .sort(sorter(query.sort, { scores: result?.scores ?? null, deals: query.toggles.onSale }));
    const start = query.page * query.size;
    return {
      items: list.slice(start, start + query.size).map((x) => this.card(x)),
      total: list.length,
      page: query.page,
      size: query.size,
      facets: facetCounts(scope, query.sel, query.toggles),
      search: result
        ? { mode: result.mode, query: query.q, shown: result.mode === 'none' ? null : result.shown }
        : null,
    };
  }

  /**
   * A2: products like this one (parent or SKU id): same section and type
   * first, then same section or type, then the department, then the
   * best sellers; in stock, never itself.
   */
  async related(id: string, limit: number) {
    const items = await this.loadCatalog();
    const key = id.toLowerCase();
    const self = items.find((x) => x.parentId === key || x.variants.some((v) => v.id === key));
    if (!self) throw new ProductNotFoundError(id);
    const tier = (x: CatalogItem) => {
      const sameSec = !!self.sec && x.sec?.slug === self.sec.slug;
      const sameType = !!self.productType && x.productType === self.productType;
      if (sameSec && sameType) return 0;
      if (sameSec || sameType) return 1;
      if (self.dept && x.dept?.slug === self.dept.slug) return 2;
      return 3;
    };
    return items
      .filter((x) => x !== self && x.stock > 0)
      .map((x) => ({ x, t: tier(x) }))
      .sort((a, b) => a.t - b.t || b.x.unitsSold - a.x.unitsSold || a.x.rank - b.x.rank)
      .slice(0, limit)
      .map(({ x }) => this.card(x));
  }

  /**
   * A3: for the cart — the best seller of each department the excluded items
   * (what's in the cart) come from, then the best sellers overall. In stock
   * only; never one of the excluded products.
   */
  async recommendations(exclude: string[], limit: number) {
    const items = await this.loadCatalog();
    const ids = new Set(exclude.map((e) => e.toLowerCase()));
    const inCart = items.filter((x) => ids.has(x.parentId) || x.variants.some((v) => ids.has(v.id)));
    const taken = new Set(inCart.map((x) => x.parentId));
    const byPopularity = items
      .filter((x) => x.stock > 0 && !taken.has(x.parentId))
      .sort((a, b) => b.unitsSold - a.unitsSold || a.rank - b.rank);
    const out: CatalogItem[] = [];
    const depts = [...new Set(inCart.map((x) => x.dept?.slug).filter((d): d is string => !!d))];
    for (const dept of depts) {
      const best = byPopularity.find((x) => x.dept?.slug === dept && !out.includes(x));
      if (best) out.push(best);
      if (out.length >= limit) break;
    }
    for (const x of byPopularity) {
      if (out.length >= limit) break;
      if (!out.includes(x)) out.push(x);
    }
    return out.slice(0, limit).map((x) => this.card(x));
  }

  /** A4: header autocomplete; `popular` comes back for an empty box too. */
  async suggest(rawQ: string) {
    const q = rawQ.trim().slice(0, 80);
    const items = await this.loadCatalog();
    const index = buildSuggestIndex(items);
    const { suggestions, scoped } = querySuggestions(index, q);
    return {
      suggestions,
      scoped,
      products: productMatches(index, q).map((x) => this.card(x)),
      popular: await this.popularSearches(index.popularTypes),
    };
  }

  /** Top SEARCH terms of the last 30 days (that found something), topped up with the busiest product types. */
  private async popularSearches(fallback: string[]): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ term: string }[]>`
      SELECT lower(trim(properties->>'query')) AS term
      FROM analytics_events
      WHERE event_type = 'SEARCH'
        AND created_at > now() - interval '30 days'
        AND length(trim(coalesce(properties->>'query', ''))) >= 2
        AND coalesce(properties->>'results', '1') <> '0'
      GROUP BY 1
      ORDER BY count(*) DESC, 1
      LIMIT 8`;
    const out = rows.map((r) => r.term);
    for (const t of fallback) {
      if (out.length >= 8) break;
      if (!out.includes(t.toLowerCase())) out.push(t);
    }
    return out.slice(0, 8);
  }

  /** ProductCard (contract A1). */
  private card(x: CatalogItem) {
    const p = x.priced;
    const mrp = p.mrp !== null && p.mrp > p.price ? p.mrpText : null;
    const prices = x.prices;
    const colorImages = new Map<string, string | null>();
    for (const v of x.variants) {
      if (v.color && (!colorImages.has(v.color) || (!colorImages.get(v.color) && v.imageUrl))) colorImages.set(v.color, v.imageUrl);
    }
    const threshold = x.lead.lowStockThreshold ?? this.lowStockThreshold;
    const dec = (n: number) => money(new Prisma.Decimal(n));
    return {
      parentId: x.parentId,
      slug: x.lead.slug ?? x.lead.id,
      productId: x.lead.id,
      name: x.name,
      brand: x.brand,
      productType: x.productType,
      department: x.dept,
      section: x.sec,
      imageUrl: p.imageUrl ?? x.lead.imageUrl ?? x.variants.find((v) => v.imageUrl)?.imageUrl ?? null,
      minPrice: money(new Prisma.Decimal(p.priceText)),
      maxPrice: dec(Math.max(...prices)),
      mrp: mrp === null ? null : money(new Prisma.Decimal(mrp)),
      discountPercent: mrp === null ? null : Math.round(x.discount * 100),
      colors: x.colors.map((name) => ({ name, hex: null, imageUrl: colorImages.get(name) ?? null })),
      sizes: x.sizes,
      stock: x.stock,
      lowStock: x.stock > 0 && x.stock <= threshold,
      isNew: x.isNew,
      featured: x.featured,
      unitsSold: x.unitsSold,
      ratingAvg: Math.round(x.ratingAvg * 10) / 10,
      ratingCount: x.ratingCount,
      variantCount: x.variants.length,
      createdAt: x.createdAt,
    };
  }

  /**
   * Every live parent with at least one ACTIVE variant: variants newest first
   * (the lead SKU is the first in stock), parents by their newest SKU. The
   * department/section follow taxonomyOf() in product.mapper.ts.
   */
  async loadCatalog(): Promise<CatalogItem[]> {
    const rows = await this.prisma.$queryRaw<ParentRow[]>`
      WITH sold AS (
        SELECT oi.product_id, SUM(oi.quantity - oi.returned_quantity)::int AS units
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.deleted = false AND o.deleted = false AND o.status = ANY(${SOLD_STATUSES})
        GROUP BY oi.product_id
      ),
      v AS (
        SELECT p.parent_id,
               max(p.created_at) AS newest,
               (array_agg(p.category_id) FILTER (WHERE p.category_id IS NOT NULL))[1] AS sku_category,
               json_agg(json_build_object(
                 'id', p.id, 'sku', p.sku, 'price', p.price::text, 'mrp', p.mrp::text,
                 'stock', p.stock_quantity, 'color', p.color, 'size', p.size, 'material', p.material,
                 'keywords', p.search_keywords, 'slug', p.url_slug, 'threshold', p.low_stock_threshold,
                 'created_at', p.created_at,
                 'image', (SELECT i.url FROM product_images i
                            WHERE i.product_id = p.id AND i.deleted = false
                            ORDER BY i.is_primary DESC, i.position ASC LIMIT 1),
                 'sold', COALESCE(s.units, 0)
               ) ORDER BY p.created_at DESC, p.id) AS variants
        FROM products p
        LEFT JOIN sold s ON s.product_id = p.id
        WHERE p.deleted = false AND p.status = 'ACTIVE'
        GROUP BY p.parent_id
      )
      SELECT pp.id::text AS id, pp.code, pp.name, pp.brand, pp.product_type, pp.attributes, pp.featured,
             pp.rating_avg::text AS rating_avg, pp.rating_count, pp.created_at,
             a.slug AS a_slug, a.name AS a_name, (a.parent_id IS NOT NULL) AS a_has_parent,
             ap.slug AS ap_slug, ap.name AS ap_name,
             sc.slug AS s_slug, sc.name AS s_name,
             v.variants
      FROM v
      JOIN parent_products pp ON pp.id = v.parent_id AND pp.deleted = false
      LEFT JOIN product_categories a ON a.id = COALESCE(pp.category_id, v.sku_category)
      LEFT JOIN product_categories ap ON ap.id = a.parent_id
      LEFT JOIN product_categories sc ON sc.id = pp.subcategory_id
      ORDER BY v.newest DESC, pp.id`;

    const now = Date.now();
    return rows.map((r, rank) => {
      const named = (slug: string | null, name: string | null) => (slug && name ? { slug, name } : null);
      // A section assigned as the category resolves to its department.
      const assigned = named(r.a_slug, r.a_name);
      const dept = r.a_has_parent ? named(r.ap_slug, r.ap_name) : assigned;
      const sec = named(r.s_slug, r.s_name) ?? (r.a_has_parent ? assigned : null);
      const variants: CatalogVariant[] = r.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        price: Number(v.price),
        priceText: v.price,
        mrp: v.mrp === null ? null : Number(v.mrp),
        mrpText: v.mrp,
        stock: v.stock,
        color: v.color,
        size: v.size,
        material: v.material,
        keywords: v.keywords,
        slug: v.slug,
        lowStockThreshold: v.threshold,
        createdAt: new Date(v.created_at),
        imageUrl: v.image,
        unitsSold: Number(v.sold),
      }));
      return derive(
        {
          parentId: r.id,
          code: r.code,
          name: r.name,
          brand: r.brand,
          productType: r.product_type,
          attributes: attributesOf(r.attributes),
          featured: r.featured,
          ratingAvg: Number(r.rating_avg),
          ratingCount: r.rating_count,
          createdAt: r.created_at,
          dept,
          sec,
          variants,
          rank,
        },
        now,
      );
    });
  }
}

