import { Prisma } from '@prisma/client';
import { logger } from '../common/logger';
import type { Db } from '../db';
import { recordOrderEvent } from '../order/order-events';
import type { OrderWithItems } from '../order/order.mapper';
import { claimRefundCancellation, markRefundedOnCancelled, restock } from '../order/order.repository';
import { toMinorUnits } from '../payment/money-units';
import { raiseRefundedTotal } from './order-ops.repository';

const log = logger('refunds');

/**
 * Applies a provider-reported refund (Stripe `charge.refunded`, whose amount
 * is the cumulative total refunded on the payment) to an order. Run inside a
 * transaction.
 *
 * Refunds we issued ourselves — cancellations, returns — are already in
 * `refunded_total`, so their echo is a no-op; only money refunded elsewhere
 * (the provider dashboard) is added. Never double counts:
 *  - full refund of a paid, unshipped order: the cancellation claim shared
 *    with customer/admin cancel, so exactly one of them restocks;
 *  - already cancelled: only the refund is recorded;
 *  - anything else (partial, or after shipping): the refunded total rises to
 *    the reported amount; stock is untouched (the goods are with the customer
 *    or still in the order).
 */
export async function reconcileProviderRefund(db: Db, order: OrderWithItems, amountRefundedMinor: bigint) {
  const recorded = toMinorUnits(order.refundedTotal, order.currency);
  if (amountRefundedMinor <= recorded) return; // our own refund, echoed back

  const total = toMinorUnits(order.grandTotal, order.currency);
  if (amountRefundedMinor >= total && (order.status === 'PAID' || order.status === 'CONFIRMED')) {
    if ((await claimRefundCancellation(db, order.id, 'Refunded at the payment provider', 'GATEWAY')) === 1) {
      await restock(db, order.items, {
        source: 'CANCELLATION',
        reason: `Order ${order.orderNumber}: refunded at the provider`,
        actor: 'GATEWAY',
      });
      await recordOrderEvent(db, order.id, { status: 'CANCELLED', note: 'Refunded at the payment provider', actor: 'GATEWAY' });
      log.info(`Order ${order.orderNumber} reconciled as fully refunded`);
      return;
    }
  }
  if (amountRefundedMinor >= total && order.status === 'CANCELLED') {
    // Stock already went back with the cancellation.
    if ((await markRefundedOnCancelled(db, order.id)) === 1) {
      await recordOrderEvent(db, order.id, { status: 'CANCELLED', note: 'Refund confirmed by the payment provider', actor: 'GATEWAY' });
    }
    log.info(`Order ${order.orderNumber} marked refunded (was already cancelled)`);
    return;
  }

  const unit = toMinorUnits(new Prisma.Decimal(1), order.currency);
  const cumulative = new Prisma.Decimal(amountRefundedMinor.toString()).div(unit.toString());
  const outcome = await raiseRefundedTotal(db, order.id, cumulative);
  if (!outcome) return;
  await recordOrderEvent(db, order.id, {
    status: outcome.status === order.status ? null : outcome.status,
    note: `Refund recorded from the payment provider (total refunded ${outcome.refundedTotal.toFixed(2)} ${order.currency})`,
    actor: 'GATEWAY',
  });
  log.info(`Order ${order.orderNumber}: provider refund raised the refunded total to ${outcome.refundedTotal.toFixed(2)}`);
}
