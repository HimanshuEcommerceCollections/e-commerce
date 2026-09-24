import type { Order, OrderItem, Prisma } from '@prisma/client';
import { money } from '../common/api-response';

export type OrderWithItems = Order & { items: OrderItem[] };

export const ORDER_ITEMS_INCLUDE = {
  items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

export function toOrderResponse(o: OrderWithItems) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    currency: o.currency,
    subtotal: money(o.subtotal),
    taxTotal: money(o.taxTotal),
    shippingTotal: money(o.shippingTotal),
    discountTotal: money(o.discountTotal),
    grandTotal: money(o.grandTotal),
    paymentStatus: o.paymentStatus,
    shippingAddress: {
      recipientName: o.shipRecipientName,
      phone: o.shipPhone,
      addressLine1: o.shipAddressLine1,
      addressLine2: o.shipAddressLine2,
      city: o.shipCity,
      state: o.shipState,
      postalCode: o.shipPostalCode,
      country: o.shipCountry,
    },
    items: o.items.map((i) => ({
      productId: i.productId,
      merchantId: i.merchantId,
      productName: i.productName,
      sku: i.sku,
      unitPrice: money(i.unitPrice),
      quantity: i.quantity,
      lineTotal: money(i.lineTotal),
    })),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** List view without line items. */
export function toOrderSummaryResponse(o: Order) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    currency: o.currency,
    grandTotal: money(o.grandTotal),
    createdAt: o.createdAt,
  };
}

export type OrderResponse = ReturnType<typeof toOrderResponse>;

export interface CheckoutResponse {
  order: OrderResponse;
  /** Only ever returned at checkout, never persisted; null under the manual gateway. */
  clientSecret: string | null;
}
