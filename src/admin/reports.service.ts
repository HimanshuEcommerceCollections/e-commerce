import { Prisma, type PrismaClient } from '@prisma/client';
import { money } from '../common/api-response';
import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from '../common/enums';
import { DomainError } from '../common/errors';
import type { Config } from '../config';
import { deliveryLabel } from '../order/pricing';
import type { PaymentGateway } from '../payment/gateway';

const DAY = 86_400_000;
export const SALES_REPORT_DAYS = [7, 14, 30] as const;
const TOP = 10;

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const ZERO = new Prisma.Decimal(0);

/**
 * Admin analytics (FR-IN-05), the sales report (design 12) and the read-only
 * settings page. Revenue is always what paid orders brought in, net of
 * refunds, dated by when they were paid.
 */
export class AdminReportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: PaymentGateway,
    private readonly config: Config,
  ) {}

  // ── Analytics summary ────────────────────────────────────────────────────

  /**
   * Funnel counts per event type (events and distinct sessions), paid orders
   * and revenue, conversion (orders per session) and the most viewed and
   * added-to-cart products. Default window: the last 30 days.
   */
  async analyticsSummary(range: { from?: string; to?: string }) {
    const { from, to } = parseRange(range);
    const [byType, sessions, paid, viewed, added] = await Promise.all([
      this.prisma.$queryRaw<{ event_type: string; events: number; sessions: number }[]>`
        SELECT event_type, count(*)::int AS events, count(DISTINCT session_id)::int AS sessions
          FROM analytics_events
         WHERE created_at >= ${from} AND created_at < ${to}
         GROUP BY event_type`,
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT session_id)::int AS n FROM analytics_events
         WHERE created_at >= ${from} AND created_at < ${to} AND session_id IS NOT NULL`,
      this.paidTotals(from, to),
      this.topProducts('PRODUCT_VIEW', from, to),
      this.topProducts('ADD_TO_CART', from, to),
    ]);
    const events = Object.fromEntries(
      ANALYTICS_EVENT_TYPES.map((t) => {
        const row = byType.find((r) => r.event_type === t);
        return [t, { events: row?.events ?? 0, sessions: row?.sessions ?? 0 }];
      }),
    ) as Record<AnalyticsEventType, { events: number; sessions: number }>;
    const sessionCount = sessions[0]?.n ?? 0;
    return {
      from,
      to,
      events,
      orders: paid.orders,
      revenue: money(paid.revenue),
      conversionRate: sessionCount ? Math.round((paid.orders / sessionCount) * 10_000) / 100 : null,
      topViewedProducts: viewed,
      topAddedToCartProducts: added,
    };
  }

  private async topProducts(type: AnalyticsEventType, from: Date, to: Date) {
    const rows = await this.prisma.$queryRaw<{ product_id: string; count: number }[]>`
      SELECT product_id, count(*)::int AS count FROM analytics_events
       WHERE event_type = ${type} AND product_id IS NOT NULL AND created_at >= ${from} AND created_at < ${to}
       GROUP BY product_id ORDER BY count DESC, product_id LIMIT ${TOP}`;
    const products = await this.prisma.product.findMany({
      where: { id: { in: rows.map((r) => r.product_id) } },
      select: { id: true, sku: true, name: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    return rows.map((r) => ({
      productId: r.product_id,
      sku: byId.get(r.product_id)?.sku ?? '',
      name: byId.get(r.product_id)?.name ?? '(deleted product)',
      count: r.count,
    }));
  }

  private async paidTotals(from: Date, to: Date) {
    const rows = await this.prisma.$queryRaw<{ orders: number; revenue: Prisma.Decimal | null }[]>`
      SELECT count(*)::int AS orders, sum(grand_total - refunded_total) AS revenue
        FROM orders
       WHERE deleted = false AND paid_at >= ${from} AND paid_at < ${to}`;
    return { orders: rows[0]?.orders ?? 0, revenue: new Prisma.Decimal(rows[0]?.revenue ?? 0) };
  }

  // ── Sales report ─────────────────────────────────────────────────────────

  /**
   * The last `days` days (UTC, today included) against the `days` before.
   * Department revenue and top products count merchandise (price × units
   * kept, i.e. bought minus returned); totals also include tax and shipping.
   */
  async salesReport(days: number) {
    const to = new Date();
    const from = new Date(startOfUtcDay(to).getTime() - (days - 1) * DAY);
    const previousFrom = new Date(from.getTime() - days * DAY);

    const [orders, previous, lines] = await Promise.all([
      this.prisma.order.findMany({
        where: { deleted: false, paidAt: { gte: from, lt: to } },
        select: { paidAt: true, grandTotal: true, refundedTotal: true },
      }),
      this.paidTotals(previousFrom, from),
      this.prisma.$queryRaw<
        { product_id: string; name: string; sku: string; image_url: string | null; units: number; revenue: Prisma.Decimal }[]
      >`
        SELECT oi.product_id, max(oi.product_name) AS name, max(oi.sku) AS sku, max(oi.image_url) AS image_url,
               sum(oi.quantity - oi.returned_quantity)::int AS units,
               sum(oi.unit_price * (oi.quantity - oi.returned_quantity)) AS revenue
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE o.deleted = false AND oi.deleted = false AND o.paid_at >= ${from} AND o.paid_at < ${to}
         GROUP BY oi.product_id`,
    ]);

    const daily = new Map<string, { revenue: Prisma.Decimal; orders: number }>();
    for (let d = from.getTime(); d < to.getTime(); d += DAY) daily.set(isoDate(new Date(d)), { revenue: ZERO, orders: 0 });
    let revenue = ZERO;
    for (const o of orders) {
      const net = o.grandTotal.sub(o.refundedTotal);
      revenue = revenue.add(net);
      const day = daily.get(isoDate(o.paidAt!));
      if (day) {
        day.revenue = day.revenue.add(net);
        day.orders += 1;
      }
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: lines.map((l) => l.product_id) } },
      select: {
        id: true,
        parentId: true,
        stockQuantity: true,
        images: { where: { deleted: false }, orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }], take: 1, select: { url: true } },
        parent: { select: { category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } } } },
      },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const departments = new Map<string, { categoryId: string | null; name: string; revenue: Prisma.Decimal; units: number }>();
    let units = 0;
    for (const l of lines) {
      units += l.units;
      const category = productById.get(l.product_id)?.parent.category;
      // A subcategory rolls up to its department.
      const dept = category?.parent ?? category ?? null;
      const key = dept?.id ?? '';
      const entry = departments.get(key) ?? { categoryId: dept?.id ?? null, name: dept?.name ?? 'Other', revenue: ZERO, units: 0 };
      entry.revenue = entry.revenue.add(l.revenue ?? 0);
      entry.units += l.units;
      departments.set(key, entry);
    }

    const top = [...lines]
      .sort((a, b) => new Prisma.Decimal(b.revenue ?? 0).cmp(a.revenue ?? 0) || b.units - a.units)
      .slice(0, TOP)
      .map((l) => {
        const p = productById.get(l.product_id);
        return {
          productId: l.product_id,
          parentId: p?.parentId ?? null,
          name: l.name,
          sku: l.sku,
          imageUrl: l.image_url ?? p?.images[0]?.url ?? null,
          units: l.units,
          revenue: money(new Prisma.Decimal(l.revenue ?? 0)),
          stockLeft: p?.stockQuantity ?? 0,
        };
      });

    return {
      from,
      to,
      currency: this.config.order.currency,
      totals: {
        revenue: money(revenue),
        orders: orders.length,
        units,
        averageOrderValue: money(orders.length ? revenue.div(orders.length).toDecimalPlaces(2) : ZERO),
      },
      previous: { revenue: money(previous.revenue), orders: previous.orders },
      daily: [...daily].map(([date, d]) => ({ date, revenue: money(d.revenue), orders: d.orders })),
      byDepartment: [...departments.values()]
        .sort((a, b) => b.revenue.cmp(a.revenue))
        .map((d) => ({ categoryId: d.categoryId, name: d.name, revenue: money(d.revenue), units: d.units })),
      topProducts: top,
    };
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  /** Read-only: everything here comes from the server's environment. */
  settings() {
    const c = this.config;
    return {
      currency: c.order.currency,
      paymentProvider: c.payment.provider,
      manualPaymentConfirmation: this.gateway.supportsManualConfirmation(),
      shippingProvider: c.shipping.provider,
      pricesIncludeTax: c.pricing.pricesIncludeTax,
      shipping: (['STANDARD', 'EXPRESS'] as const).map((method) => {
        const rate = method === 'STANDARD' ? c.shipping.standard : c.shipping.express;
        return { method, fee: rate.fee, estimatedDelivery: deliveryLabel(rate) };
      }),
      freeShippingThreshold: c.shipping.freeThreshold,
      lowStockThreshold: c.inventory.lowStockThreshold,
      returnWindowDays: c.returns.windowDays,
      imageChecks: c.imageChecks.enabled,
      email: c.mail.provider === 'log' ? 'log-only' : c.mail.provider,
    };
  }
}

/**
 * `from`/`to` as ISO dates or date-times. A date-only `to` includes that whole
 * day. Defaults: the last 30 days up to now.
 */
function parseRange(range: { from?: string; to?: string }) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const parse = (v: string, name: string) => {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new DomainError(400, `${name} must be an ISO-8601 date`);
    return new Date(t);
  };
  const to = range.to
    ? new Date(parse(range.to, 'to').getTime() + (dateOnly.test(range.to) ? DAY : 0))
    : new Date();
  const from = range.from ? parse(range.from, 'from') : new Date(to.getTime() - 30 * DAY);
  if (from >= to) throw new DomainError(400, 'from must be before to');
  return { from, to };
}
