import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { CatalogAdminService, Staff } from '../../admin/catalog.service';
import { DomainError, OrderNotFoundError, ProductNotFoundError } from '../../common/errors';
import { decimal, oneOf, optionalString, requiredUuid, ValidationError } from '../../common/validation';
import { PRODUCT_STATUSES } from '../../common/enums';
import type { ConnectionResult, IntegrationService, ResolvedIntegration } from '../../integrations/integration.service';
import { PROVIDERS } from '../../integrations/providers';
import { recordOrderEvent } from '../../order/order-events';
import {
  GootenApiError,
  GootenClient,
  type GootenConnection,
  type GootenOrderRequest,
  type GootenProduct,
  type GootenVariant,
} from './gooten.client';

export const VENDOR = 'GOOTEN';
/** Print on demand: Gooten makes each unit when ordered, so stock never runs out. */
export const POD_STOCK = 9999;
const SKU_PREFIX = 'GT-';
const CACHE_MS = 15 * 60 * 1000;

export const SHIP_METHODS = ['STANDARD', 'EXPEDITED', 'OVERNIGHT'] as const;
type ShipMethod = (typeof SHIP_METHODS)[number];

export const GootenImportSchema = z.object({
  subcategoryId: requiredUuid(),
  /** Our price = Gooten's cost × (1 + markup/100). */
  markupPercent: decimal({ positiveOrZero: true, max: 1000 }),
  status: oneOf(PRODUCT_STATUSES),
  /** Gooten SKUs to import; all variants when absent (at most 100). */
  skus: z.array(z.string().min(1).max(200)).max(100, 'select at most 100 variants').optional(),
  name: optionalString({ max: 255 }),
  brand: optionalString({ max: 100 }),
  printFileUrl: optionalString({ max: 2048 }),
});

export const GootenLinkUpdateSchema = z.object({
  printFileUrl: optionalString({ max: 2048 }),
});

export const GootenSubmitSchema = z.object({
  shipMethod: oneOf(SHIP_METHODS),
});

const url = (v: string | undefined, field: string) => {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    return v;
  } catch {
    throw new ValidationError({ [field]: 'must be a valid http(s) URL' });
  }
};

const round2 = (n: Prisma.Decimal) => n.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Gooten SKUs may hold characters our SKU column refuses. */
const ourSku = (vendorSku: string) => `${SKU_PREFIX}${vendorSku.replace(/[^A-Za-z0-9._-]+/g, '-')}`.slice(0, 100);

const option = (v: GootenVariant, name: string) => v.Options.find((o) => o.Name.toLowerCase() === name)?.Value;

/** "Color"/"Size" fill our columns; the rest ("Print Area", …) make the variant name. */
function variantFields(v: GootenVariant) {
  const color = option(v, 'color');
  const size = option(v, 'size');
  const other = v.Options.filter((o) => !['color', 'size'].includes(o.Name.toLowerCase()))
    .map((o) => o.Value)
    .filter(Boolean);
  const name = [color, size, ...other].filter(Boolean).join(' / ');
  return {
    color: color?.slice(0, 50),
    size: size?.slice(0, 50),
    variantName: (name || v.Sku).slice(0, 150),
    optionImage: v.Options.find((o) => o.ImageUrl)?.ImageUrl,
  };
}

function productTexts(p: GootenProduct) {
  const info = [...(p.Info ?? [])].sort((a, b) => (a.Index ?? 0) - (b.Index ?? 0));
  const paragraphs = info.filter((i) => i.ContentType === 'Text').flatMap((i) => i.Content).filter(Boolean);
  const facts = info
    .filter((i) => i.ContentType === 'List' && i.Key)
    .map((i) => `${i.Key}: ${i.Content.join(', ')}`);
  const placeholder = !p.ShortDescription || /^short description$/i.test(p.ShortDescription.trim());
  return {
    shortDescription: (placeholder ? paragraphs[0] : p.ShortDescription)?.slice(0, 1000),
    description: [...paragraphs, ...(facts.length ? ['', ...facts] : [])].join('\n').slice(0, 10000) || undefined,
  };
}

const productImages = (p: GootenProduct) => [...new Set((p.Images ?? []).map((i) => i.Url).filter(Boolean))];

/** Our ship-to country column holds an ISO code or a name. */
function countryCode(country: string): string {
  const c = country.trim();
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  const known: Record<string, string> = {
    'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US',
    canada: 'CA', 'united kingdom': 'GB', uk: 'GB', australia: 'AU', germany: 'DE', france: 'FR', india: 'IN',
  };
  const code = known[c.toLowerCase()];
  if (!code) throw new DomainError(409, `Can't map the ship-to country '${country}' to a country code for Gooten`);
  return code;
}

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  const last = parts.length > 1 ? parts.pop()! : '-';
  return { FirstName: parts.join(' ') || '-', LastName: last };
}

const toConnection = (i: ResolvedIntegration, timeoutMs: number): GootenConnection => ({
  recipeId: i.secrets.RECIPE_ID ?? '',
  partnerBillingKey: i.secrets.PARTNER_BILLING_KEY ?? '',
  testMode: i.settings.testMode !== false,
  apiBaseUrl: (i.baseUrl ?? PROVIDERS.GOOTEN.defaultBaseUrl!).replace(/\/+$/, ''),
  timeoutMs,
});

export class GootenService {
  /** Keyed by recipe ID, so a changed recipe never serves the old catalog. */
  private catalogCache = new Map<string, { at: number; products: GootenProduct[] }>();
  private variantCache = new Map<string, { at: number; variants: GootenVariant[] }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly integrations: IntegrationService,
    private readonly catalog: CatalogAdminService,
    private readonly timeoutMs: number,
    private readonly currency: string,
  ) {
    integrations.registerTester(VENDOR, (i) => this.testConnection(i));
  }

  // ── Connection ────────────────────────────────────────────────────────────

  /** The enabled Gooten integration's credentials, or null when there is none. */
  private async connection(): Promise<{ conn: GootenConnection; client: GootenClient; integration: ResolvedIntegration } | null> {
    const integration = await this.integrations.resolve(VENDOR);
    if (!integration) return null;
    const conn = toConnection(integration, this.timeoutMs);
    return { conn, client: new GootenClient(conn), integration };
  }

  private async connect() {
    const c = await this.connection();
    if (!c) throw new DomainError(409, 'Gooten is not connected. Add it under Settings › API integrations.');
    return c;
  }

  /** Used by Settings › API integrations › Test connection. */
  async testConnection(i: ResolvedIntegration): Promise<ConnectionResult> {
    const conn = toConnection(i, this.timeoutMs);
    if (!conn.recipeId) return { ok: false, message: 'Add the recipe ID first' };
    const res = await new GootenClient(conn).products('US', this.currency);
    const count = (res.Products ?? []).length;
    return {
      ok: true,
      message: `Connected: ${count} Gooten products available${conn.partnerBillingKey ? '' : '; add the partner billing key to send orders'}`,
      detail: { products: count, testMode: conn.testMode },
    };
  }

  async status() {
    const [importedProducts, ordersSent, c] = await Promise.all([
      this.prisma.vendorProductLink.count({ where: { vendor: VENDOR } }),
      this.prisma.vendorOrder.count({ where: { vendor: VENDOR, vendorOrderId: { not: null } } }),
      this.connection(),
    ]);
    let connection: { ok: boolean; products?: number; error?: string };
    if (!c) connection = { ok: false, error: 'Gooten is not connected. Add it under Settings › API integrations.' };
    else {
      try {
        connection = { ok: true, products: (await this.products(c)).length };
      } catch (err) {
        connection = { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
      }
    }
    return {
      vendor: VENDOR,
      integration: c ? { slug: c.integration.slug, name: c.integration.name } : null,
      recipeIdConfigured: !!c?.conn.recipeId,
      billingKeyConfigured: !!c?.conn.partnerBillingKey,
      testMode: c?.conn.testMode ?? true,
      currency: this.currency,
      connection,
      importedProducts,
      ordersSent,
    };
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  private async products(c?: { conn: GootenConnection; client: GootenClient }): Promise<GootenProduct[]> {
    const { conn, client } = c ?? (await this.connect());
    const hit = this.catalogCache.get(conn.recipeId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.products;
    const res = await client.products('US', this.currency);
    const products = (res.Products ?? []).filter((p) => p.HasAvailableProductVariants !== false && !p.IsComingSoon);
    this.catalogCache.set(conn.recipeId, { at: Date.now(), products });
    return products;
  }

  private async variants(productId: number): Promise<GootenVariant[]> {
    const { conn, client } = await this.connect();
    const key = `${conn.recipeId}:${productId}`;
    const hit = this.variantCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.variants;
    const res = await client.productVariants(productId, 'US', this.currency);
    const variants = res.ProductVariants ?? [];
    this.variantCache.set(key, { at: Date.now(), variants });
    return variants;
  }

  private async product(productId: number) {
    const p = (await this.products()).find((x) => x.Id === productId);
    if (!p) throw new DomainError(404, `Gooten product ${productId} was not found`);
    return p;
  }

  /** Gooten's catalog, with the products we already sell marked. */
  async listCatalog(search?: string, category?: string) {
    const [products, links] = await Promise.all([
      this.products(),
      this.prisma.vendorProductLink.findMany({
        where: { vendor: VENDOR, parent: { deleted: false } },
        select: { vendorProductId: true, parentProductId: true },
      }),
    ]);
    const imported = new Map(links.map((l) => [l.vendorProductId, l.parentProductId]));
    const q = search?.trim().toLowerCase();
    const categories = [...new Set(products.flatMap((p) => (p.Categories ?? []).map((c) => c.Name).filter((n): n is string => !!n)))].sort();
    const rows = products
      .filter((p) => !q || p.Name.toLowerCase().includes(q) || String(p.Id) === q)
      .filter((p) => !category || (p.Categories ?? []).some((c) => c.Name === category))
      .map((p) => ({
        id: p.Id,
        name: p.Name,
        shortDescription: productTexts(p).shortDescription ?? null,
        retailPrice: p.RetailPrice?.Price ?? null,
        currency: p.RetailPrice?.CurrencyCode ?? this.currency,
        imageUrl: productImages(p)[0] ?? null,
        categories: (p.Categories ?? []).map((c) => c.Name).filter(Boolean),
        importedParentId: imported.get(String(p.Id)) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { products: rows, categories, total: rows.length };
  }

  async catalogProduct(productId: number) {
    const p = await this.product(productId);
    const variants = await this.variants(productId);
    const link = await this.prisma.vendorProductLink.findFirst({
      where: { vendor: VENDOR, vendorProductId: String(productId), parent: { deleted: false } },
      select: { parentProductId: true },
    });
    const texts = productTexts(p);
    return {
      id: p.Id,
      name: p.Name,
      ...texts,
      retailPrice: p.RetailPrice?.Price ?? null,
      currency: p.RetailPrice?.CurrencyCode ?? this.currency,
      images: productImages(p),
      categories: (p.Categories ?? []).map((c) => c.Name).filter(Boolean),
      importedParentId: link?.parentProductId ?? null,
      variants: variants.map((v) => {
        const f = variantFields(v);
        return {
          sku: v.Sku,
          ourSku: ourSku(v.Sku),
          cost: v.PriceInfo?.Price ?? null,
          color: f.color ?? null,
          size: f.size ?? null,
          name: f.variantName,
          options: v.Options.map((o) => ({ name: o.Name, value: o.Value })),
          imageUrl: f.optionImage ?? null,
        };
      }),
    };
  }

  /**
   * Adds a Gooten product to our catalog through the regular Add-product path
   * (same checks, codes, slugs and stock log), then marks its SKUs as Gooten's.
   */
  async importProduct(productId: number, input: z.output<typeof GootenImportSchema>, staff: Staff) {
    const existing = await this.prisma.vendorProductLink.findFirst({
      where: { vendor: VENDOR, vendorProductId: String(productId) },
      include: { parent: { select: { deleted: true } } },
    });
    if (existing && !existing.parent.deleted) {
      throw new DomainError(409, 'This Gooten product is already in the catalog');
    }

    const p = await this.product(productId);
    const all = await this.variants(productId);
    const wanted = input.skus ? new Set(input.skus) : null;
    const chosen = wanted ? all.filter((v) => wanted.has(v.Sku)) : all;
    if (!chosen.length) throw new ValidationError({ skus: 'select at least one variant' });
    if (chosen.length > 100) {
      throw new ValidationError({ skus: `this product has ${chosen.length} variants; select at most 100` });
    }
    const missing = wanted ? [...wanted].filter((s) => !all.some((v) => v.Sku === s)) : [];
    if (missing.length) throw new ValidationError({ skus: `unknown Gooten SKUs: ${missing.slice(0, 5).join(', ')}` });

    const markup = input.markupPercent ?? new Prisma.Decimal(50);
    const printFileUrl = url(input.printFileUrl, 'printFileUrl');
    const fallbackImages = productImages(p);
    const texts = productTexts(p);
    const skuMap: Record<string, string> = {};

    const variants = chosen.map((v) => {
      const cost = new Prisma.Decimal(v.PriceInfo?.Price ?? 0);
      if (cost.lte(0)) throw new DomainError(409, `Gooten has no price for ${v.Sku}`);
      const f = variantFields(v);
      const sku = ourSku(v.Sku);
      if (skuMap[sku]) throw new DomainError(409, `Two Gooten SKUs map to ${sku}; import them separately`);
      skuMap[sku] = v.Sku;
      const images = [...new Set([f.optionImage, ...fallbackImages].filter((u): u is string => !!u))].slice(0, 5);
      if (!images.length) throw new DomainError(409, `Gooten has no image for ${v.Sku}`);
      return {
        sku,
        variantName: f.variantName,
        color: f.color,
        size: f.size,
        price: round2(cost.mul(markup.div(100).add(1))),
        mrp: undefined,
        taxRate: undefined,
        stockQuantity: POD_STOCK,
        lowStockThreshold: 0,
        imageUrls: images,
        cost: round2(cost),
      };
    });

    const created = await this.catalog.createProduct(
      {
        name: input.name ?? p.Name,
        brand: input.brand,
        subcategoryId: input.subcategoryId,
        productType: p.Categories?.[0]?.Name?.slice(0, 100),
        shortDescription: texts.shortDescription,
        description: texts.description,
        status: input.status ?? 'DRAFT',
        featured: undefined,
        variants: variants.map(({ cost: _cost, ...v }) => v),
      },
      staff,
    );

    await this.prisma.$transaction(async (tx) => {
      for (const v of variants) {
        await tx.product.updateMany({ where: { parentId: created.id, sku: v.sku }, data: { supplierId: VENDOR, cost: v.cost } });
      }
      if (existing) await tx.vendorProductLink.delete({ where: { id: existing.id } });
      await tx.vendorProductLink.create({
        data: {
          vendor: VENDOR,
          vendorProductId: String(productId),
          vendorName: p.Name.slice(0, 255),
          parentProductId: created.id,
          skuMap,
          printFileUrl: printFileUrl ?? null,
          markupPercent: markup,
          importedBy: staff.email,
        },
      });
    });
    return { parentId: created.id, name: created.name, variants: variants.length };
  }

  /** Catalog products Gooten fulfils. */
  async listLinks() {
    const links = await this.prisma.vendorProductLink.findMany({
      where: { vendor: VENDOR, parent: { deleted: false } },
      orderBy: { createdAt: 'desc' },
      include: {
        parent: {
          select: {
            id: true,
            name: true,
            code: true,
            variants: { where: { deleted: false }, select: { price: true, cost: true, status: true } },
          },
        },
      },
    });
    return links.map((l) => {
      const prices = l.parent.variants.map((v) => Number(v.price));
      return {
        id: l.id,
        parentId: l.parent.id,
        name: l.parent.name,
        code: l.parent.code,
        vendorProductId: l.vendorProductId,
        vendorName: l.vendorName,
        variants: l.parent.variants.length,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        statuses: [...new Set(l.parent.variants.map((v) => v.status))],
        markupPercent: Number(l.markupPercent),
        printFileUrl: l.printFileUrl,
        importedBy: l.importedBy,
        createdAt: l.createdAt,
      };
    });
  }

  async updateLink(id: string, input: z.output<typeof GootenLinkUpdateSchema>) {
    const link = await this.prisma.vendorProductLink.findFirst({ where: { id, vendor: VENDOR } });
    if (!link) throw new ProductNotFoundError(id);
    await this.prisma.vendorProductLink.update({
      where: { id },
      data: { printFileUrl: input.printFileUrl === undefined ? undefined : url(input.printFileUrl, 'printFileUrl') ?? null },
    });
    return { id, printFileUrl: input.printFileUrl ?? null };
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  private async vendorLines(orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deleted: false },
      include: { items: { where: { deleted: false } }, user: { select: { email: true } } },
    });
    if (!order) throw new OrderNotFoundError(orderId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: order.items.map((i) => i.productId) }, supplierId: VENDOR },
      select: { id: true, sku: true, parent: { select: { name: true, vendorLink: true } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = order.items
      .filter((i) => byId.has(i.productId))
      .map((i) => {
        const p = byId.get(i.productId)!;
        const link = p.parent.vendorLink;
        const skuMap = (link?.skuMap ?? {}) as Record<string, string>;
        return {
          item: i,
          productName: p.parent.name,
          vendorSku: skuMap[p.sku] ?? (p.sku.startsWith(SKU_PREFIX) ? p.sku.slice(SKU_PREFIX.length) : p.sku),
          printFileUrl: link?.printFileUrl ?? null,
          quantity: i.quantity - i.returnedQuantity,
        };
      })
      .filter((l) => l.quantity > 0);
    return { order, lines };
  }

  /** Orders holding Gooten items, newest first, with what was sent for each. */
  async listOrders() {
    const gootenProducts = await this.prisma.product.findMany({ where: { supplierId: VENDOR }, select: { id: true } });
    const ids = gootenProducts.map((p) => p.id);
    const orders = ids.length
      ? await this.prisma.order.findMany({
          where: { deleted: false, items: { some: { productId: { in: ids }, deleted: false } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: {
            items: { where: { deleted: false, productId: { in: ids } }, select: { productName: true, sku: true, quantity: true } },
            vendorOrders: { where: { vendor: VENDOR }, orderBy: { createdAt: 'desc' } },
          },
        })
      : [];
    return orders.map((o) => {
      const sent = o.vendorOrders.find((v) => v.vendorOrderId);
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        status: o.status,
        paymentStatus: o.paymentStatus,
        recipient: o.shipRecipientName,
        shipTo: `${o.shipCity}, ${o.shipState} ${o.shipPostalCode}`,
        items: o.items,
        submission: sent ?? o.vendorOrders[0] ?? null,
        attempts: o.vendorOrders.map((v) => ({
          id: v.id,
          createdAt: v.createdAt,
          status: v.status,
          vendorOrderId: v.vendorOrderId,
          testMode: v.testMode,
          shipMethod: v.shipMethod,
          error: v.error,
          submittedBy: v.submittedBy,
        })),
      };
    });
  }

  async submitOrder(orderId: string, shipMethod: ShipMethod, staff: Staff) {
    const { conn, client } = await this.connect();
    const { order, lines } = await this.vendorLines(orderId);
    if (!lines.length) throw new DomainError(409, 'This order has no Gooten items to send');
    if (['CANCELLED', 'REFUNDED', 'PAYMENT_FAILED', 'PENDING_PAYMENT'].includes(order.status)) {
      throw new DomainError(409, `Order ${order.orderNumber} is ${order.status.toLowerCase().replace('_', ' ')}; it can't be sent to Gooten`);
    }
    if (!conn.testMode && order.paymentStatus !== 'SUCCEEDED') {
      throw new DomainError(409, `Order ${order.orderNumber} is not paid yet`);
    }
    const already = await this.prisma.vendorOrder.findFirst({
      where: { orderId, vendor: VENDOR, vendorOrderId: { not: null }, testMode: conn.testMode },
    });
    if (already) {
      throw new DomainError(409, `Order ${order.orderNumber} was already sent to Gooten (${already.vendorOrderId})`);
    }
    const noArt = [...new Set(lines.filter((l) => !l.printFileUrl).map((l) => l.productName))];
    if (noArt.length) {
      throw new DomainError(409, `Add a print file on the Gooten products page first: ${noArt.join(', ')}`);
    }

    const address = {
      ...splitName(order.shipRecipientName),
      Line1: order.shipAddressLine1,
      Line2: order.shipAddressLine2 ?? undefined,
      City: order.shipCity,
      State: order.shipState,
      CountryCode: countryCode(order.shipCountry),
      PostalCode: order.shipPostalCode,
      Phone: order.shipPhone ?? undefined,
      Email: order.customerEmail ?? order.user?.email ?? undefined,
      IsBusinessAddress: false,
    };

    // Gooten wants its ship-method Id for this destination and these SKUs.
    const quote = await client.shippingPrices({
      ShipToPostalCode: address.PostalCode,
      ShipToCountry: address.CountryCode,
      ShipToState: address.State,
      CurrencyCode: this.currency,
      LanguageCode: 'en',
      Items: lines.map((l) => ({ SKU: l.vendorSku, Quantity: l.quantity })),
    });
    const methodFor = (sku: string) => {
      const group = quote.Result?.find((r) => r.SKUs.includes(sku)) ?? quote.Result?.[0];
      const opt = group?.ShipOptions.find((o) => o.MethodType.toUpperCase() === shipMethod);
      if (!opt) {
        const offered = group?.ShipOptions.map((o) => o.MethodType).join(', ') || 'none';
        throw new DomainError(409, `Gooten doesn't offer ${shipMethod.toLowerCase()} shipping for ${sku} to this address (offered: ${offered})`);
      }
      return opt.Id;
    };

    const request: Omit<GootenOrderRequest, 'Payment'> = {
      ShipToAddress: address,
      BillingAddress: address,
      Items: lines.map((l) => ({
        Quantity: l.quantity,
        SKU: l.vendorSku,
        ShipCarrierMethodId: methodFor(l.vendorSku),
        SourceId: l.item.id,
        Images: [{ Url: l.printFileUrl!, Index: 0 }],
      })),
      IsInTestMode: conn.testMode,
      SourceId: order.orderNumber,
    };

    const actor = `ADMIN:${staff.email}`;
    try {
      const res = await client.submitOrder(request);
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.vendorOrder.create({
          data: {
            vendor: VENDOR,
            orderId,
            vendorOrderId: String(res.Id),
            status: 'SUBMITTED',
            testMode: conn.testMode,
            shipMethod,
            request: request as unknown as Prisma.InputJsonValue,
            response: res as unknown as Prisma.InputJsonValue,
            submittedBy: staff.email,
          },
        });
        await recordOrderEvent(tx, orderId, {
          note: `Sent to Gooten${conn.testMode ? ' (test mode)' : ''} as order ${res.Id}, ${shipMethod.toLowerCase()} shipping`,
          actor,
        });
        return created;
      });
      return { id: row.id, vendorOrderId: row.vendorOrderId, status: row.status, testMode: row.testMode };
    } catch (err) {
      if (err instanceof GootenApiError) {
        await this.prisma.vendorOrder.create({
          data: {
            vendor: VENDOR,
            orderId,
            status: 'FAILED',
            testMode: conn.testMode,
            shipMethod,
            request: request as unknown as Prisma.InputJsonValue,
            response: (err.body ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            error: err.message.slice(0, 2000),
            submittedBy: staff.email,
          },
        });
      }
      throw err;
    }
  }

  /** Reads the order back from Gooten and stores its item statuses. */
  async refreshSubmission(id: string) {
    const row = await this.prisma.vendorOrder.findFirst({ where: { id, vendor: VENDOR } });
    if (!row) throw new DomainError(404, `Gooten submission ${id} was not found`);
    if (!row.vendorOrderId) throw new DomainError(409, 'This attempt was rejected by Gooten; there is nothing to refresh');
    const { client } = await this.connect();
    const res = await client.getOrder(row.vendorOrderId);
    const items = Array.isArray(res.Items) ? (res.Items as Array<Record<string, unknown>>) : [];
    const statuses = [...new Set(items.map((i) => i.Status).filter((s): s is string => typeof s === 'string' && s !== ''))];
    const status = (statuses.join(', ') || (typeof res.Status === 'string' ? res.Status : '') || row.status).slice(0, 60);
    const updated = await this.prisma.vendorOrder.update({
      where: { id },
      data: { status, response: res as Prisma.InputJsonValue },
    });
    const tracking = items
      .map((i) => (typeof i.TrackingNumber === 'string' ? i.TrackingNumber : null))
      .filter(Boolean);
    return { id, status: updated.status, tracking: [...new Set(tracking)], raw: res };
  }
}
