import type { CancellationActor } from '../common/enums';
import type { Db } from '../db';

// ── Atomic state transitions ────────────────────────────────────────────────
// Every transition that releases stock or confirms money is a guarded UPDATE
// whose WHERE clause arbitrates the race: of any set of concurrent writers
// (customer cancel, webhook, expiry job, admin, a second instance) exactly one
// gets 1 back, and only that caller may apply the side effect — restocking
// twice would corrupt inventory.

/** Claim PENDING_PAYMENT → CANCELLED. The winner (and only the winner) restocks. */
export function claimPendingCancellation(db: Db, orderId: string, reason: string, actor: CancellationActor) {
  return db.$executeRaw`
    UPDATE orders
       SET status = 'CANCELLED', cancellation_reason = ${reason}, cancelled_by = ${actor}, updated_at = now()
     WHERE id = ${orderId}::uuid AND status = 'PENDING_PAYMENT' AND deleted = false`;
}

/**
 * Claim a paid, unshipped order's cancel+refund (PAID|CONFIRMED → CANCELLED,
 * payment → REFUNDED). Shared by customer cancel-with-refund and the
 * charge.refunded reconciliation, so the two can never both restock.
 */
export function claimRefundCancellation(db: Db, orderId: string, reason: string, actor: CancellationActor) {
  return db.$executeRaw`
    UPDATE orders
       SET status = 'CANCELLED', payment_status = 'REFUNDED',
           cancellation_reason = ${reason}, cancelled_by = ${actor}, updated_at = now()
     WHERE id = ${orderId}::uuid AND status IN ('PAID', 'CONFIRMED')
       AND payment_status IS DISTINCT FROM 'REFUNDED' AND deleted = false`;
}

/** Record a refund on an already-CANCELLED order (its stock already went back). */
export function markRefundedOnCancelled(db: Db, orderId: string) {
  return db.$executeRaw`
    UPDATE orders SET payment_status = 'REFUNDED', updated_at = now()
     WHERE id = ${orderId}::uuid AND status = 'CANCELLED'
       AND payment_status IS DISTINCT FROM 'REFUNDED' AND deleted = false`;
}

/** Claim PENDING_PAYMENT → PAID for the admin manual-confirmation path. */
export function claimManualPaid(db: Db, orderId: string) {
  return db.$executeRaw`
    UPDATE orders SET status = 'PAID', payment_status = 'SUCCEEDED', updated_at = now()
     WHERE id = ${orderId}::uuid AND status = 'PENDING_PAYMENT' AND deleted = false`;
}

// ── Stock movements ─────────────────────────────────────────────────────────

/**
 * Atomic conditional decrement (NFR-08): the `stock_quantity >= qty` guard makes
 * check-and-decrement one statement, so concurrent checkouts of the last units
 * can never oversell. 0 means gone, inactive, or not enough stock.
 */
export function decrementStock(db: Db, productId: string, qty: number) {
  return db.$executeRaw`
    UPDATE products SET stock_quantity = stock_quantity - ${qty}
     WHERE id = ${productId}::uuid AND deleted = false AND status = 'ACTIVE' AND stock_quantity >= ${qty}`;
}

/** Return units to stock — on cancellation, expiry or refund. */
export function incrementStock(db: Db, productId: string, qty: number) {
  return db.$executeRaw`UPDATE products SET stock_quantity = stock_quantity + ${qty} WHERE id = ${productId}::uuid`;
}

export async function restock(db: Db, items: { productId: string; quantity: number }[]) {
  for (const item of items) await incrementStock(db, item.productId, item.quantity);
}
