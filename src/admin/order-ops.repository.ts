import { Prisma } from '@prisma/client';
import type { FulfilmentStatus } from '../common/enums';
import type { Db } from '../db';

// Guarded state changes for fulfilment, shipping, returns and refunds — the
// same rule as src/order/order.repository.ts: every transition is one UPDATE
// whose WHERE clause decides the race, and only a caller that gets 1 back may
// apply the side effect (a timeline entry, an email, a restock).

/** Orders that hold money and stock but haven't left the warehouse. */
const FULFILLABLE = Prisma.sql`status IN ('PAID', 'CONFIRMED')`;

/**
 * Move fulfilment forward to `to` (PICKED or PACKED) from one of `from`
 * (null counts as UNFULFILLED: a paid order before its first step).
 */
export function claimFulfilmentStep(db: Db, orderId: string, to: FulfilmentStatus, from: FulfilmentStatus[]) {
  return db.$executeRaw`
    UPDATE orders SET fulfilment_status = ${to}, updated_at = now()
     WHERE id = ${orderId}::uuid AND deleted = false AND ${FULFILLABLE}
       AND (fulfilment_status IS NULL OR fulfilment_status IN (${Prisma.join(from)}))`;
}

/** PAID → CONFIRMED once fulfilment starts. 1 only for the call that changed it. */
export function claimConfirmed(db: Db, orderId: string) {
  return db.$executeRaw`
    UPDATE orders SET status = 'CONFIRMED', updated_at = now()
     WHERE id = ${orderId}::uuid AND status = 'PAID' AND deleted = false`;
}

/** PAID|CONFIRMED → SHIPPED with its timestamp. */
export function claimShipped(db: Db, orderId: string) {
  return db.$executeRaw`
    UPDATE orders SET status = 'SHIPPED', fulfilment_status = 'SHIPPED', shipped_at = now(), updated_at = now()
     WHERE id = ${orderId}::uuid AND deleted = false AND ${FULFILLABLE}`;
}

/** SHIPPED → DELIVERED at the carrier's delivery time. */
export function claimDelivered(db: Db, orderId: string, at: Date) {
  return db.$executeRaw`
    UPDATE orders SET status = 'DELIVERED', fulfilment_status = 'DELIVERED', delivered_at = ${at}, updated_at = now()
     WHERE id = ${orderId}::uuid AND status = 'SHIPPED' AND deleted = false`;
}

export interface RefundOutcome {
  status: string;
  paymentStatus: string;
  refundedTotal: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
}

/**
 * Add `amount` to the order's refunded total, never past the grand total. A
 * full refund marks the payment REFUNDED and a shipped or delivered order
 * REFUNDED; anything less is PARTIALLY_REFUNDED. Null when the amount would
 * exceed what's left (the caller lost a race or asked for too much).
 */
export async function addRefund(db: Db, orderId: string, amount: Prisma.Decimal): Promise<RefundOutcome | null> {
  const rows = await db.$queryRaw<RefundOutcome[]>`
    UPDATE orders
       SET refunded_total = refunded_total + ${amount},
           payment_status = CASE WHEN refunded_total + ${amount} >= grand_total THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
           status = CASE WHEN refunded_total + ${amount} >= grand_total AND status IN ('SHIPPED', 'DELIVERED')
                         THEN 'REFUNDED' ELSE status END,
           updated_at = now()
     WHERE id = ${orderId}::uuid AND deleted = false AND refunded_total + ${amount} <= grand_total
     RETURNING status, payment_status AS "paymentStatus", refunded_total AS "refundedTotal", grand_total AS "grandTotal"`;
  return rows[0] ?? null;
}

/**
 * Provider-reported cumulative refund (Stripe charge.refunded): raise the
 * refunded total to `cumulative` when it is higher than what we recorded.
 * Refunds we issued ourselves are already counted, so their echo changes nothing.
 */
export async function raiseRefundedTotal(db: Db, orderId: string, cumulative: Prisma.Decimal): Promise<RefundOutcome | null> {
  const rows = await db.$queryRaw<RefundOutcome[]>`
    UPDATE orders
       SET refunded_total = LEAST(${cumulative}, grand_total),
           payment_status = CASE WHEN ${cumulative} >= grand_total THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
           status = CASE WHEN ${cumulative} >= grand_total AND status IN ('SHIPPED', 'DELIVERED')
                         THEN 'REFUNDED' ELSE status END,
           updated_at = now()
     WHERE id = ${orderId}::uuid AND deleted = false AND refunded_total < ${cumulative}
     RETURNING status, payment_status AS "paymentStatus", refunded_total AS "refundedTotal", grand_total AS "grandTotal"`;
  return rows[0] ?? null;
}

/** Count units as back from the customer, never more than were bought. */
export function addReturnedQuantity(db: Db, orderItemId: string, qty: number) {
  return db.$executeRaw`
    UPDATE order_items SET returned_quantity = returned_quantity + ${qty}, updated_at = now()
     WHERE id = ${orderItemId}::uuid AND returned_quantity + ${qty} <= quantity`;
}
