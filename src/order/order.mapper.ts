import {
  Prisma,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderReturn,
  type OrderReturnItem,
  type Shipment,
  type ShipmentEvent,
} from '@prisma/client';
import { money } from '../common/api-response';
import type { Config } from '../config';
import { estimatedDeliveryFor, round2 } from './pricing';

// Order JSON for customers (Order, OrderSummary, TrackedOrder in
// ecom-ui/src/types/api/order.types.ts). The pieces (shipments, returns,
// timeline) are exported for the admin views, which build on them.

export type OrderWithItems = Order & { items: OrderItem[] };

export const ORDER_ITEMS_INCLUDE = {
  items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

/** Everything the full order view shows: lines, timeline, shipments with their events, returns. */
export const ORDER_DETAIL_INCLUDE = {
  items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
  shipments: { orderBy: { createdAt: 'asc' }, include: { events: { orderBy: { occurredAt: 'desc' } } } },
  returns: { orderBy: { createdAt: 'asc' }, include: { items: true } },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;

/** List rows: lines for the thumbnails, and the newest shipment for the tracking link. */
export const ORDER_SUMMARY_INCLUDE = {
  items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } },
  shipments: { orderBy: { createdAt: 'desc' }, take: 1 },
} satisfies Prisma.OrderInclude;

export type OrderSummaryRow = Prisma.OrderGetPayload<{ include: typeof ORDER_SUMMARY_INCLUDE }>;

/** Store settings the order view depends on (delivery estimates, return window, tax mode). */
export interface OrderView {
  shipping: Config['shipping'];
  returnWindowDays: number;
  pricesIncludeTax: boolean;
}

export function orderView(config: Config): OrderView {
  return {
    shipping: config.shipping,
    returnWindowDays: config.returns.windowDays,
    pricesIncludeTax: config.pricing.pricesIncludeTax,
  };
}

const NO_DELIVERY = new Set(['CANCELLED', 'PAYMENT_FAILED', 'REFUNDED']);

/** Business-day delivery window; null for orders that will never arrive or have no method. */
export function deliveryWindow(o: Order, view: OrderView | undefined) {
  if (!view || NO_DELIVERY.has(o.status)) return null;
  return estimatedDeliveryFor(o, view.shipping);
}

/** deliveredAt + the return window; null until delivered. */
export function returnableUntil(o: Pick<Order, 'deliveredAt'>, view: Pick<OrderView, 'returnWindowDays'> | undefined) {
  if (!o.deliveredAt || !view) return null;
  return new Date(o.deliveredAt.getTime() + view.returnWindowDays * 86_400_000);
}

export function toShippingAddress(o: Order) {
  return {
    recipientName: o.shipRecipientName,
    phone: o.shipPhone,
    addressLine1: o.shipAddressLine1,
    addressLine2: o.shipAddressLine2,
    city: o.shipCity,
    state: o.shipState,
    postalCode: o.shipPostalCode,
    country: o.shipCountry,
  };
}

export function toOrderItemResponse(i: OrderItem, parentId: string | null = null) {
  return {
    id: i.id,
    productId: i.productId,
    parentId,
    merchantId: i.merchantId,
    productName: i.productName,
    sku: i.sku,
    variantName: i.variantName,
    color: i.color,
    size: i.size,
    imageUrl: i.imageUrl,
    unitPrice: money(i.unitPrice),
    quantity: i.quantity,
    lineTotal: money(i.lineTotal),
    taxCode: i.taxCode,
    taxRate: Number(i.taxRate),
    taxAmount: money(i.taxAmount),
    returnedQuantity: i.returnedQuantity,
  };
}

/**
 * Timeline entries, oldest first. `customerView` hides staff identities
 * (`ADMIN:ops@example.com` → `ADMIN`).
 */
export function toTimeline(events: OrderEvent[], options: { customerView?: boolean } = {}) {
  return events.map((e) => {
    const actor = e.actor ?? 'SYSTEM';
    return {
      status: e.status ?? '',
      fulfilmentStatus: e.fulfilmentStatus,
      note: e.note,
      actor: options.customerView ? actor.split(':')[0] : actor,
      at: e.createdAt,
    };
  });
}

export function toShipmentResponse(s: Shipment & { events?: ShipmentEvent[] }) {
  return {
    id: s.id,
    provider: s.provider,
    carrier: s.carrier ?? s.provider,
    service: s.service,
    trackingNumber: s.trackingNumber ?? '',
    trackingUrl: s.trackingUrl,
    status: s.status,
    deliveredAt: s.deliveredAt,
    createdAt: s.createdAt,
    // Newest first.
    events: [...(s.events ?? [])]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .map((e) => ({ status: e.status, description: e.description, location: e.location, occurredAt: e.occurredAt })),
  };
}

/**
 * What returning these units refunds: their price plus the tax charged on
 * them (pro rata per line). Included tax is already in the price. Shipping is
 * never refunded by a return.
 */
export function estimatedRefund(
  items: { orderItemId: string; quantity: number }[],
  orderItems: OrderItem[],
  pricesIncludeTax = false,
): Prisma.Decimal {
  const byId = new Map(orderItems.map((i) => [i.id, i]));
  let total = new Prisma.Decimal(0);
  for (const r of items) {
    const line = byId.get(r.orderItemId);
    if (!line || line.quantity <= 0) continue;
    total = total.add(line.unitPrice.mul(r.quantity));
    if (!pricesIncludeTax) total = total.add(round2(line.taxAmount.mul(r.quantity).div(line.quantity)));
  }
  return round2(total);
}

export function toReturnResponse(
  r: OrderReturn & { items: OrderReturnItem[] },
  orderItems: OrderItem[],
  view?: Pick<OrderView, 'pricesIncludeTax'>,
) {
  const items = r.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity }));
  return {
    id: r.id,
    rmaNumber: r.rmaNumber,
    status: r.status,
    reason: r.reason,
    method: r.method,
    requestedBy: r.requestedBy,
    refundAmount: r.refundAmount === null ? null : money(r.refundAmount),
    estimatedRefund: money(estimatedRefund(items, orderItems, view?.pricesIncludeTax ?? false)),
    restocked: r.restocked,
    items,
    createdAt: r.createdAt,
    receivedAt: r.receivedAt,
    refundedAt: r.refundedAt,
  };
}

/**
 * The full order (customer `Order`). Accepts a bare order-with-items too (the
 * relations then read as empty). Without `view`, the delivery estimate and
 * return window are null.
 */
export function toOrderResponse(
  o: OrderWithItems & Partial<Pick<OrderDetail, 'events' | 'shipments' | 'returns'>>,
  view?: OrderView,
  options: { customerView?: boolean; parentIds?: Map<string, string> } = {},
) {
  const events = o.events ?? [];
  const timeline = events.length
    ? toTimeline(events, options)
    : // Orders placed before the timeline existed.
      [{ status: 'PENDING_PAYMENT', fulfilmentStatus: null, note: 'Order placed', actor: o.userId ? 'CUSTOMER' : 'GUEST', at: o.createdAt }];
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    fulfilmentStatus: o.fulfilmentStatus,
    currency: o.currency,
    subtotal: money(o.subtotal),
    taxTotal: money(o.taxTotal),
    shippingTotal: money(o.shippingTotal),
    discountTotal: money(o.discountTotal),
    grandTotal: money(o.grandTotal),
    refundedTotal: money(o.refundedTotal),
    shippingMethod: o.shippingMethod,
    paymentStatus: o.paymentStatus,
    customerEmail: o.customerEmail,
    guest: o.userId === null,
    estimatedDelivery: deliveryWindow(o, view),
    shippingAddress: toShippingAddress(o),
    items: o.items.map((i) => toOrderItemResponse(i, options.parentIds?.get(i.productId) ?? null)),
    timeline,
    shipments: (o.shipments ?? []).map(toShipmentResponse),
    returns: (o.returns ?? []).map((r) => toReturnResponse(r, o.items, view)),
    returnableUntil: returnableUntil(o, view),
    paidAt: o.paidAt,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** Account order list row (`OrderSummary`). */
export function toOrderSummaryResponse(o: OrderSummaryRow, view?: OrderView) {
  const latest = o.shipments[0];
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    fulfilmentStatus: o.fulfilmentStatus,
    currency: o.currency,
    grandTotal: money(o.grandTotal),
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    createdAt: o.createdAt,
    deliveredAt: o.deliveredAt,
    estimatedDelivery: deliveryWindow(o, view),
    shipToName: o.shipRecipientName,
    items: o.items.map(toSummaryItem),
    latestShipment: latest
      ? {
          carrier: latest.carrier ?? latest.provider,
          trackingNumber: latest.trackingNumber ?? '',
          trackingUrl: latest.trackingUrl,
          status: latest.status,
        }
      : null,
    returnableUntil: returnableUntil(o, view),
  };
}

function toSummaryItem(i: OrderItem) {
  return {
    productId: i.productId,
    productName: i.productName,
    variantName: i.variantName,
    color: i.color,
    size: i.size,
    imageUrl: i.imageUrl,
    quantity: i.quantity,
  };
}

/** Guest tracking view (`TrackedOrder`): no prices, no street address. */
export function toTrackedOrder(o: OrderDetail, view: OrderView) {
  return {
    orderNumber: o.orderNumber,
    status: o.status,
    fulfilmentStatus: o.fulfilmentStatus,
    createdAt: o.createdAt,
    shippingMethod: o.shippingMethod,
    estimatedDelivery: deliveryWindow(o, view),
    deliveredAt: o.deliveredAt,
    items: o.items.map(toSummaryItemNoId),
    shipments: o.shipments.map(toShipmentResponse),
    timeline: toOrderResponse(o, view, { customerView: true }).timeline,
    shipTo: { city: o.shipCity, state: o.shipState, postalCode5: postalCode5(o.shipPostalCode) },
  };
}

function toSummaryItemNoId(i: Omit<OrderItem, 'productId'>) {
  return {
    productName: i.productName,
    variantName: i.variantName,
    color: i.color,
    size: i.size,
    imageUrl: i.imageUrl,
    quantity: i.quantity,
  };
}

/** First five digits of a US ZIP ("97214-1234" → "97214"). */
export function postalCode5(postalCode: string): string {
  return postalCode.replace(/\D/g, '').slice(0, 5);
}

export type OrderResponse = ReturnType<typeof toOrderResponse>;

export interface CheckoutResponse {
  order: OrderResponse;
  /** Only ever returned at checkout, never persisted; null under the manual gateway. */
  clientSecret: string | null;
}
