import 'dotenv/config';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient, type ProductCategory } from '@prisma/client';
import { loadConfig } from '../config';
import { addBusinessDays, lineAmounts, orderTotals, pricingRules } from '../order/pricing';
import { colorCode, sizeCode } from '../product/importer/sku-codes';
import { DEMO_PRODUCTS, type DemoProduct } from './demo-catalog';

/**
 * Demo data for local development and design review: staff and customer
 * accounts, the design's sample catalog (≈130 products in all 9 departments)
 * and a few orders for the demo customer in different states, so the
 * storefront, account, tracking and admin pages all have something to show.
 *
 * Idempotent: users, products and SKUs are upserted by email / code / SKU;
 * demo orders are created once (by their fixed order numbers). Never run it
 * against production — it resets the demo SKUs' prices and stock.
 *
 *   npm run seed:demo
 */

const IMAGE_BASE = 'http://localhost:3000/daylora';
const DAY = 86_400_000;

const ACCOUNTS = {
  admin: { email: 'admin@example.com', password: 'Admin12345', fullName: 'Store Admin', role: 'ROLE_ADMIN' },
  catalog: { email: 'catalog@example.com', password: 'Catalog12345', fullName: 'Catalog Team', role: 'ROLE_CATALOG' },
  customer: {
    email: 'jordan.m@example.com',
    password: 'Customer123',
    fullName: 'Jordan Miller',
    role: 'ROLE_CUSTOMER',
    phoneNumber: '+15035550142',
  },
} as const;

const JORDAN_ADDRESS = {
  label: 'Home',
  recipientName: 'Jordan Miller',
  phone: '+1 503 555 0142',
  addressLine1: '1420 NW Lovejoy St',
  addressLine2: 'Apt 5B',
  city: 'Portland',
  state: 'OR',
  postalCode: '97209',
  country: 'US',
};

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

const slugify = (t: string) =>
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

function galleryOf(x: DemoProduct): string[] {
  if (x.img === 'pdp-denim-1') return [1, 2, 3, 4].map((i) => `${IMAGE_BASE}/pdp-denim-${i}.jpg`);
  return [`${IMAGE_BASE}/${x.img ?? fallbackImage(x)}.jpg`];
}

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

async function upsertUser(prisma: PrismaClient, a: { email: string; password: string; fullName: string; role: string; phoneNumber?: string }) {
  const password = await bcrypt.hash(a.password, 10);
  return prisma.user.upsert({
    where: { email: a.email },
    update: { password, fullName: a.fullName, role: a.role, enabled: true, accountNonLocked: true, deleted: false },
    create: { email: a.email, password, fullName: a.fullName, role: a.role, phoneNumber: a.phoneNumber ?? null },
  });
}

async function seedCatalog(prisma: PrismaClient, merchantId: string) {
  const categories = await prisma.productCategory.findMany({ where: { deleted: false } });
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
  const now = Date.now();
  let skus = 0;

  for (const [index, x] of DEMO_PRODUCTS.entries()) {
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
    const createdAt = new Date(x.isNew ? now - ((index % 12) + 1) * DAY : now - (45 + (index % 90)) * DAY);
    const parentData = {
      name: x.name,
      brand: x.brand,
      shortDescription: text.short,
      description: text.long,
      categoryId: d.id,
      subcategoryId: s.id,
      productType: x.type,
      keyFeatures: text.features,
      warranty: x.dept === 'Electronics' ? '1-year limited manufacturer warranty' : null,
      usageInstructions: x.dept === 'Clothing' ? 'Machine wash cold with like colors; tumble dry low.' : null,
      attributes: attrs,
      featured: featured.has(x),
      merchantId,
      deleted: false,
      createdAt,
    };
    const parent = await prisma.parentProduct.upsert({
      where: { code },
      update: parentData,
      create: { code, ...parentData },
    });

    // Clothing with no sizes listed (sold out in the design) still gets the full run, at zero stock.
    const sizes = x.dept === 'Clothing' && x.sizes.length === 0 ? ['XS', 'S', 'M', 'L', 'XL', 'XXL'] : x.sizes;
    const colors: (string | null)[] = x.colors.length ? x.colors : [null];
    const combos = colors.flatMap((color) => (sizes.length ? sizes : [null]).map((size) => ({ color, size })));
    const stock = spread(x.stock, combos.length);
    const defaultIndex = Math.max(0, stock.findIndex((q) => q > 0));
    const gallery = galleryOf(x);

    for (const [i, { color, size }] of combos.entries()) {
      const suffix = [color && colorCode(color), size && sizeCode(size)].filter(Boolean).join('-');
      const sku = suffix ? `${code}-${suffix}` : code;
      const urlSlug = i === defaultIndex ? slug : `${slug}-${suffix.toLowerCase()}`;
      const variantName = [color, size].filter(Boolean).join(' / ') || null;
      const price = new Prisma.Decimal(x.price.toFixed(2));
      const data = {
        name: x.name,
        description: text.long,
        price,
        mrp: x.was === null ? null : new Prisma.Decimal(x.was.toFixed(2)),
        cost: price.mul('0.55').toDecimalPlaces(2),
        taxCode: `${d.code}-STD`,
        taxRate: new Prisma.Decimal(TAX_RATE[x.dept] ?? '0.00'),
        stockQuantity: stock[i],
        status: 'ACTIVE',
        categoryId: d.id,
        parentId: parent.id,
        merchantId,
        variantName,
        color,
        size,
        material: attrs.Material ?? null,
        urlSlug,
        seoTitle: `${x.name} | ${x.brand}`,
        metaDescription: text.short.slice(0, 500),
        searchKeywords: [x.brand, x.type, x.g, ...x.colors, x.dept].join(', '),
        specifications: Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join('\n') || null,
        shippingClass: 'STANDARD',
        supplierId: `SUP-${slugify(x.brand).toUpperCase().slice(0, 12)}`,
        warehouseId: 'WH-PDX-01',
        deleted: false,
        createdAt,
      };
      const product = await prisma.product.upsert({
        where: { sku },
        update: data,
        create: { sku, version: 0n, ...data },
      });
      // Replace the gallery (uniq_product_images_primary allows one primary).
      await prisma.productImage.deleteMany({ where: { productId: product.id } });
      await prisma.productImage.createMany({
        data: gallery.map((url, position) => ({
          productId: product.id,
          url,
          altText: `${x.name}${variantName ? ` — ${variantName}` : ''}`,
          position,
          isPrimary: position === 0,
          checkStatus: 'OK',
          checkedAt: new Date(),
        })),
      });
      skus++;
    }
  }
  return { parents: DEMO_PRODUCTS.length, skus };
}

// ── Orders ────────────────────────────────────────────────────────────────

interface DemoOrder {
  orderNumber: string;
  placedDaysAgo: number;
  method: 'STANDARD' | 'EXPRESS';
  state: 'PAID' | 'SHIPPED' | 'DELIVERED' | 'REFUNDED';
  /** [product name, colour, size, quantity] */
  picks: [string, string | null, string | null, number][];
}

async function seedOrders(prisma: PrismaClient, customerId: string) {
  const config = loadConfig({ JWT_SECRET: 'x'.repeat(32), ...process.env });
  const rules = pricingRules(config);
  const findSku = async (prefixName: string, color: string | null, size: string | null) => {
    const p = await prisma.product.findFirst({
      where: { name: prefixName, color, size, deleted: false },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    if (!p) throw new Error(`Demo SKU not found: ${prefixName} ${color ?? ''} ${size ?? ''}`);
    return p;
  };

  const plans: DemoOrder[] = [
    {
      orderNumber: 'EC-4821907',
      placedDaysAgo: 1,
      method: 'STANDARD',
      state: 'PAID',
      picks: [
        ['Wireless Earbuds Pro', 'White', null, 1],
        ['Classic Crew Tee', 'Black', 'M', 2],
      ],
    },
    {
      orderNumber: 'EC-4821655',
      placedDaysAgo: 4,
      method: 'STANDARD',
      state: 'SHIPPED',
      picks: [['Vintage Denim Jacket', 'Mid Wash', 'M', 1]],
    },
    {
      orderNumber: 'EC-4820932',
      placedDaysAgo: 9,
      method: 'EXPRESS',
      state: 'DELIVERED',
      picks: [
        ['Premium Yoga Mat, 6 mm', 'Sage', null, 1],
        ['Insulated Water Bottle, 24 oz', 'Teal', null, 2],
      ],
    },
    {
      orderNumber: 'EC-4819410',
      placedDaysAgo: 46,
      method: 'STANDARD',
      state: 'REFUNDED',
      picks: [['Portable Bluetooth Speaker', 'Black', null, 1]],
    },
  ];

  let created = 0;
  for (const plan of plans) {
    if (await prisma.order.findUnique({ where: { orderNumber: plan.orderNumber } })) continue;

    const items = [];
    for (const [name, color, size, quantity] of plan.picks) {
      const p = await findSku(name, color, size);
      const amounts = lineAmounts(p.price, quantity, p.taxRate, rules);
      items.push({ p, quantity, amounts });
    }
    const totals = orderTotals(items.map((i) => i.amounts), plan.method, rules);
    const createdAt = new Date(Date.now() - plan.placedDaysAgo * DAY);
    const paidAt = new Date(createdAt.getTime() + 2 * 60_000);
    const rate = plan.method === 'EXPRESS' ? config.shipping.express : config.shipping.standard;
    const shippedAt = plan.state === 'PAID' ? null : new Date(addBusinessDays(paidAt, 1).getTime() + 15 * 3_600_000);
    const deliveredAt =
      plan.state === 'DELIVERED' || plan.state === 'REFUNDED'
        ? new Date(addBusinessDays(paidAt, rate.maxDays).getTime() + 14 * 3_600_000)
        : null;
    const refunded = plan.state === 'REFUNDED';
    const reference = `MANUAL-${createHash('sha256').update(plan.orderNumber).digest('hex').slice(0, 16).toUpperCase()}`;

    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: plan.orderNumber,
        status: plan.state,
        fulfilmentStatus: plan.state === 'PAID' ? 'UNFULFILLED' : plan.state === 'SHIPPED' ? 'SHIPPED' : 'DELIVERED',
        shippingMethod: plan.method,
        currency: config.order.currency,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        shippingTotal: totals.shippingTotal,
        discountTotal: totals.discountTotal,
        grandTotal: totals.grandTotal,
        refundedTotal: refunded ? totals.grandTotal : new Prisma.Decimal(0),
        paymentStatus: refunded ? 'REFUNDED' : 'SUCCEEDED',
        paymentReference: reference,
        paymentIntentId: reference,
        customerEmail: ACCOUNTS.customer.email,
        shipRecipientName: JORDAN_ADDRESS.recipientName,
        shipPhone: JORDAN_ADDRESS.phone,
        shipAddressLine1: JORDAN_ADDRESS.addressLine1,
        shipAddressLine2: JORDAN_ADDRESS.addressLine2,
        shipCity: JORDAN_ADDRESS.city,
        shipState: JORDAN_ADDRESS.state,
        shipPostalCode: JORDAN_ADDRESS.postalCode,
        shipCountry: JORDAN_ADDRESS.country,
        paidAt,
        shippedAt,
        deliveredAt,
        createdAt,
        items: {
          create: items.map(({ p, quantity, amounts }) => ({
            productId: p.id,
            merchantId: p.merchantId,
            productName: p.name,
            sku: p.sku,
            unitPrice: p.price,
            quantity,
            lineTotal: amounts.subtotal,
            taxCode: p.taxCode,
            taxRate: amounts.taxRate,
            taxAmount: amounts.taxAmount,
            returnedQuantity: refunded ? quantity : 0,
            imageUrl: p.images[0]?.url ?? null,
            variantName: p.variantName,
            color: p.color,
            size: p.size,
            createdAt,
          })),
        },
      },
      include: { items: true },
    });

    // Timeline (oldest first).
    const at = (d: Date, minutes = 0) => new Date(d.getTime() + minutes * 60_000);
    const events: Prisma.OrderEventCreateManyInput[] = [
      { orderId: order.id, status: 'PENDING_PAYMENT', note: 'Order placed', actor: 'CUSTOMER', createdAt },
      { orderId: order.id, status: 'PAID', fulfilmentStatus: 'UNFULFILLED', note: 'Payment received', actor: 'GATEWAY', createdAt: paidAt },
    ];
    if (shippedAt) {
      const packed = at(shippedAt, -180);
      events.push(
        { orderId: order.id, fulfilmentStatus: 'PICKED', note: 'Items picked', actor: `ADMIN:${ACCOUNTS.admin.email}`, createdAt: at(packed, -60) },
        { orderId: order.id, fulfilmentStatus: 'PACKED', note: 'Packed and ready to ship', actor: `ADMIN:${ACCOUNTS.admin.email}`, createdAt: packed },
        { orderId: order.id, status: 'SHIPPED', fulfilmentStatus: 'SHIPPED', note: 'Shipped with UPS', actor: `ADMIN:${ACCOUNTS.admin.email}`, createdAt: shippedAt },
      );
    }
    if (deliveredAt) {
      events.push({ orderId: order.id, status: 'DELIVERED', fulfilmentStatus: 'DELIVERED', note: 'Delivered', actor: 'SYSTEM', createdAt: deliveredAt });
    }

    if (shippedAt) {
      const tracking = `1Z${createHash('sha256').update(plan.orderNumber).digest('hex').slice(0, 16).toUpperCase()}`;
      const shipment = await prisma.shipment.create({
        data: {
          orderId: order.id,
          provider: 'manual',
          carrier: 'UPS',
          service: plan.method === 'EXPRESS' ? 'UPS 2nd Day Air' : 'UPS Ground',
          trackingNumber: tracking,
          trackingUrl: `https://www.ups.com/track?tracknum=${tracking}`,
          status: deliveredAt ? 'DELIVERED' : 'IN_TRANSIT',
          deliveredAt,
          createdAt: shippedAt,
        },
      });
      const scans: Prisma.ShipmentEventCreateManyInput[] = [
        { shipmentId: shipment.id, status: 'LABEL_CREATED', description: 'Shipping label created', location: 'Portland, OR', occurredAt: at(shippedAt, -30) },
        { shipmentId: shipment.id, status: 'IN_TRANSIT', description: 'Picked up by carrier', location: 'Portland, OR', occurredAt: at(shippedAt, 120) },
        { shipmentId: shipment.id, status: 'IN_TRANSIT', description: 'Arrived at carrier facility', location: 'Tualatin, OR', occurredAt: at(shippedAt, 600) },
      ];
      if (deliveredAt) {
        scans.push(
          { shipmentId: shipment.id, status: 'OUT_FOR_DELIVERY', description: 'Out for delivery', location: 'Portland, OR', occurredAt: at(deliveredAt, -300) },
          { shipmentId: shipment.id, status: 'DELIVERED', description: 'Delivered, front door', location: 'Portland, OR', occurredAt: deliveredAt },
        );
      }
      await prisma.shipmentEvent.createMany({ data: scans });
    }

    if (refunded && deliveredAt) {
      const requested = at(deliveredAt, 3 * 24 * 60);
      const received = at(requested, 4 * 24 * 60);
      const refundedAt = at(received, 120);
      await prisma.orderReturn.create({
        data: {
          orderId: order.id,
          rmaNumber: `RMA-${plan.orderNumber.slice(3)}`,
          status: 'REFUNDED',
          reason: 'Sound quality was not what I expected',
          method: 'DROPOFF',
          requestedBy: 'CUSTOMER',
          adminNote: 'Received in resaleable condition; restocked.',
          refundAmount: totals.grandTotal,
          refundReference: `${reference}-RF1`,
          restocked: true,
          receivedAt: received,
          refundedAt,
          createdAt: requested,
          items: { create: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) },
        },
      });
      events.push(
        { orderId: order.id, note: `Return RMA-${plan.orderNumber.slice(3)} requested`, actor: 'CUSTOMER', createdAt: requested },
        { orderId: order.id, note: 'Return received and restocked', actor: `ADMIN:${ACCOUNTS.admin.email}`, createdAt: received },
        { orderId: order.id, status: 'REFUNDED', note: `Refunded ${totals.grandTotal.toFixed(2)} ${config.order.currency}`, actor: `ADMIN:${ACCOUNTS.admin.email}`, createdAt: refundedAt },
      );
    }
    await prisma.orderEvent.createMany({ data: events });
    created++;
  }
  return { created, total: plans.length };
}

async function main() {
  const { databaseUrl } = loadConfig({ JWT_SECRET: 'x'.repeat(32), ...process.env });
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const admin = await upsertUser(prisma, ACCOUNTS.admin);
    await upsertUser(prisma, ACCOUNTS.catalog);
    const customer = await upsertUser(prisma, ACCOUNTS.customer);
    await prisma.user.update({ where: { id: customer.id }, data: { marketingOptIn: true } });
    if (!(await prisma.userAddress.findFirst({ where: { userId: customer.id, deleted: false } }))) {
      await prisma.userAddress.create({ data: { userId: customer.id, isDefault: true, ...JORDAN_ADDRESS } });
    }

    // The store sells its own catalog: products belong to the admin account.
    const catalog = await seedCatalog(prisma, admin.id);
    const orders = await seedOrders(prisma, customer.id);

    console.log(`Demo data ready:
  accounts  ${ACCOUNTS.admin.email} / ${ACCOUNTS.admin.password} (admin)
            ${ACCOUNTS.catalog.email} / ${ACCOUNTS.catalog.password} (catalog)
            ${ACCOUNTS.customer.email} / ${ACCOUNTS.customer.password} (customer)
  catalog   ${catalog.parents} products, ${catalog.skus} SKUs
  orders    ${orders.created} created (${orders.total - orders.created} already present)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
