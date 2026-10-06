import type { Order, OrderItem } from '@prisma/client';
import type { MailMessage } from '../notify/mailer';

/**
 * Plain-text customer messages for the order lifecycle the storefront drives
 * (placed, paid, cancelled, return requested). The store name and the web
 * client's URL come from config.
 */
export interface MailContext {
  storeName: string;
  appBaseUrl: string;
}

type OrderForMail = Pick<Order, 'id' | 'orderNumber' | 'userId' | 'customerEmail' | 'currency' | 'grandTotal'> & {
  items?: Pick<OrderItem, 'productName' | 'variantName' | 'quantity'>[];
};

const lines = (o: OrderForMail) =>
  (o.items ?? []).map((i) => `  ${i.quantity} × ${i.productName}${i.variantName ? ` (${i.variantName})` : ''}`).join('\n');

/** Signed-in orders link to the account page; guest orders to the tracking form. */
const orderLink = (o: OrderForMail, ctx: MailContext) =>
  o.userId
    ? `${ctx.appBaseUrl}/account/orders/${o.orderNumber}`
    : `${ctx.appBaseUrl}/track?o=${encodeURIComponent(o.orderNumber)}`;

function base(o: OrderForMail): Pick<MailMessage, 'to' | 'orderId' | 'userId'> {
  return { to: o.customerEmail ?? '', orderId: o.id, userId: o.userId };
}

export function orderPlacedMail(o: OrderForMail, ctx: MailContext): MailMessage {
  return {
    ...base(o),
    template: 'ORDER_CONFIRMATION',
    subject: `${ctx.storeName}: order ${o.orderNumber} received`,
    body:
      `Thanks for your order ${o.orderNumber}.\n\n${lines(o)}\n\n` +
      `Total: ${o.grandTotal.toFixed(2)} ${o.currency}\n\n` +
      `We'll email you again once payment is confirmed. Track it any time: ${orderLink(o, ctx)}`,
  };
}

export function paymentReceivedMail(o: OrderForMail, ctx: MailContext): MailMessage {
  return {
    ...base(o),
    template: 'PAYMENT_RECEIVED',
    subject: `${ctx.storeName}: payment received for ${o.orderNumber}`,
    body:
      `We've received your payment of ${o.grandTotal.toFixed(2)} ${o.currency} for order ${o.orderNumber}. ` +
      `We're getting it ready to ship.\n\nTrack it: ${orderLink(o, ctx)}`,
  };
}

export function orderCancelledMail(o: OrderForMail, ctx: MailContext, refunded: boolean): MailMessage {
  return {
    ...base(o),
    template: 'ORDER_CANCELLED',
    subject: `${ctx.storeName}: order ${o.orderNumber} cancelled`,
    body:
      `Your order ${o.orderNumber} has been cancelled.` +
      (refunded ? ` A refund of ${o.grandTotal.toFixed(2)} ${o.currency} is on its way to your original payment method.` : '') +
      `\n\n${orderLink(o, ctx)}`,
  };
}

export function returnRequestedMail(o: OrderForMail, ctx: MailContext, rmaNumber: string): MailMessage {
  return {
    ...base(o),
    template: 'RETURN_REQUESTED',
    subject: `${ctx.storeName}: return ${rmaNumber} requested`,
    body:
      `We've received your return request ${rmaNumber} for order ${o.orderNumber}. ` +
      `We'll review it and email you the next steps.\n\n${orderLink(o, ctx)}`,
  };
}
