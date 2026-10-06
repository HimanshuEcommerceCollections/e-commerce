import { Prisma, type PrismaClient } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';
import { money } from '../common/api-response';
import {
  FULFILMENT_STATUSES,
  SHIPMENT_STATUSES,
  type FulfilmentStatus,
  type NotificationTemplate,
  type OrderStatus,
  type ShipmentStatus,
} from '../common/enums';
import { DomainError, InvalidOrderStateError, OrderNotFoundError } from '../common/errors';
import { logger } from '../common/logger';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { isUuid, oneOf, optionalString } from '../common/validation';
import type { Config } from '../config';
import { TX, type Db } from '../db';
import type { Mailer } from '../notify/mailer';
import { recordOrderEvent } from '../order/order-events';
import { normalizeOrderNumber } from '../order/order-number';
import { ORDER_DETAIL_INCLUDE, orderView, toOrderResponse, toShipmentResponse } from '../order/order.mapper';
import { claimPendingCancellation, claimRefundCancellation, lockOrderRow, restock } from '../order/order.repository';
import type { OrderService } from '../order/order.service';
import type { PaymentGateway } from '../payment/gateway';
import type { ShippingProvider } from '../shipping/shipping-provider';
import { claimConfirmed, claimDelivered, claimFulfilmentStep, claimShipped } from './order-ops.repository';

const log = logger('admin-orders');

export const ADMIN_ORDER_SORTS = ['createdAt', 'updatedAt', 'paidAt', 'grandTotal', 'orderNumber', 'status'] as const;

/** A required enum value (oneOf alone lets null through). */
const requiredOneOf = <T extends string>(values: readonly T[]) =>
  oneOf(values).refine((v) => v !== undefined, 'must not be null') as unknown as z.ZodType<T>;

export const FulfilmentStepSchema = z.object({
  status: requiredOneOf(['PICKED', 'PACKED'] as const),
  note: optionalString({ max: 1000 }),
});

export const CreateShipmentSchema = z.object({
  carrier: optionalString({ max: 100 }),
  service: optionalString({ max: 100 }),
  trackingNumber: optionalString({
    max: 100,
    pattern: /^[A-Za-z0-9][A-Za-z0-9 -]*$/,
    patternMessage: 'must contain only letters, digits, spaces and dashes',
  }),
  trackingUrl: optionalString({ max: 2048, pattern: /^https?:\/\/\S+$/, patternMessage: 'must be an http(s) URL' }),
});

const TRACKING_EVENT_STATUSES = SHIPMENT_STATUSES.filter((s) => s !== 'LABEL_CREATED');

export const TrackingEventSchema = z.object({
  status: requiredOneOf(TRACKING_EVENT_STATUSES),
  description: optionalString({ max: 500 }),
  location: optionalString({ max: 200 }),
  occurredAt: optionalString({ max: 40 }).refine(
    (v) => v === undefined || !Number.isNaN(Date.parse(v)),
    'must be an ISO-8601 date-time',
  ),
});

export const AdminCancelSchema = z.object({
  reason: optionalString({ max: 255 }),
});

export interface AdminOrderFilter {
  search?: string;
  status?: string;
  fulfilmentStatus?: string;
}

/** Statuses an admin may still cancel: nothing has left the warehouse. */
const CANCELLABLE: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED'];
const FULFILLABLE: OrderStatus[] = ['PAID', 'CONFIRMED'];

/** Forward-only fulfilment: the steps a target may come from. */
const STEP_FROM: Record<'PICKED' | 'PACKED', FulfilmentStatus[]> = {
  PICKED: ['UNFULFILLED'],
  PACKED: ['UNFULFILLED', 'PICKED'],
};

const LIST_INCLUDE = {
  items: { where: { deleted: false }, select: { quantity: true } },
  shipments: { orderBy: { createdAt: 'asc' }, select: { carrier: true, provider: true, trackingNumber: true, status: true } },
  user: { select: { fullName: true, email: true } },
} satisfies Prisma.OrderInclude;

type ListRow = Prisma.OrderGetPayload<{ include: typeof LIST_INCLUDE }>;

const EXPORT_LIMIT = 50_000;

/**
 * Order operations for the admin panel (FR-AD-02/04/07, FR-IN-03/04): the
 * order list and detail, manual payment, fulfilment steps, shipments and
 * tracking, and admin cancellation with refund and restock. Every state
 * change is a guarded UPDATE (order-ops.repository.ts) plus a timeline entry
 * in the same transaction; customer emails go out after commit.
 */
export class AdminOrderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: PaymentGateway,
    private readonly orders: OrderService,
    private readonly shipping: ShippingProvider,
    private readonly mailer: Mailer,
    private readonly config: Config,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(filter: AdminOrderFilter, pageable: Pageable) {
    const where = orderWhere(filter);
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({ where, include: LIST_INCLUDE, orderBy: orderBy(pageable), ...skipTake(pageable) }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(rows.map(toListRow), total, pageable);
  }

  async stats() {
    const [byStatus, awaiting, returns] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { deleted: false }, _count: { _all: true } }),
      this.prisma.order.groupBy({
        by: ['fulfilmentStatus'],
        where: { deleted: false, status: { in: FULFILLABLE } },
        _count: { _all: true },
      }),
      this.prisma.orderReturn.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const awaitingFulfilment: Partial<Record<'UNFULFILLED' | 'PICKED' | 'PACKED', number>> = {};
    for (const g of awaiting) {
      // A paid order without a fulfilment status yet is unfulfilled.
      const key = (g.fulfilmentStatus ?? 'UNFULFILLED') as 'UNFULFILLED' | 'PICKED' | 'PACKED';
      if (key === 'UNFULFILLED' || key === 'PICKED' || key === 'PACKED') {
        awaitingFulfilment[key] = (awaitingFulfilment[key] ?? 0) + g._count._all;
      }
    }
    return {
      total: byStatus.reduce((n, g) => n + g._count._all, 0),
      byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
      awaitingFulfilment,
      returnsByStatus: Object.fromEntries(returns.map((g) => [g.status, g._count._all])),
    };
  }

  /** CSV of every order matching the filters (newest first). */
  async exportCsv(filter: AdminOrderFilter, sort: Pageable['sort']) {
    const rows = await this.prisma.order.findMany({
      where: orderWhere(filter),
      include: LIST_INCLUDE,
      orderBy: sort.length ? orderBy({ page: 0, size: 1, sort }) : [{ createdAt: 'desc' }],
      take: EXPORT_LIMIT,
    });
    const header = [
      'Order number', 'Created', 'Status', 'Fulfilment', 'Payment', 'Customer', 'Email', 'Guest',
      'City', 'State', 'Items', 'Subtotal', 'Tax', 'Shipping', 'Total', 'Refunded', 'Currency',
      'Shipping method', 'Carrier', 'Tracking', 'Paid at', 'Shipped at', 'Delivered at',
    ];
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const body = rows.map((o) => [
      o.orderNumber,
      iso(o.createdAt),
      o.status,
      o.fulfilmentStatus ?? '',
      o.paymentStatus ?? '',
      o.user?.fullName ?? o.shipRecipientName,
      o.user?.email ?? o.customerEmail ?? '',
      o.userId ? 'no' : 'yes',
      o.shipCity,
      o.shipState,
      o.items.reduce((n, i) => n + i.quantity, 0),
      o.subtotal.toFixed(2),
      o.taxTotal.toFixed(2),
      o.shippingTotal.toFixed(2),
      o.grandTotal.toFixed(2),
      o.refundedTotal.toFixed(2),
      o.currency,
      o.shippingMethod ?? '',
      o.shipments.map((s) => s.carrier ?? s.provider).join('; '),
      o.shipments.map((s) => s.trackingNumber ?? '').join('; '),
      iso(o.paidAt),
      iso(o.shippedAt),
      iso(o.deliveredAt),
    ]);
    return stringify([header, ...body]);
  }

  /** AdminOrderDetail. Accepts the order id or its number (EC-4821907). */
  async get(idOrNumber: string) {
    const where: Prisma.OrderWhereInput = isUuid(idOrNumber)
      ? { id: idOrNumber.toLowerCase(), deleted: false }
      : { orderNumber: normalizeOrderNumber(idOrNumber), deleted: false };
    const order = await this.prisma.order.findFirst({
      where,
      include: {
        ...ORDER_DETAIL_INCLUDE,
        user: { select: { id: true, fullName: true, email: true, phoneNumber: true } },
        notifications: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!order) throw new OrderNotFoundError(idOrNumber);

    const [customerOrders, variants] = await Promise.all([
      // A guest is identified by the checkout email (user_id is null).
      this.prisma.order.count({
        where: order.userId
          ? { userId: order.userId, deleted: false }
          : { userId: null, customerEmail: order.customerEmail, deleted: false },
      }),
      this.prisma.product.findMany({
        where: { id: { in: order.items.map((i) => i.productId) } },
        select: { id: true, parentId: true },
      }),
    ]);
    const base = toOrderResponse(order, orderView(this.config), {
      parentIds: new Map(variants.map((v) => [v.id, v.parentId])),
    });
    const customer = order.user
      ? { ...order.user, guest: false }
      : {
          id: null,
          fullName: order.shipRecipientName,
          email: order.customerEmail ?? '',
          phoneNumber: order.shipPhone,
          guest: true,
        };
    return {
      ...base,
      paymentReference: order.paymentReference,
      shipments: order.shipments.map(toAdminShipment),
      notifications: order.notifications.map((n) => ({
        template: n.template,
        subject: n.subject,
        status: n.status,
        toAddress: n.toAddress,
        createdAt: n.createdAt,
      })),
      customer: { ...customer, orders: customerOrders },
      cancellationReason: order.cancellationReason,
      cancelledBy: order.cancelledBy,
    };
  }

  // ── Payment (manual gateway) ─────────────────────────────────────────────

  /** PENDING_PAYMENT → PAID; the order module owns payment bookkeeping. */
  async markPaid(orderId: string, actor: string) {
    await this.orders.markPaid(orderId, actor);
    return this.get(orderId);
  }

  // ── Fulfilment (FR-AD-02) ────────────────────────────────────────────────

  /** PICKED or PACKED, forward only, paid orders only. The first step confirms the order. */
  async fulfilmentStep(orderId: string, input: z.output<typeof FulfilmentStepSchema>, actor: string) {
    const to = input.status;
    await this.prisma.$transaction(async (tx) => {
      if ((await claimFulfilmentStep(tx, orderId, to, STEP_FROM[to])) === 0) {
        const current = await findOrder(tx, orderId);
        if (!FULFILLABLE.includes(current.status as OrderStatus)) {
          throw new InvalidOrderStateError(
            `Only a paid order that hasn't shipped can be fulfilled (current: ${current.status})`,
          );
        }
        throw new InvalidOrderStateError(
          `Fulfilment can't go from ${current.fulfilmentStatus ?? 'UNFULFILLED'} to ${to}`,
        );
      }
      const confirmed = (await claimConfirmed(tx, orderId)) === 1;
      await recordOrderEvent(tx, orderId, {
        status: confirmed ? 'CONFIRMED' : null,
        fulfilmentStatus: to,
        note: input.note ?? (to === 'PICKED' ? 'Items picked' : 'Packed and ready to ship'),
        actor,
      });
    }, TX.default);
    const order = await findOrder(this.prisma, orderId);
    return { id: order.id, status: order.status, fulfilmentStatus: order.fulfilmentStatus };
  }

  // ── Shipping (FR-IN-03/04) ───────────────────────────────────────────────

  /**
   * Books the shipment with the shipping provider, then marks the order
   * SHIPPED. The provider is called outside the transaction (a real carrier
   * API is slow); the guarded claim afterwards decides whether the shipment
   * is kept.
   */
  async createShipment(orderId: string, input: z.output<typeof CreateShipmentSchema>, actor: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deleted: false },
      include: { items: { where: { deleted: false } }, user: { select: { email: true } } },
    });
    if (!order) throw new OrderNotFoundError(orderId);
    if (!FULFILLABLE.includes(order.status as OrderStatus)) {
      throw new InvalidOrderStateError(`Only a paid order that hasn't shipped can be shipped (current: ${order.status})`);
    }

    const label = await this.shipping.createShipment({
      orderNumber: order.orderNumber,
      carrier: input.carrier,
      service: input.service,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl,
      shipTo: {
        name: order.shipRecipientName,
        phone: order.shipPhone,
        addressLine1: order.shipAddressLine1,
        addressLine2: order.shipAddressLine2,
        city: order.shipCity,
        state: order.shipState,
        postalCode: order.shipPostalCode,
        country: order.shipCountry,
      },
      items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity - i.returnedQuantity })),
    });

    const shipment = await this.prisma.$transaction(async (tx) => {
      if ((await claimShipped(tx, orderId)) === 0) {
        // A real provider would void the label here.
        const current = await findOrder(tx, orderId);
        throw new InvalidOrderStateError(`Only a paid order that hasn't shipped can be shipped (current: ${current.status})`);
      }
      const created = await tx.shipment.create({
        data: {
          orderId,
          provider: this.shipping.name,
          carrier: label.carrier,
          service: label.service,
          trackingNumber: label.trackingNumber,
          trackingUrl: label.trackingUrl,
          labelUrl: label.labelUrl,
          providerReference: label.providerReference,
          status: 'LABEL_CREATED',
          events: {
            create: { status: 'LABEL_CREATED', description: 'Shipping label created', occurredAt: new Date() },
          },
        },
        include: { events: true },
      });
      await recordOrderEvent(tx, orderId, {
        status: 'SHIPPED',
        fulfilmentStatus: 'SHIPPED',
        note: `Shipped with ${label.carrier} (${label.trackingNumber})`,
        actor,
      });
      return created;
    }, TX.default);

    await this.notify(order, 'ORDER_SHIPPED', `Your order ${order.orderNumber} has shipped`, [
      `Good news: your order ${order.orderNumber} is on its way.`,
      `Carrier: ${label.carrier}${label.service ? ` (${label.service})` : ''}`,
      `Tracking number: ${label.trackingNumber}`,
      label.trackingUrl ? `Track it: ${label.trackingUrl}` : `Track it: ${this.config.store.appBaseUrl}/track?o=${order.orderNumber}`,
    ]);
    return toAdminShipment(shipment);
  }

  /**
   * A carrier scan entered by hand (or, later, pushed by the provider). A
   * DELIVERED scan delivers the order. A delivered shipment takes no more scans.
   */
  async addTrackingEvent(shipmentId: string, input: z.output<typeof TrackingEventSchema>, actor: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { order: { include: { user: { select: { email: true } } } } },
    });
    if (!shipment || shipment.order.deleted) throw new DomainError(404, `Shipment ${shipmentId} was not found`);
    const status = input.status as ShipmentStatus;
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const order = shipment.order;

    const delivered = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.shipment.updateMany({
        where: { id: shipmentId, status: { not: 'DELIVERED' } },
        data: { status, ...(status === 'DELIVERED' ? { deliveredAt: occurredAt } : {}) },
      });
      if (count === 0) throw new InvalidOrderStateError('This shipment has already been delivered');
      await tx.shipmentEvent.create({
        data: {
          shipmentId,
          status,
          description: input.description ?? DEFAULT_SCAN_TEXT[status],
          location: input.location ?? null,
          occurredAt,
        },
      });
      if (status !== 'DELIVERED') return false;
      if ((await claimDelivered(tx, order.id, occurredAt)) === 0) return false;
      await recordOrderEvent(tx, order.id, {
        status: 'DELIVERED',
        fulfilmentStatus: 'DELIVERED',
        note: input.description ?? 'Delivered',
        actor,
      });
      return true;
    }, TX.default);

    if (delivered) {
      await this.notify(order, 'ORDER_DELIVERED', `Your order ${order.orderNumber} was delivered`, [
        `Your order ${order.orderNumber} was delivered${input.location ? ` (${input.location})` : ''}.`,
        `Something not right? You can return items within ${this.config.returns.windowDays} days: ${this.config.store.appBaseUrl}/account`,
      ]);
    }
    const updated = await this.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { events: true } });
    return toAdminShipment(updated);
  }

  // ── Cancellation (FR-AD-04) ──────────────────────────────────────────────

  /**
   * Admin cancel of an unshipped order. A paid order is refunded through the
   * gateway first (if that fails nothing changes); stock goes back exactly
   * once — the claims are shared with customer cancel, the expiry job and
   * the payment webhooks (NFR-08). The row lock serialises concurrent admin
   * cancels so the gateway is asked once.
   */
  async cancel(orderId: string, input: z.output<typeof AdminCancelSchema>, actor: string) {
    const reason = input.reason?.trim() || 'Cancelled by admin';
    const result = await this.prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, orderId);
      const order = await tx.order.findFirst({
        where: { id: orderId, deleted: false },
        include: { items: { where: { deleted: false } }, user: { select: { email: true } } },
      });
      if (!order) throw new OrderNotFoundError(orderId);
      if (!CANCELLABLE.includes(order.status as OrderStatus)) {
        throw new InvalidOrderStateError(`An order with status ${order.status} can no longer be cancelled`);
      }

      let claimed: number;
      let refunded: Prisma.Decimal | null = null;
      if (order.status === 'PENDING_PAYMENT') {
        if (order.paymentIntentId && !(await this.gateway.cancelPayment(order.paymentIntentId))) {
          throw new InvalidOrderStateError('Payment for this order is completing — wait for the result, then cancel');
        }
        claimed = await claimPendingCancellation(tx, orderId, reason, 'ADMIN');
      } else {
        const due = order.grandTotal.sub(order.refundedTotal);
        const reference = order.paymentIntentId ?? order.paymentReference;
        if (due.gt(0) && reference) {
          const refundRef = await this.gateway.refund(reference, due, order.currency);
          log.info(`Refund ${refundRef} issued for cancelled order ${order.orderNumber}`);
          refunded = due;
        }
        // Also records refunded_total = grand_total.
        claimed = await claimRefundCancellation(tx, orderId, reason, 'ADMIN');
      }
      if (claimed === 0) {
        const current = await findOrder(tx, orderId);
        throw new InvalidOrderStateError(`An order with status ${current.status} can no longer be cancelled`);
      }
      await restock(tx, order.items, { source: 'CANCELLATION', reason: `Order ${order.orderNumber} cancelled`, actor });
      await recordOrderEvent(tx, orderId, {
        status: 'CANCELLED',
        note: refunded ? `${reason} — refunded ${refunded.toFixed(2)} ${order.currency}` : reason,
        actor,
      });
      return { order, refunded };
    }, TX.checkout);

    const { order, refunded } = result;
    await this.notify(order, 'ORDER_CANCELLED', `Your order ${order.orderNumber} was cancelled`, [
      `Your order ${order.orderNumber} has been cancelled.`,
      refunded
        ? `We've refunded ${refunded.toFixed(2)} ${order.currency} to your original payment method; it can take 5–10 business days to appear.`
        : 'You have not been charged.',
    ]);
    return this.get(orderId);
  }

  private async notify(
    order: { id: string; orderNumber: string; userId: string | null; customerEmail: string | null; user: { email: string } | null },
    template: NotificationTemplate,
    subject: string,
    lines: string[],
  ) {
    const to = order.customerEmail ?? order.user?.email;
    if (!to) return;
    await this.mailer.send({
      template,
      to,
      subject,
      body: [...lines, '', this.config.store.name].join('\n'),
      orderId: order.id,
      userId: order.userId,
    });
  }
}

const DEFAULT_SCAN_TEXT: Record<ShipmentStatus, string> = {
  LABEL_CREATED: 'Shipping label created',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  EXCEPTION: 'Delivery exception',
  RETURNED: 'Returned to sender',
};

async function findOrder(db: Db, orderId: string) {
  const order = await db.order.findFirst({ where: { id: orderId, deleted: false } });
  if (!order) throw new OrderNotFoundError(orderId);
  return order;
}

export function toAdminShipment(s: Parameters<typeof toShipmentResponse>[0]) {
  return { ...toShipmentResponse(s), labelUrl: s.labelUrl, providerReference: s.providerReference };
}

function orderWhere(f: AdminOrderFilter): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [{ deleted: false }];
  if (f.status) and.push({ status: f.status });
  if (f.fulfilmentStatus) {
    // A paid order not yet started reads as UNFULFILLED.
    and.push(
      f.fulfilmentStatus === 'UNFULFILLED'
        ? { OR: [{ fulfilmentStatus: 'UNFULFILLED' }, { fulfilmentStatus: null, status: { in: FULFILLABLE } }] }
        : { fulfilmentStatus: f.fulfilmentStatus },
    );
  }
  const q = f.search?.trim();
  if (q) {
    const contains = { contains: q, mode: 'insensitive' } as const;
    and.push({
      OR: [
        { orderNumber: contains },
        { orderNumber: { contains: normalizeOrderNumber(q), mode: 'insensitive' } },
        { customerEmail: contains },
        { shipRecipientName: contains },
        { user: { fullName: contains } },
        { user: { email: contains } },
        { shipments: { some: { trackingNumber: contains } } },
      ],
    });
  }
  return { AND: and };
}

export const isFulfilmentStatus = (v: string) => (FULFILMENT_STATUSES as readonly string[]).includes(v);

function toListRow(o: ListRow) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    fulfilmentStatus: o.fulfilmentStatus,
    paymentStatus: o.paymentStatus,
    currency: o.currency,
    grandTotal: money(o.grandTotal),
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    shippingMethod: o.shippingMethod,
    tracking: o.shipments.map((s) => ({
      carrier: s.carrier ?? s.provider,
      trackingNumber: s.trackingNumber ?? '',
      status: s.status,
    })),
    // Guest orders (no user) show the ship-to name and checkout email.
    customer: {
      name: o.user?.fullName ?? o.shipRecipientName,
      email: o.user?.email ?? o.customerEmail ?? '',
      city: o.shipCity,
      state: o.shipState,
    },
    createdAt: o.createdAt,
  };
}
