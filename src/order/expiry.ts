import type { PrismaClient } from '@prisma/client';
import { logger } from '../common/logger';
import { TX } from '../db';
import type { PaymentGateway } from '../payment/gateway';
import { ORDER_ITEMS_INCLUDE } from './order.mapper';
import { claimPendingCancellation, restock } from './order.repository';

const log = logger('order-expiry');

/**
 * Releases stock held by abandoned checkouts. Checkout reserves stock before
 * payment, so a PENDING_PAYMENT order whose customer walked away would hold it
 * forever; this cancels such orders (and their PaymentIntents) past a
 * configurable age.
 *
 * Runs only when the gateway supports automatic expiry (Stripe): manual-gateway
 * orders legitimately wait for an admin. Safe on several instances — the
 * per-order atomic claim makes duplicate scans harmless.
 */
export class OrderExpiryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: PaymentGateway,
    private readonly expiryMinutes: number,
  ) {}

  /** One scan: expire up to 50 stale orders, each in its own transaction. */
  async expireAbandonedOrders(): Promise<number> {
    if (this.expiryMinutes <= 0 || !this.gateway.supportsAutomaticExpiry()) return 0;

    const cutoff = new Date(Date.now() - this.expiryMinutes * 60_000);
    const stale = await this.prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT', deleted: false, createdAt: { lt: cutoff } },
      select: { id: true, orderNumber: true },
      take: 50,
    });

    let expired = 0;
    for (const order of stale) {
      try {
        if (await this.expire(order.id)) expired++;
      } catch (e) {
        // One bad order (say, a gateway hiccup) must not block the batch.
        log.error(`Failed to expire order ${order.orderNumber}`, e);
      }
    }
    if (expired > 0) log.info(`Expired ${expired} abandoned pending order(s)`);
    return expired;
  }

  /**
   * Cancel and restock one stale order: cancel the PaymentIntent FIRST — if the
   * provider says it is processing or succeeded, skip and let the success
   * webhook win — then atomically claim the order; only the winner restocks.
   * @returns true if this call expired the order
   */
  expire(orderId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: orderId, deleted: false }, include: ORDER_ITEMS_INCLUDE });
      if (!order || order.status !== 'PENDING_PAYMENT') return false;

      if (order.paymentIntentId && !(await this.gateway.cancelPayment(order.paymentIntentId))) {
        log.info(`Skipping expiry of order ${order.orderNumber} — payment is completing at the provider`);
        return false;
      }
      if ((await claimPendingCancellation(tx, orderId, 'Expired before payment', 'SYSTEM_EXPIRY')) === 0) {
        return false;
      }
      await restock(tx, order.items);
      log.info(`Expired abandoned order ${order.orderNumber} and released its stock`);
      return true;
    }, TX.checkout);
  }
}

/** Runs the scan every `intervalMs` after the previous one finishes (fixed delay). */
export function startExpiryJob(service: OrderExpiryService, intervalMs: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      await service.expireAbandonedOrders();
    } catch (e) {
      log.error('Pending-order expiry scan failed', e);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
