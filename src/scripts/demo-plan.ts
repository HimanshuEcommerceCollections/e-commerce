import { Prisma, type ProductCategory } from '@prisma/client';
import { colorCode, sizeCode } from '../product/importer/sku-codes';
import { DEMO_PRODUCTS, type DemoProduct } from './demo-catalog';

/**
 * The demo catalog as parent products and variant SKUs, with the codes, slugs,
 * prices and copy both the demo seed (seed-demo.ts) and the demo import file
 * (demo-catalog-csv.ts) use, so either one upserts the other's SKUs.
 */

const DAY = 86_400_000;

/** Sales tax by department (percent); groceries and books untaxed in this demo. */
const TAX_RATE: Record<string, string> = {
  Clothing: '6.00',
  Electronics: '8.00',
  'Home & Kitchen': '7.25',
  Grocery: '0.00',
  'Beauty & Personal Care': '7.25',
  'Books & Stationery': '0.00',
  'Toys & Kids': '6.50',
  'Sports & Fitness': '6.50',
  Lifestyle: '7.00',
};

/** Design attribute keys → attribute sheet names. */
const ATTRIBUTE_NAMES: Record<string, string> = {
  fit: 'Fit',
  material: 'Material',
  conn: 'Connectivity',
  diet: 'Dietary',
  skin: 'Skin & hair type',
  format: 'Format',
  age: 'Age',
  activity: 'Activity',
  occasion: 'Occasion',
};

const FEATURED_COUNT = 12;

export interface DemoVariantPlan {
  sku: string;
  urlSlug: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
  stock: number;
  price: Prisma.Decimal;
  mrp: Prisma.Decimal | null;
  cost: Prisma.Decimal;
  taxCode: string;
  taxRate: Prisma.Decimal;
  material: string | null;
  seoTitle: string;
  metaDescription: string;
  searchKeywords: string;
  specifications: string | null;
  shippingClass: string;
  supplierId: string;
  warehouseId: string;
}

export interface DemoParentPlan {
  code: string;
  department: ProductCategory;
  section: ProductCategory;
  name: string;
  brand: string;
  shortDescription: string;
  description: string;
  productType: string;
  keyFeatures: string;
  warranty: string | null;
  usageInstructions: string | null;
  attributes: Record<string, string>;
  featured: boolean;
  createdAt: Date;
  /** Image file names in the web client's public/daylora folder, without extension. */
  images: string[];
  variants: DemoVariantPlan[];
}

export const slugify = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A photo from the design for products that have none of their own. */
function fallbackImage(x: DemoProduct): string {
  const byType: Record<string, string> = {
    'Jackets & coats': 'denim-jacket',
    Jeans: 'pdp-denim-3',
    Bottoms: 'pdp-denim-3',
    Activewear: 'sneakers',
    'Headphones & earbuds': 'headphones',
    Speakers: 'smart-hub',
    'Smart home': 'smart-hub',
    Wearables: 'earbuds',
    'Phone cases & chargers': 'usb-hub',
    'Keyboards & mice': 'keyboard',
    'Cables & hubs': 'usb-hub',
    'Laptop accessories': 'laptop-stand',
    Cookware: 'cookware',
    'Small appliances': 'blender',
    'Coffee & tea makers': 'coffee-maker',
    'Kitchen tools': 'room-kitchen',
    Lighting: 'lamp',
    'Bedding & bath': 'room-bedroom',
    'Yoga & pilates': 'yoga-mat',
    'Gift sets': 'promo-new',
    Seasonal: 'promo-new',
    'Party supplies': 'promo-new',
    'Bags & travel': 'room-outdoor',
  };
  const byDept: Record<string, string> = {
    Clothing: 'promo-deals',
    Electronics: 'laptop',
    'Home & Kitchen': 'room-living',
    Grocery: 'room-kitchen',
    'Beauty & Personal Care': 'skincare',
    'Books & Stationery': 'room-workspace',
    'Toys & Kids': 'room-kids',
    'Sports & Fitness': x.g === 'Outdoors' ? 'room-outdoor' : 'yoga-mat',
    Lifestyle: 'room-living',
  };
  return byType[x.type] ?? byDept[x.dept] ?? 'hero';
}

function imagesOf(x: DemoProduct): string[] {
  if (x.img === 'pdp-denim-1') return [1, 2, 3, 4].map((i) => `pdp-denim-${i}`);
  return [x.img ?? fallbackImage(x)];
}

/** Image URLs under `base` (the web client's /daylora folder). */
export const imageUrls = (base: string, names: string[]) =>
  names.map((n) => `${base.replace(/\/+$/, '')}/${n}.jpg`);

function attributesOf(x: DemoProduct): Record<string, string> {
  const out: Record<string, string> = {};
  if (x.dept === 'Clothing') out.Gender = x.g;
  for (const [key, value] of Object.entries(x.a)) {
    const v = Array.isArray(value) ? value.join(', ') : value;
    if (v) out[ATTRIBUTE_NAMES[key] ?? key] = v;
  }
  return out;
}

/** Spread the product's stock over its variants; the remainder goes to the first ones. */
function spread(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => base + (i < total % n ? 1 : 0));
}

function descriptions(x: DemoProduct, attrs: Record<string, string>) {
  const detail = Object.entries(attrs)
    .filter(([k]) => k !== 'Gender')
    .map(([k, v]) => `${k.toLowerCase()}: ${v}`)
    .join('; ');
  const short = `${x.name} by ${x.brand}${detail ? ` — ${detail}` : ''}.`;
  const long =
    `${x.name} from ${x.brand}, part of our ${x.type.toLowerCase()} range. ` +
    (x.colors.length > 1 ? `Available in ${x.colors.join(', ')}. ` : '') +
    'Ships from our Portland warehouse; free standard shipping on orders of $35 or more and 30-day returns.';
  const features = [
    ...Object.entries(attrs).filter(([k]) => k !== 'Gender').map(([k, v]) => `${k}: ${v}`),
    x.sizes.length ? `Sizes ${x.sizes[0]}–${x.sizes[x.sizes.length - 1]}` : null,
    '30-day returns',
  ].filter(Boolean);
  return { short, long, features: features.join('\n') };
}

/** Plans the demo catalog against the taxonomy the migrations create. */
export function planDemoCatalog(categories: ProductCategory[], now = Date.now()): DemoParentPlan[] {
  const dept = (name: string) => {
    const c = categories.find((x) => !x.parentId && x.name === name);
    if (!c) throw new Error(`Department '${name}' not found — run the migrations first`);
    return c;
  };
  const section = (d: ProductCategory, name: string) => {
    const c = categories.find((x) => x.parentId === d.id && x.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`Section '${name}' of '${d.name}' not found — run the migrations first`);
    return c;
  };

  const featured = new Set(
    [...DEMO_PRODUCTS].filter((x) => x.stock > 0).sort((a, b) => b.pop - a.pop).slice(0, FEATURED_COUNT),
  );
  const seenSlugs = new Set<string>();
  const sequence = new Map<string, number>();

  return DEMO_PRODUCTS.map((x, index) => {
    const d = dept(x.dept);
    const s = section(d, x.g);
    const seq = (sequence.get(s.id) ?? 0) + 1;
    sequence.set(s.id, seq);
    const code = `GS-${d.code}-${s.code}-${String(seq).padStart(3, '0')}`;

    let slug = slugify(x.name);
    if (seenSlugs.has(slug)) slug = slugify(`${x.brand} ${x.name}`);
    seenSlugs.add(slug);

    const attrs = attributesOf(x);
    const text = descriptions(x, attrs);

    // Clothing with no sizes listed (sold out in the design) still gets the full run, at zero stock.
    const sizes = x.dept === 'Clothing' && x.sizes.length === 0 ? ['XS', 'S', 'M', 'L', 'XL', 'XXL'] : x.sizes;
    const colors: (string | null)[] = x.colors.length ? x.colors : [null];
    const combos = colors.flatMap((color) => (sizes.length ? sizes : [null]).map((size) => ({ color, size })));
    const stock = spread(x.stock, combos.length);
    const defaultIndex = Math.max(0, stock.findIndex((q) => q > 0));
    const price = new Prisma.Decimal(x.price.toFixed(2));

    const variants = combos.map(({ color, size }, i): DemoVariantPlan => {
      const suffix = [color && colorCode(color), size && sizeCode(size)].filter(Boolean).join('-');
      return {
        sku: suffix ? `${code}-${suffix}` : code,
        urlSlug: i === defaultIndex ? slug : `${slug}-${suffix.toLowerCase()}`,
        variantName: [color, size].filter(Boolean).join(' / ') || null,
        color,
        size,
        stock: stock[i],
        price,
        mrp: x.was === null ? null : new Prisma.Decimal(x.was.toFixed(2)),
        cost: price.mul('0.55').toDecimalPlaces(2),
        taxCode: `${d.code}-STD`,
        taxRate: new Prisma.Decimal(TAX_RATE[x.dept] ?? '0.00'),
        material: attrs.Material ?? null,
        seoTitle: `${x.name} | ${x.brand}`,
        metaDescription: text.short.slice(0, 500),
        searchKeywords: [x.brand, x.type, x.g, ...x.colors, x.dept].join(', '),
        specifications: Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join('\n') || null,
        shippingClass: 'STANDARD',
        supplierId: `SUP-${slugify(x.brand).toUpperCase().slice(0, 12)}`,
        warehouseId: 'WH-PDX-01',
      };
    });

    return {
      code,
      department: d,
      section: s,
      name: x.name,
      brand: x.brand,
      shortDescription: text.short,
      description: text.long,
      productType: x.type,
      keyFeatures: text.features,
      warranty: x.dept === 'Electronics' ? '1-year limited manufacturer warranty' : null,
      usageInstructions: x.dept === 'Clothing' ? 'Machine wash cold with like colors; tumble dry low.' : null,
      attributes: attrs,
      featured: featured.has(x),
      createdAt: new Date(x.isNew ? now - ((index % 12) + 1) * DAY : now - (45 + (index % 90)) * DAY),
      images: imagesOf(x),
      variants,
    };
  });
}
