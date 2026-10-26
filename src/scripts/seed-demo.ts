import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { loadConfig } from '../config';
import { addBusinessDays, lineAmounts, orderTotals, pricingRules } from '../order/pricing';
import { imageUrls, planDemoCatalog } from './demo-plan';
import { envAccount, upsertUser, type SeedAccount } from './seed-accounts';

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
 *
 * The accounts come from SEED_ADMIN_* / SEED_CATALOG_* / SEED_CUSTOMER_* (see
 * seed-accounts.ts) and fall back to the demo logins below. The Docker image
 * runs it on start when SEED_DEMO=true. DEMO_IMAGE_BASE points the product
 * images at a deployed web client (default: local dev server). To load the same
 * catalog through the importer instead, see demo-catalog-csv.ts.
 */

const IMAGE_BASE = process.env.DEMO_IMAGE_BASE ?? 'http://localhost:3000/daylora';
const DAY = 86_400_000;

const ACCOUNTS: Record<'admin' | 'catalog' | 'customer', SeedAccount> = {
  admin: envAccount('ADMIN') ?? { email: 'admin@example.com', password: 'Admin12345', fullName: 'Store Admin', role: 'ROLE_ADMIN' },
  catalog: envAccount('CATALOG') ?? { email: 'catalog@example.com', password: 'Catalog12345', fullName: 'Catalog Team', role: 'ROLE_CATALOG' },
  customer: {
    ...(envAccount('CUSTOMER') ?? { email: 'jordan.m@example.com', password: 'Customer123', role: 'ROLE_CUSTOMER' }),
    fullName: 'Jordan Miller',
    phoneNumber: '+15035550142',
  },
};

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

async function seedCatalog(prisma: PrismaClient, merchantId: string) {
  const plan = planDemoCatalog(await prisma.productCategory.findMany({ where: { deleted: false } }));
  let skus = 0;

  for (const p of plan) {
    const parentData = {
      name: p.name,
      brand: p.brand,
      shortDescription: p.shortDescription,
      description: p.description,
      categoryId: p.department.id,
      subcategoryId: p.section.id,
      productType: p.productType,
      keyFeatures: p.keyFeatures,
      warranty: p.warranty,
      usageInstructions: p.usageInstructions,
      attributes: p.attributes,
      featured: p.featured,
      merchantId,
      deleted: false,
      createdAt: p.createdAt,
    };
    const parent = await prisma.parentProduct.upsert({
      where: { code: p.code },
      update: parentData,
      create: { code: p.code, ...parentData },
    });
    const gallery = imageUrls(IMAGE_BASE, p.images);

    for (const v of p.variants) {
      const { sku, stock, ...fields } = v;
      const data = {
        ...fields,
        name: p.name,
        description: p.description,
        stockQuantity: stock,
        status: 'ACTIVE',
        categoryId: p.department.id,
        parentId: parent.id,
        merchantId,
        deleted: false,
        createdAt: p.createdAt,
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
          altText: `${p.name}${v.variantName ? ` — ${v.variantName}` : ''}`,
          position,
          isPrimary: position === 0,
          checkStatus: 'OK',
          checkedAt: new Date(),
        })),
      });
      skus++;
    }
  }
  return { parents: plan.length, skus };
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

/**
 * The design's promo codes (contract B1). Created once by code; an existing
 * row keeps whatever an admin changed since.
 */
async function seedPromotions(prisma: PrismaClient) {
  const promos = [
    { code: 'WELCOME10', description: '10% off your first order', type: 'PERCENT', value: new Prisma.Decimal(10), firstOrderOnly: true },
    { code: 'FREESHIP', description: 'Free standard shipping', type: 'FREE_SHIPPING', value: new Prisma.Decimal(0), firstOrderOnly: false },
  ];
  for (const p of promos) {
    await prisma.promotion.upsert({ where: { code: p.code }, update: {}, create: p });
  }
  return promos.map((p) => p.code);
}

/** The password, unless it came from the environment (never logged). */
const shown = (kind: string, a: SeedAccount) => (process.env[`SEED_${kind}_PASSWORD`] ? `(SEED_${kind}_PASSWORD)` : a.password);

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
    const promos = await seedPromotions(prisma);

    console.log(`Demo data ready:
  accounts  ${ACCOUNTS.admin.email} / ${shown('ADMIN', ACCOUNTS.admin)} (admin)
            ${ACCOUNTS.catalog.email} / ${shown('CATALOG', ACCOUNTS.catalog)} (catalog)
            ${ACCOUNTS.customer.email} / ${shown('CUSTOMER', ACCOUNTS.customer)} (customer)
  catalog   ${catalog.parents} products, ${catalog.skus} SKUs
  orders    ${orders.created} created (${orders.total - orders.created} already present)
  promos    ${promos.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
