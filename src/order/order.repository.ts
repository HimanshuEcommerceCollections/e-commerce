import type { CancellationActor, StockMovementSource } from '../common/enums';
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
       SET status = 'CANCELLED', payment_status = 'REFUNDED', refunded_total = grand_total,
           cancellation_reason = ${reason}, cancelled_by = ${actor}, updated_at = now()
     WHERE id = ${orderId}::uuid AND status IN ('PAID', 'CONFIRMED')
       AND payment_status IS DISTINCT FROM 'REFUNDED' AND deleted = false`;
}

/** Record a refund on an already-CANCELLED order (its stock already went back). */
export function markRefundedOnCancelled(db: Db, orderId: string) {
  return db.$executeRaw`
    UPDATE orders SET payment_status = 'REFUNDED', refunded_total = grand_total, updated_at = now()
     WHERE id = ${orderId}::uuid AND status = 'CANCELLED'
       AND payment_status IS DISTINCT FROM 'REFUNDED' AND deleted = false`;
}

/**
 * Claim PENDING_PAYMENT → PAID (admin manual confirmation, or a verified
 * provider event). Payment starts fulfilment: paid_at is stamped and the order
 * joins the UNFULFILLED queue. The winner alone writes the timeline entry,
 * the email and the PURCHASE event.
 */
export function claimPaid(db: Db, orderId: string) {
  return db.$executeRaw`
    UPDATE orders
       SET status = 'PAID', payment_status = 'SUCCEEDED', paid_at = now(),
           fulfilment_status = COALESCE(fulfilment_status, 'UNFULFILLED'), updated_at = now()
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

export interface MovementContext {
  source: StockMovementSource;
  reason: string;
  actor: string;
}

function recordMovement(db: Db, productId: string, delta: number, quantityAfter: number, m: MovementContext) {
  return db.stockMovement.create({
    data: {
      productId,
      delta,
      quantityAfter,
      source: m.source,
      reason: m.reason.slice(0, 500),
      actor: m.actor.slice(0, 255),
    },
  });
}

/**
 * The same guarded decrement, logging a stock movement with the quantity it
 * left (the UPDATE's row lock makes that exact). False when the units are gone.
 */
export async function takeStock(db: Db, productId: string, qty: number, movement: MovementContext): Promise<boolean> {
  const rows = await db.$queryRaw<{ stock_quantity: number }[]>`
    UPDATE products SET stock_quantity = stock_quantity - ${qty}
     WHERE id = ${productId}::uuid AND deleted = false AND status = 'ACTIVE' AND stock_quantity >= ${qty}
     RETURNING stock_quantity`;
  if (!rows.length) return false;
  await recordMovement(db, productId, -qty, rows[0].stock_quantity, movement);
  return true;
}

/** Return units to stock — on cancellation, expiry or refund — logging each movement. */
export async function restock(
  db: Db,
  items: { productId: string; quantity: number }[],
  movement: MovementContext = { source: 'CANCELLATION', reason: 'Order cancelled', actor: 'SYSTEM' },
) {
  for (const item of items) {
    const rows = await db.$queryRaw<{ stock_quantity: number }[]>`
      UPDATE products SET stock_quantity = stock_quantity + ${item.quantity}
       WHERE id = ${item.productId}::uuid
       RETURNING stock_quantity`;
    if (rows.length) await recordMovement(db, item.productId, item.quantity, rows[0].stock_quantity, movement);
  }
}

/** Lock an order row for the rest of the transaction. */
export function lockOrderRow(db: Db, orderId: string) {
  return db.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${orderId}::uuid AND deleted = false FOR UPDATE`;
}
