import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { DomainError, InvalidOrderStateError } from '../common/errors';
import { toPage, type Pageable } from '../common/pagination';
import { oneOf, optionalString, requiredString } from '../common/validation';
import type { AdminOrderService } from '../admin/orders.service';
import type { AdminReturnService } from '../admin/returns.service';
import { SELLER_PAYOUTS } from '../config';
import type { Actor } from './submission.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The design's tabs (designs/seller/seller-orders.html). */
export const SELLER_ORDER_TABS = ['new', 'shipped', 'delivered', 'return', 'cancelled', 'all'] as const;
export type SellerOrderTab = (typeof SELLER_ORDER_TABS)[number];

export const CARRIERS = ['UPS', 'USPS', 'FedEx', 'DHL', 'Other'] as const;
export const CANCEL_REASONS = ['Out of stock', 'Item damaged', "Can't ship to this address", 'Pricing error', 'Other'] as const;

export const ShipSchema = z.object({
  carrier: oneOf(CARRIERS).refine((v) => v !== undefined, 'must not be null'),
  trackingNumber: requiredString({
    max: 100,
    pattern: /^[A-Za-z0-9][A-Za-z0-9 -]{7,}$/,
    patternMessage: 'enter the full tracking number from your carrier label',
  }),
});
export const SellerCancelSchema = z.object({
  reason: oneOf(CANCEL_REASONS).refine((v) => v !== undefined, 'choose a reason'),
  note: optionalString({ max: 500 }),
});
export const ReturnApproveSchema = z.object({ note: optionalString({ max: 1000 }) });

const TO_SHIP = ['PAID', 'CONFIRMED'];
const CLOSED = ['CANCELLED', 'REFUNDED'];
const OPEN_RETURN = ['REQUESTED', 'APPROVED', 'RECEIVED'];

/** Where each tab's orders are (beyond "paid, with a line of this seller's products"). */
const TAB_WHERE: Record<SellerOrderTab, Prisma.OrderWhereInput> = {
  new: { status: { in: TO_SHIP } },
  shipped: { status: 'SHIPPED', returns: { none: { status: { in: OPEN_RETURN } } } },
  delivered: { status: 'DELIVERED', returns: { none: { status: { in: OPEN_RETURN } } } },
  return: { OR: [{ returns: { some: { status: { in: OPEN_RETURN } } } }, { status: { notIn: CLOSED }, returns: { some: { status: 'REFUNDED' } } }] },
  cancelled: { status: { in: CLOSED } },
  all: {},
};

/** Everything the seller's order views need. Lines of other sellers are loaded too, to tell whether the order is all theirs. */
const ORDER_INCLUDE = {
  items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } },
  returns: { include: { items: true }, orderBy: { createdAt: 'desc' } },
  shipments: { orderBy: { createdAt: 'desc' }, take: 1 },
  payoutItems: { include: { payout: { select: { reference: true, status: true, scheduledFor: true, paidAt: true } } } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

const round2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * The seller's side of orders (designs/seller/seller-orders.html): what to
 * ship and by when, shipping with tracking, cancelling an order they can't
 * ship, approving a return, earnings after commission, and weekly payouts.
 *
 * Sellers act only on orders whose every line is theirs; an order shared with
 * other sellers is handled by our team. Shipping, cancelling and returns go
 * through the same services as the admin panel, so customers get the same
 * emails, refunds and order history either way.
 */
export class SellerOrderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly adminOrders: AdminOrderService,
    private readonly adminReturns: AdminReturnService,
  ) {}

  // ── Lists ─────────────────────────────────────────────────────────────────

  async list(seller: Actor, tab: SellerOrderTab, search: string | undefined, pageable: Pageable) {
    const ids = await this.productIds(seller);
    const base = this.mine(ids);
    const q = search?.trim();
    const where: Prisma.OrderWhereInput = {
      AND: [
        base,
        TAB_WHERE[tab],
        ...(q
          ? [
              {
                OR: [
                  { orderNumber: { contains: q, mode: 'insensitive' as const } },
                  { shipCity: { contains: q, mode: 'insensitive' as const } },
                  { items: { some: { productId: { in: ids }, OR: [{ productName: { contains: q, mode: 'insensitive' as const } }, { sku: { contains: q, mode: 'insensitive' as const } }] } } },
                ],
              },
            ]
          : []),
      ],
    };
    const [rows, total, counts, stats] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        // To ship: the most urgent first. Otherwise the newest first.
        orderBy: tab === 'new' ? { paidAt: 'asc' } : { paidAt: 'desc' },
        skip: pageable.page * pageable.size,
        take: pageable.size,
      }),
      this.prisma.order.count({ where }),
      this.counts(base),
      this.stats(base, ids),
    ]);
    return { ...toPage(rows.map((o) => this.summary(o, ids)), total, pageable), counts, stats, commissionRate: SELLER_PAYOUTS.commissionRate };
  }

  /** Every order of a tab, one CSV row per line of the seller's products. */
  async exportCsv(seller: Actor, tab: SellerOrderTab) {
    const ids = await this.productIds(seller);
    const rows = await this.prisma.order.findMany({
      where: { AND: [this.mine(ids), TAB_WHERE[tab]] },
      include: ORDER_INCLUDE,
      orderBy: { paidAt: 'desc' },
      take: 5000,
    });
    const head = ['order', 'placed', 'status', 'sku', 'product', 'qty', 'item_total', 'commission', 'you_earn', 'ship_to', 'carrier', 'tracking'];
    const lines = rows.flatMap((o) => {
      const s = this.summary(o, ids);
      return o.items
        .filter((i) => ids.includes(i.productId))
        .map((i) => {
          const fee = round2(i.lineTotal.mul(SELLER_PAYOUTS.commissionRate));
          return [
            o.orderNumber,
            o.paidAt?.toISOString() ?? '',
            s.statusLabel,
            i.sku,
            i.productName,
            String(i.quantity),
            i.lineTotal.toFixed(2),
            fee.toFixed(2),
            i.lineTotal.minus(fee).toFixed(2),
            `${o.shipCity} ${o.shipState}`,
            o.shipments[0]?.carrier ?? '',
            o.shipments[0]?.trackingNumber ?? '',
          ];
        });
    });
    return [head, ...lines].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  // ── One order ─────────────────────────────────────────────────────────────

  async get(seller: Actor, orderNumber: string) {
    const ids = await this.productIds(seller);
    const o = await this.find(ids, orderNumber);
    const s = this.summary(o, ids);
    const mine = o.items.filter((i) => ids.includes(i.productId));
    const ret = o.returns[0];
    // The full address and phone are for the packing slip: only while the seller has it to ship.
    const shipsIt = s.ownsAll && (TO_SHIP.includes(o.status) || o.status === 'SHIPPED');
    return {
      ...s,
      shipTo: {
        name: o.shipRecipientName,
        city: o.shipCity,
        state: o.shipState,
        postalCode: o.shipPostalCode,
        ...(shipsIt
          ? { addressLine1: o.shipAddressLine1, addressLine2: o.shipAddressLine2, country: o.shipCountry, phone: o.shipPhone }
          : {}),
      },
      lines: mine.map((i) => ({
        sku: i.sku,
        productName: i.productName,
        variantName: i.variantName,
        imageUrl: i.imageUrl,
        quantity: i.quantity,
        returnedQuantity: i.returnedQuantity,
        unitPrice: money(i.unitPrice),
        lineTotal: money(i.lineTotal),
      })),
      otherSellersLines: o.items.length - mine.length,
      shipment: o.shipments[0]
        ? { carrier: o.shipments[0].carrier, trackingNumber: o.shipments[0].trackingNumber, trackingUrl: o.shipments[0].trackingUrl, status: o.shipments[0].status }
        : null,
      return: ret
        ? { rmaNumber: ret.rmaNumber, status: ret.status, reason: ret.reason, requestedAt: ret.createdAt, refundedAt: ret.refundedAt }
        : null,
      cancellation: CLOSED.includes(o.status) && o.cancellationReason ? { reason: o.cancellationReason, by: o.cancelledBy, at: o.updatedAt } : null,
      actions: {
        ship: s.ownsAll && TO_SHIP.includes(o.status),
        cancel: s.ownsAll && TO_SHIP.includes(o.status),
        approveReturn: s.ownsAll && ret?.status === 'REQUESTED',
      },
    };
  }

  async ship(seller: Actor, orderNumber: string, input: z.output<typeof ShipSchema>) {
    const { order } = await this.owned(seller, orderNumber);
    await this.adminOrders.createShipment(order.id, { carrier: input.carrier, trackingNumber: input.trackingNumber.replace(/\s+/g, '') }, sellerActor(seller));
    return this.get(seller, orderNumber);
  }

  async cancel(seller: Actor, orderNumber: string, input: z.output<typeof SellerCancelSchema>) {
    const { order } = await this.owned(seller, orderNumber);
    if (!TO_SHIP.includes(order.status)) throw new InvalidOrderStateError('Only an order that has not shipped yet can be cancelled');
    const reason = `Seller cancelled: ${input.reason}${input.note ? ` (${input.note})` : ''}`.slice(0, 255);
    await this.adminOrders.cancel(order.id, { reason }, sellerActor(seller));
    return this.get(seller, orderNumber);
  }

  async approveReturn(seller: Actor, orderNumber: string, input: z.output<typeof ReturnApproveSchema>) {
    const { order } = await this.owned(seller, orderNumber);
    const ret = order.returns.find((r) => r.status === 'REQUESTED');
    if (!ret) throw new InvalidOrderStateError('This order has no return waiting for an answer');
    await this.adminReturns.act(ret.id, { action: 'APPROVE', note: input.note, restock: false, refundAmount: undefined }, sellerActor(seller));
    return this.get(seller, orderNumber);
  }

  // ── Earnings and payouts ──────────────────────────────────────────────────

  /** The Earnings & payouts tab: next payout, money on the way, this month, and payout history. */
  async payouts(seller: Actor) {
    const ids = await this.productIds(seller);
    const now = new Date();
    const unpaid = await this.prisma.order.findMany({
      where: { AND: [this.mine(ids), { status: { in: ['SHIPPED', 'DELIVERED'] } }, { payoutItems: { none: { merchantId: seller.id } } }] },
      include: ORDER_INCLUDE,
      orderBy: { deliveredAt: 'asc' },
    });
    const next = unpaid.filter((o) => payable(o));
    const waiting = unpaid.filter((o) => !payable(o));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const month = await this.prisma.order.findMany({
      where: { AND: [this.mine(ids), { paidAt: { gte: monthStart } }, { status: { notIn: CLOSED } }] },
      select: { id: true, items: { where: { productId: { in: ids }, deleted: false }, select: { lineTotal: true } } },
    });
    const history = await this.prisma.sellerPayout.findMany({ where: { merchantId: seller.id }, orderBy: { scheduledFor: 'desc' }, take: 52 });
    const fourWeeks = history.filter((p) => p.status === 'PAID' && p.paidAt && now.getTime() - p.paidAt.getTime() < 28 * DAY);
    const sum = (xs: Prisma.Decimal[]) => xs.reduce((a, b) => a.plus(b), new Prisma.Decimal(0));
    const earn = (o: OrderRow) => this.earnings(o, ids);
    return {
      commissionRate: SELLER_PAYOUTS.commissionRate,
      schedule: { payoutDay: 'Friday', cutoffDay: 'Sunday' },
      next: {
        scheduledFor: nextPayoutDate(now),
        amount: money(sum(next.map((o) => earn(o).net))),
        orders: next.map((o) => ({ orderNumber: o.orderNumber, deliveredAt: o.deliveredAt, ...moneyOf(earn(o)) })),
      },
      waiting: { amount: money(sum(waiting.map((o) => earn(o).net))), orders: waiting.length },
      month: { sales: money(sum(month.flatMap((o) => o.items.map((i) => i.lineTotal)))), orders: month.length },
      paidLastFourWeeks: { amount: money(sum(fourWeeks.map((p) => p.net))), payouts: fourWeeks.length },
      history: history.map((p) => ({
        reference: p.reference,
        status: p.status,
        scheduledFor: p.scheduledFor,
        paidAt: p.paidAt,
        periodFrom: p.periodFrom,
        periodTo: p.periodTo,
        orders: p.orders,
        sales: money(p.sales),
        commission: money(p.commission),
        refunds: money(p.refunds),
        net: money(p.net),
      })),
    };
  }

  /** One payout's statement: a CSV line per order. */
  async statementCsv(seller: Actor, reference: string) {
    const payout = await this.prisma.sellerPayout.findFirst({
      where: { reference, merchantId: seller.id },
      include: { items: { include: { order: { select: { orderNumber: true } } }, orderBy: { deliveredAt: 'asc' } } },
    });
    if (!payout) throw new DomainError(404, `Payout ${reference} was not found`);
    const head = ['payout', 'order', 'delivered', 'sales', 'commission', 'refunds', 'you_earn'];
    const rows = payout.items.map((i) => [payout.reference, i.order.orderNumber, i.deliveredAt.toISOString().slice(0, 10), i.sales.toFixed(2), i.commission.toFixed(2), i.refunds.toFixed(2), i.net.toFixed(2)]);
    rows.push([payout.reference, 'TOTAL', '', payout.sales.toFixed(2), payout.commission.toFixed(2), payout.refunds.toFixed(2), payout.net.toFixed(2)]);
    return { fileName: `statement-${payout.reference}.csv`, csv: [head, ...rows].map((r) => r.join(',')).join('\n') };
  }

  /**
   * Closes the week: for each seller, the orders delivered by the cutoff
   * (Sunday, end of day UTC) with no return open and not paid out yet become
   * one SCHEDULED payout for `asOf`'s Friday. Safe to run more than once: an
   * order is paid out once per seller (unique index), and a run finds nothing
   * new the second time.
   */
  async closeWeek(asOf = new Date()) {
    const cutoff = lastCutoff(asOf);
    const scheduledFor = payoutDateOn(asOf);
    const delivered = await this.prisma.order.findMany({
      where: { deleted: false, status: 'DELIVERED', deliveredAt: { lte: cutoff }, returns: { none: { status: { in: OPEN_RETURN } } } },
      include: {
        items: { where: { deleted: false } },
        returns: { include: { items: true } },
        payoutItems: { select: { merchantId: true } },
      },
    });
    const bySeller = new Map<string, { orderId: string; deliveredAt: Date; sales: Prisma.Decimal; refunds: Prisma.Decimal }[]>();
    for (const o of delivered) {
      const paid = new Set(o.payoutItems.map((p) => p.merchantId));
      const lines = new Map<string, typeof o.items>();
      for (const i of o.items) {
        const m = i.merchantId;
        if (paid.has(m)) continue;
        lines.set(m, [...(lines.get(m) ?? []), i]);
      }
      for (const [merchantId, items] of lines) {
        const sales = items.reduce((a, i) => a.plus(i.lineTotal), new Prisma.Decimal(0));
        const refunds = returnedValue(o.returns, items);
        bySeller.set(merchantId, [...(bySeller.get(merchantId) ?? []), { orderId: o.id, deliveredAt: o.deliveredAt!, sales, refunds }]);
      }
    }
    const created: string[] = [];
    for (const [merchantId, orders] of bySeller) {
      const items = orders.map((o) => ({ ...o, ...split(o.sales, o.refunds) }));
      const total = (k: 'sales' | 'refunds' | 'commission' | 'net') => items.reduce((a, i) => a.plus(i[k]), new Prisma.Decimal(0));
      const reference = await this.nextReference();
      await this.prisma.sellerPayout.create({
        data: {
          reference,
          merchantId,
          periodFrom: items.reduce((a, i) => (i.deliveredAt < a ? i.deliveredAt : a), items[0]!.deliveredAt),
          periodTo: cutoff,
          scheduledFor,
          status: 'SCHEDULED',
          orders: items.length,
          sales: total('sales'),
          commission: total('commission'),
          refunds: total('refunds'),
          net: total('net'),
          items: {
            create: items.map((i) => ({ merchantId, orderId: i.orderId, deliveredAt: i.deliveredAt, sales: i.sales, commission: i.commission, refunds: i.refunds, net: i.net })),
          },
        },
      });
      created.push(reference);
    }
    return { cutoff, scheduledFor, payouts: created };
  }

  /** Admin: payouts across sellers, newest first. */
  async adminPayouts(status: string | undefined, pageable: Pageable) {
    const where: Prisma.SellerPayoutWhereInput = status ? { status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.sellerPayout.findMany({
        where,
        include: { merchant: { select: { email: true, fullName: true } } },
        orderBy: [{ scheduledFor: 'desc' }, { reference: 'desc' }],
        skip: pageable.page * pageable.size,
        take: pageable.size,
      }),
      this.prisma.sellerPayout.count({ where }),
    ]);
    return toPage(
      rows.map((p) => ({
        reference: p.reference,
        seller: p.merchant.fullName || p.merchant.email,
        sellerEmail: p.merchant.email,
        status: p.status,
        scheduledFor: p.scheduledFor,
        paidAt: p.paidAt,
        paidBy: p.paidBy,
        orders: p.orders,
        sales: money(p.sales),
        commission: money(p.commission),
        refunds: money(p.refunds),
        net: money(p.net),
      })),
      total,
      pageable,
    );
  }

  /** Admin: the money was sent. */
  async markPaid(reference: string, actor: string) {
    const { count } = await this.prisma.sellerPayout.updateMany({
      where: { reference, status: 'SCHEDULED' },
      data: { status: 'PAID', paidAt: new Date(), paidBy: actor },
    });
    if (count === 0) {
      const exists = await this.prisma.sellerPayout.findUnique({ where: { reference } });
      throw exists ? new InvalidOrderStateError(`Payout ${reference} is already paid`) : new DomainError(404, `Payout ${reference} was not found`);
    }
    return { reference, status: 'PAID' };
  }

  /** For the dashboard: tab counts, late and due-today orders, open returns. */
  async overview(seller: Actor) {
    const ids = await this.productIds(seller);
    const base = this.mine(ids);
    const [counts, stats, toShip] = await Promise.all([
      this.counts(base),
      this.stats(base, ids),
      this.prisma.order.findMany({ where: { AND: [base, TAB_WHERE.new] }, include: ORDER_INCLUDE, orderBy: { paidAt: 'asc' }, take: 20 }),
    ]);
    const returns = await this.prisma.order.findMany({
      where: { AND: [base, { returns: { some: { status: 'REQUESTED' } } }] },
      include: ORDER_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    return { counts, stats, toShip: toShip.map((o) => this.summary(o, ids)), returnsRequested: returns.map((o) => this.summary(o, ids)) };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private mine(ids: string[]): Prisma.OrderWhereInput {
    return { deleted: false, paidAt: { not: null }, items: { some: { productId: { in: ids }, deleted: false } } };
  }

  private async counts(base: Prisma.OrderWhereInput) {
    const entries = await Promise.all(
      SELLER_ORDER_TABS.map(async (t) => [t, await this.prisma.order.count({ where: { AND: [base, TAB_WHERE[t]] } })] as const),
    );
    return Object.fromEntries(entries) as Record<SellerOrderTab, number>;
  }

  private async stats(base: Prisma.OrderWhereInput, ids: string[]) {
    const now = Date.now();
    const toShip = await this.prisma.order.findMany({ where: { AND: [base, TAB_WHERE.new] }, select: { paidAt: true } });
    const due = toShip.map((o) => o.paidAt!.getTime() + SELLER_PAYOUTS.shipWithinHours * HOUR);
    const delivered30 = await this.prisma.order.findMany({
      where: { AND: [base, { status: 'DELIVERED', deliveredAt: { gte: new Date(now - 30 * DAY) } }] },
      select: { items: { where: { productId: { in: ids }, deleted: false }, select: { lineTotal: true } } },
    });
    return {
      late: due.filter((d) => d < now).length,
      dueToday: due.filter((d) => d >= now && d - now < 12 * HOUR).length,
      delivered30Days: delivered30.length,
      delivered30DaysSales: money(delivered30.flatMap((o) => o.items).reduce((a, i) => a.plus(i.lineTotal), new Prisma.Decimal(0))),
    };
  }

  private summary(o: OrderRow, ids: string[]) {
    const mine = o.items.filter((i) => ids.includes(i.productId));
    const e = this.earnings(o, ids);
    const ret = o.returns[0];
    const openReturn = ret && OPEN_RETURN.includes(ret.status);
    const state: string = CLOSED.includes(o.status)
      ? 'cancelled'
      : openReturn
        ? 'return'
        : ret?.status === 'REFUNDED'
          ? 'returned'
          : TO_SHIP.includes(o.status)
            ? 'new'
            : o.status === 'SHIPPED'
              ? 'shipped'
              : 'delivered';
    const shipBy = o.paidAt ? new Date(o.paidAt.getTime() + SELLER_PAYOUTS.shipWithinHours * HOUR) : null;
    const payout = o.payoutItems.find(() => true)?.payout;
    return {
      orderNumber: o.orderNumber,
      paidAt: o.paidAt,
      state,
      statusLabel: STATE_LABEL[state] ?? state,
      status: o.status,
      shipBy: state === 'new' ? shipBy : null,
      shippedAt: o.shippedAt,
      deliveredAt: o.deliveredAt,
      carrier: o.shipments[0]?.carrier ?? null,
      shipToCity: o.shipCity,
      shipToState: o.shipState,
      returnReason: openReturn ? ret.reason : null,
      cancellationReason: state === 'cancelled' ? o.cancellationReason : null,
      items: mine.map((i) => ({ sku: i.sku, productName: i.productName, variantName: i.variantName, imageUrl: i.imageUrl, quantity: i.quantity })),
      units: mine.reduce((a, i) => a + i.quantity, 0),
      ...moneyOf(e),
      ownsAll: mine.length === o.items.length,
      payout: payout
        ? { reference: payout.reference, status: payout.status, scheduledFor: payout.scheduledFor, paidAt: payout.paidAt }
        : { reference: null, status: payable(o) ? 'NEXT' : state === 'cancelled' || state === 'returned' ? 'NONE' : 'AFTER_DELIVERY', scheduledFor: payable(o) ? nextPayoutDate(new Date()) : null, paidAt: null },
    };
  }

  /** The seller's lines: sales, refunds (cancelled order = all; else returned units), commission and net. */
  private earnings(o: OrderRow, ids: string[]) {
    const mine = o.items.filter((i) => ids.includes(i.productId));
    const sales = mine.reduce((a, i) => a.plus(i.lineTotal), new Prisma.Decimal(0));
    const refunds = CLOSED.includes(o.status) ? sales : returnedValue(o.returns.filter((r) => r.status === 'REFUNDED'), mine);
    return { sales, refunds, ...split(sales, refunds) };
  }

  private async find(ids: string[], orderNumber: string) {
    const o = await this.prisma.order.findFirst({ where: { AND: [this.mine(ids), { orderNumber }] }, include: ORDER_INCLUDE });
    if (!o) throw new DomainError(404, `Order ${orderNumber} was not found`);
    return o;
  }

  /** The order, when every line is the seller's: only then can they act on it. */
  private async owned(seller: Actor, orderNumber: string) {
    const ids = await this.productIds(seller);
    const order = await this.find(ids, orderNumber);
    if (order.items.some((i) => !ids.includes(i.productId))) {
      throw new DomainError(409, 'This order includes other sellers’ items, so our team handles it. Raise a ticket if something needs doing.');
    }
    return { order, ids };
  }

  private async productIds(seller: Actor) {
    return (await this.prisma.product.findMany({ where: { parent: { merchantId: seller.id } }, select: { id: true } })).map((p) => p.id);
  }

  private async nextReference() {
    const last = await this.prisma.sellerPayout.findFirst({ orderBy: { createdAt: 'desc' }, select: { reference: true } });
    const n = last ? Number(last.reference.replace(/\D/g, '')) || 1000 : 1000;
    return `PO-${n + 1}`;
  }
}

const STATE_LABEL: Record<string, string> = {
  new: 'To ship',
  shipped: 'Shipped',
  delivered: 'Delivered',
  return: 'Return requested',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

const sellerActor = (seller: Actor) => `${seller.email} (seller)`;

/** Delivered, with no return open: goes in the next payout. */
function payable(o: { status: string; deliveredAt: Date | null; returns: { status: string }[] }) {
  return o.status === 'DELIVERED' && !!o.deliveredAt && !o.returns.some((r) => OPEN_RETURN.includes(r.status));
}

/** Value of the refunded returned units among these lines. */
function returnedValue(returns: { status: string; items: { orderItemId: string; quantity: number }[] }[], lines: { id: string; unitPrice: Prisma.Decimal }[]) {
  const price = new Map(lines.map((l) => [l.id, l.unitPrice]));
  let total = new Prisma.Decimal(0);
  for (const r of returns.filter((x) => x.status === 'REFUNDED')) {
    for (const i of r.items) {
      const p = price.get(i.orderItemId);
      if (p) total = total.plus(p.mul(i.quantity));
    }
  }
  return total;
}

/** Commission on what the customer kept; the seller earns the rest. */
function split(sales: Prisma.Decimal, refunds: Prisma.Decimal) {
  const kept = Prisma.Decimal.max(sales.minus(refunds), 0);
  const commission = round2(kept.mul(SELLER_PAYOUTS.commissionRate));
  return { commission, net: kept.minus(commission) };
}

function moneyOf(e: { sales: Prisma.Decimal; refunds: Prisma.Decimal; commission: Prisma.Decimal; net: Prisma.Decimal }) {
  return { sales: money(e.sales), refunds: money(e.refunds), commission: money(e.commission), net: money(e.net) };
}

/** The end (23:59:59.999 UTC) of the last Sunday before `asOf`. */
export function lastCutoff(asOf: Date) {
  const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const back = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return new Date(d.getTime() - back * DAY + DAY - 1);
}

/** The Friday of `asOf`'s week (Monday to Sunday, UTC), as a date. */
export function payoutDateOn(asOf: Date) {
  const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return new Date(d.getTime() + (5 - dow) * DAY);
}

/** The coming Friday (today when it's Friday). */
export function nextPayoutDate(now: Date) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(d.getTime() + ((5 - d.getUTCDay() + 7) % 7) * DAY);
}
