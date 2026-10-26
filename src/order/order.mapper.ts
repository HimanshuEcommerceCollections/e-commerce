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

/** List rows: lines for the thumbnails, the newest shipment for the tracking link, returns for "Return by". */
export const ORDER_SUMMARY_INCLUDE = {
  items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } },
  shipments: { orderBy: { createdAt: 'desc' }, take: 1 },
  returns: { orderBy: { createdAt: 'asc' }, include: { items: true } },
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

/** Return requests count against a line unless rejected. */
export const LIVE_RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED'];

/** Units of a line the customer can still send back: bought minus returned or already requested. */
export function returnableQuantity(item: OrderItem, returns: (OrderReturn & { items: OrderReturnItem[] })[]) {
  const requested = returns
    .filter((r) => LIVE_RETURN_STATUSES.includes(r.status))
    .flatMap((r) => r.items)
    .filter((ri) => ri.orderItemId === item.id)
    .reduce((n, ri) => n + ri.quantity, 0);
  return Math.max(0, item.quantity - Math.max(item.returnedQuantity, requested));
}

/** A delivered order inside its return window with at least one unit left to return. */
export function hasReturnableItems(
  o: Pick<Order, 'status' | 'deliveredAt'> & { items: OrderItem[]; returns?: (OrderReturn & { items: OrderReturnItem[] })[] },
  view: Pick<OrderView, 'returnWindowDays'> | undefined,
  now = Date.now(),
) {
  const until = returnableUntil(o, view);
  if (o.status !== 'DELIVERED' || !until || until.getTime() < now) return false;
  return o.items.some((i) => returnableQuantity(i, o.returns ?? []) > 0);
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

/** "Visa •••• 4242": what paid for the order, once payment succeeded. */
export function toPaymentMethod(o: Pick<Order, 'paymentMethodType' | 'cardBrand' | 'cardLast4'>) {
  return o.paymentMethodType ? { type: o.paymentMethodType, brand: o.cardBrand, last4: o.cardLast4 } : null;
}

/** Promo, savings, payment method and billing (contract B3), for the full order and the list row. */
export function orderSnapshots(o: Order) {
  return {
    promoCode: o.promoCode,
    savingsTotal: money(o.savingsTotal),
    payment: toPaymentMethod(o),
    billingSameAsShipping: o.billSameAsShipping,
  };
}

export function toOrderItemResponse(i: OrderItem, parentId: string | null = null, productSlug: string | null = null) {
  return {
    id: i.id,
    productId: i.productId,
    parentId,
    productSlug,
    mrp: i.mrp === null ? null : money(i.mrp),
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

/** Returns travel by UPS (no carrier integration yet: the code is shown at the counter). */
export const RETURN_CARRIER = 'UPS';

/** Progress for the return tracker: 0 Started, 1 Dropped off, 2 Received, 3 Refunded. */
export function returnStep(r: Pick<OrderReturn, 'status' | 'droppedOffAt'>): 0 | 1 | 2 | 3 {
  if (r.status === 'REFUNDED') return 3;
  if (r.status === 'RECEIVED') return 2;
  return r.droppedOffAt ? 1 : 0;
}

/** A return (`ReturnRequest`): lines with their snapshot and value, drop-off/pickup logistics, refund target. */
export function toReturnResponse(
  r: OrderReturn & { items: OrderReturnItem[] },
  orderItems: OrderItem[],
  view?: Pick<OrderView, 'pricesIncludeTax'>,
  order?: Pick<Order, 'orderNumber'>,
) {
  const includeTax = view?.pricesIncludeTax ?? false;
  const byId = new Map(orderItems.map((i) => [i.id, i]));
  const items = r.items.map((i) => {
    const line = byId.get(i.orderItemId);
    return {
      orderItemId: i.orderItemId,
      quantity: i.quantity,
      productId: line?.productId ?? null,
      productName: line?.productName ?? '',
      imageUrl: line?.imageUrl ?? null,
      color: line?.color ?? null,
      size: line?.size ?? null,
      amount: money(estimatedRefund([i], orderItems, includeTax)),
    };
  });
  return {
    id: r.id,
    rmaNumber: r.rmaNumber,
    orderId: r.orderId,
    orderNumber: order?.orderNumber ?? null,
    status: r.status,
    reason: r.reason,
    method: r.method,
    requestedBy: r.requestedBy,
    refundTo: r.refundTo,
    refundAmount: r.refundAmount === null ? null : money(r.refundAmount),
    estimatedRefund: money(estimatedRefund(r.items, orderItems, includeTax)),
    restocked: r.restocked,
    items,
    carrier: RETURN_CARRIER,
    step: returnStep(r),
    dropoffCode: r.dropoffCode,
    dropoffBy: r.dropoffBy,
    droppedOffAt: r.droppedOffAt,
    // A calendar date (date column): "2026-10-24".
    pickupDate: r.pickupDate ? r.pickupDate.toISOString().slice(0, 10) : null,
    pickupWindow: r.pickupWindow,
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
  options: { customerView?: boolean; parentIds?: Map<string, string>; slugs?: Map<string, string> } = {},
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
    ...orderSnapshots(o),
    shippingMethod: o.shippingMethod,
    paymentStatus: o.paymentStatus,
    customerEmail: o.customerEmail,
    guest: o.userId === null,
    estimatedDelivery: deliveryWindow(o, view),
    shippingAddress: toShippingAddress(o),
    items: o.items.map((i) =>
      toOrderItemResponse(i, options.parentIds?.get(i.productId) ?? null, options.slugs?.get(i.productId) ?? null),
    ),
    hasReturnableItems: hasReturnableItems(o, view),
    timeline,
    shipments: (o.shipments ?? []).map(toShipmentResponse),
    returns: (o.returns ?? []).map((r) => toReturnResponse(r, o.items, view, o)),
    returnableUntil: returnableUntil(o, view),
    paidAt: o.paidAt,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** Account order list row (`OrderSummary`). */
export function toOrderSummaryResponse(
  o: OrderSummaryRow,
  view?: OrderView,
  refs?: Map<string, { parentId: string; slug: string }>,
) {
  const latest = o.shipments[0];
  const returnable = hasReturnableItems(o, view);
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    fulfilmentStatus: o.fulfilmentStatus,
    currency: o.currency,
    grandTotal: money(o.grandTotal),
    ...orderSnapshots(o),
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    createdAt: o.createdAt,
    deliveredAt: o.deliveredAt,
    estimatedDelivery: deliveryWindow(o, view),
    shipToName: o.shipRecipientName,
    items: o.items.map((i) => ({
      ...toSummaryItem(i),
      parentId: refs?.get(i.productId)?.parentId ?? null,
      productSlug: refs?.get(i.productId)?.slug ?? null,
    })),
    latestShipment: latest
      ? {
          carrier: latest.carrier ?? latest.provider,
          trackingNumber: latest.trackingNumber ?? '',
          trackingUrl: latest.trackingUrl,
          status: latest.status,
        }
      : null,
    returnableUntil: returnableUntil(o, view),
    hasReturnableItems: returnable,
    // "Return by <date>" on the row, only while something can still go back.
    returnBy: returnable ? returnableUntil(o, view) : null,
    returns: o.returns.map((r) => ({ id: r.id, rmaNumber: r.rmaNumber, status: r.status })),
  };
}

function toSummaryItem(i: OrderItem) {
  return {
    productId: i.productId,
    mrp: i.mrp === null ? null : money(i.mrp),
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
