import { createHash, randomInt } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { OrderStatus } from '../common/enums';
import {
  AddressNotFoundError,
  EmptyCartError,
  IdempotencyKeyConflictError,
  InvalidIdempotencyKeyError,
  InvalidOrderStateError,
  OrderNotFoundError,
  OutOfStockError,
  PaymentAmountMismatchError,
  ProductUnavailableError,
} from '../common/errors';
import { isIntegrityViolation } from '../common/error-handler';
import { logger } from '../common/logger';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { requiredUuid } from '../common/validation';
import { TX, type Db } from '../db';
import type { PaymentEventHandler, PaymentGateway } from '../payment/gateway';
import { toMinorUnits } from '../payment/money-units';
import {
  ORDER_ITEMS_INCLUDE,
  toOrderResponse,
  toOrderSummaryResponse,
  type CheckoutResponse,
  type OrderWithItems,
} from './order.mapper';
import {
  claimManualPaid,
  claimPendingCancellation,
  claimRefundCancellation,
  decrementStock,
  markRefundedOnCancelled,
  restock,
} from './order.repository';

const log = logger('orders');

export const CheckoutSchema = z.object({
  addressId: requiredUuid('Shipping address id is required'),
});

export const ORDER_SORTS = ['createdAt', 'updatedAt', 'orderNumber', 'grandTotal', 'status'] as const;

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export class OrderService implements PaymentEventHandler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: PaymentGateway,
    private readonly currency: string,
  ) {}

  // ── Checkout ─────────────────────────────────────────────────────────────

  /**
   * Checkout with Idempotency-Key semantics:
   *  1. an order already created under (user, key) is replayed as-is (422 if
   *     the key was reused with a different request);
   *  2. otherwise checkout runs with the key stamped on the order;
   *  3. if two same-key requests race, uniq_orders_user_idempotency_key fails
   *     the loser's insert (its whole transaction, stock decrements included,
   *     rolls back) and it replays the winner.
   * Without a key there is no replay protection.
   */
  async checkout(userId: string, input: z.output<typeof CheckoutSchema>, rawKey?: string | null): Promise<CheckoutResponse> {
    const key = normalizeKey(rawKey);
    if (!key) return this.placeOrder(userId, input.addressId, null, null);

    // The cart is server state (and consumed by the first checkout), so only
    // the client-controlled body is hashed.
    const hash = createHash('sha256').update(`${userId}:${input.addressId}`).digest('hex');

    const replay = await this.replayCheckout(userId, key, hash);
    if (replay) return replay;
    try {
      return await this.placeOrder(userId, input.addressId, key, hash);
    } catch (e) {
      // Same-key race: lost at the unique index, or slightly later — the twin
      // committed and consumed the cart first. Either way, serve the winner.
      if (isIntegrityViolation(e) || e instanceof EmptyCartError) {
        const winner = await this.replayCheckout(userId, key, hash);
        if (winner) return winner;
      }
      throw e;
    }
  }

  /**
   * One transaction: validate → snapshot price/name/merchant → atomically
   * decrement stock → start payment → persist the order → consume the cart.
   * Any failure rolls everything back, so stock is never taken for an order
   * that doesn't exist.
   */
  private placeOrder(userId: string, addressId: string, key: string | null, hash: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({ where: { userId, deleted: false } });
      if (!cart) throw new EmptyCartError();
      const items = await tx.cartItem.findMany({ where: { cartId: cart.id, deleted: false }, orderBy: { createdAt: 'asc' } });
      if (!items.length) throw new EmptyCartError();

      const address = await tx.userAddress.findFirst({ where: { id: addressId, userId, deleted: false } });
      if (!address) throw new AddressNotFoundError(addressId);

      const orderNumber = await generateOrderNumber(tx);
      let subtotal = new Prisma.Decimal(0);
      const lines: Prisma.OrderItemCreateWithoutOrderInput[] = [];
      for (const item of items) {
        const product = await tx.product.findFirst({ where: { id: item.productId, deleted: false } });
        if (!product || product.status !== 'ACTIVE') throw new ProductUnavailableError(item.productId);

        // 0 rows: a concurrent buyer took the last units since the check above.
        if ((await decrementStock(tx, product.id, item.quantity)) === 0) {
          throw new OutOfStockError(product.name);
        }
        const lineTotal = product.price.mul(item.quantity);
        subtotal = subtotal.add(lineTotal);
        lines.push({
          productId: product.id,
          merchantId: product.merchantId,
          productName: product.name,
          sku: product.sku,
          unitPrice: product.price,
          quantity: item.quantity,
          lineTotal,
        });
      }

      // grand = subtotal + tax + shipping - discount; only subtotal is non-zero in v1.
      const zero = new Prisma.Decimal(0);
      const grandTotal = subtotal.add(zero).add(zero).sub(zero);

      // Manual → PENDING with a generated reference; Stripe → PENDING with a
      // PaymentIntent id and a client secret for the browser to confirm.
      const payment = await this.gateway.initiate({ orderNumber, amount: grandTotal, currency: this.currency });

      const order = await tx.order.create({
        data: {
          userId,
          orderNumber,
          status: 'PENDING_PAYMENT',
          currency: this.currency,
          subtotal,
          taxTotal: zero,
          shippingTotal: zero,
          discountTotal: zero,
          grandTotal,
          paymentStatus: payment.status,
          paymentReference: payment.reference,
          // Lets the Stripe webhook reconcile its events back to this order.
          paymentIntentId: payment.reference,
          idempotencyKey: key,
          requestHash: hash,
          shipRecipientName: address.recipientName,
          shipPhone: address.phone,
          shipAddressLine1: address.addressLine1,
          shipAddressLine2: address.addressLine2,
          shipCity: address.city,
          shipState: address.state,
          shipPostalCode: address.postalCode,
          shipCountry: address.country,
          items: { create: lines },
        },
        include: ORDER_ITEMS_INCLUDE,
      });

      // The order consumed the cart.
      await tx.cartItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { deleted: true } });

      // The client secret goes back to the client but is never stored.
      return { order: toOrderResponse(order), clientSecret: payment.clientSecret };
    }, TX.checkout);
  }

  /**
   * Replay for an existing (user, key) order, or null if none. A still-pending
   * order re-fetches its client secret from the gateway (it is never stored);
   * a terminal one replays without — the client must start a new checkout.
   */
  async replayCheckout(userId: string, key: string, hash: string): Promise<CheckoutResponse | null> {
    const existing = await this.prisma.order.findFirst({
      where: { userId, idempotencyKey: key, deleted: false },
      include: ORDER_ITEMS_INCLUDE,
    });
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new IdempotencyKeyConflictError();

    const clientSecret =
      existing.status === 'PENDING_PAYMENT' && existing.paymentIntentId
        ? await this.gateway.findClientSecret(existing.paymentIntentId)
        : null;
    log.info(`Replaying checkout for order ${existing.orderNumber} (idempotency key reuse)`);
    return { order: toOrderResponse(existing), clientSecret };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async findMyOrders(userId: string, pageable: Pageable) {
    const where = { userId, deleted: false };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({ where, orderBy: orderBy(pageable, [{ createdAt: 'desc' }]), ...skipTake(pageable) }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(rows.map(toOrderSummaryResponse), total, pageable);
  }

  async findById(userId: string, orderId: string) {
    return toOrderResponse(await findOwned(this.prisma, userId, orderId));
  }

  // ── Cancellation and manual payment ──────────────────────────────────────

  /**
   * Customer cancellation of an unshipped order (PENDING_PAYMENT, PAID,
   * CONFIRMED). Every transition goes through an atomic claim shared with the
   * webhook and expiry paths, so a concurrent cancellation can never restock
   * twice; a lost claim re-reads and reports the settled order.
   *  - A paid order is refunded through the gateway first; if that fails,
   *    nothing changes.
   *  - An unpaid order's PaymentIntent is cancelled first so it can't be paid
   *    afterwards; if the payment is mid-flight the cancel is refused.
   */
  cancel(userId: string, orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await findOwned(tx, userId, orderId);
      const cancellable: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED'];
      if (!cancellable.includes(order.status as OrderStatus)) {
        throw new InvalidOrderStateError(`An order with status ${order.status} can no longer be cancelled`);
      }

      let claimed: number;
      if (order.status === 'PENDING_PAYMENT') {
        if (order.paymentIntentId && !(await this.gateway.cancelPayment(order.paymentIntentId))) {
          throw new InvalidOrderStateError(
            'Payment for this order is completing — wait for the result, then cancel or refund',
          );
        }
        claimed = await claimPendingCancellation(tx, orderId, 'Cancelled by customer', 'CUSTOMER');
      } else {
        // The gateway refund is idempotent (keyed on the intent): if the claim
        // is then lost to the charge.refunded webhook, nothing happens twice.
        const refundRef = await this.gateway.refund(order.paymentIntentId!, order.grandTotal, order.currency);
        log.info(`Refund ${refundRef} issued for order ${order.orderNumber}`);
        claimed = await claimRefundCancellation(tx, orderId, 'Cancelled by customer', 'CUSTOMER');
      }
      if (claimed === 1) await restock(tx, order.items);

      const settled = await findOwned(tx, userId, orderId);
      if (settled.status !== 'CANCELLED') {
        // Lost the claim to a payment that completed concurrently.
        throw new InvalidOrderStateError(`An order with status ${settled.status} can no longer be cancelled`);
      }
      return toOrderResponse(settled);
    }, TX.checkout);
  }

  /**
   * Admin payment confirmation — the manual gateway's stand-in for a webhook.
   * Disabled for real providers: the order would read PAID with no money moved.
   */
  async markPaid(orderId: string) {
    if (!this.gateway.supportsManualConfirmation()) {
      throw new InvalidOrderStateError('Manual payment confirmation is disabled for the active payment provider');
    }
    const order = await this.prisma.order.findFirst({ where: { id: orderId, deleted: false } });
    if (!order) throw new OrderNotFoundError(orderId);

    if ((await claimManualPaid(this.prisma, orderId)) === 0) {
      const current = await this.prisma.order.findFirst({ where: { id: orderId, deleted: false } });
      if (!current) throw new OrderNotFoundError(orderId);
      throw new InvalidOrderStateError(
        `Only a PENDING_PAYMENT order can be marked paid (current: ${current.status})`,
      );
    }
    const paid = await this.prisma.order.findFirst({ where: { id: orderId, deleted: false }, include: ORDER_ITEMS_INCLUDE });
    if (!paid) throw new OrderNotFoundError(orderId);
    return toOrderResponse(paid);
  }

  // ── PaymentEventHandler (verified gateway events) ────────────────────────

  /**
   * Validates the captured amount and currency before marking PAID: a mismatch
   * throws, so the webhook event is stored FAILED (replayable) instead of
   * confirming a wrong amount.
   */
  async confirmPaymentByIntent(paymentIntentId: string, amountMinor: bigint, reportedCurrency: string) {
    const order = await this.byIntent(paymentIntentId);
    if (!order) {
      log.warn(`Payment succeeded for unknown intent ${paymentIntentId} — ignoring`);
      return;
    }
    if (order.status === 'PAID') return; // an earlier delivery already reconciled it
    if (order.status !== 'PENDING_PAYMENT') {
      // e.g. CANCELLED: the customer paid for an order we no longer honour.
      log.error(
        `Payment succeeded for order ${order.orderNumber} in unexpected state ${order.status} — manual review required`,
      );
      return;
    }
    const expected = toMinorUnits(order.grandTotal, order.currency);
    if (expected !== amountMinor || order.currency.toLowerCase() !== reportedCurrency.toLowerCase()) {
      throw new PaymentAmountMismatchError(order.orderNumber, expected, amountMinor, order.currency, reportedCurrency);
    }
    await this.prisma.order.updateMany({
      where: { id: order.id, status: 'PENDING_PAYMENT' },
      data: { status: 'PAID', paymentStatus: 'SUCCEEDED' },
    });
  }

  /**
   * Records the failed attempt only: a decline is not terminal (the customer
   * can retry the same intent). Abandoned orders are released by the expiry job.
   */
  async recordPaymentFailureByIntent(paymentIntentId: string) {
    const order = await this.byIntent(paymentIntentId);
    if (!order) {
      log.warn(`Payment failed for unknown intent ${paymentIntentId} — ignoring`);
      return;
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        lastPaymentFailureAt: new Date(),
        ...(order.status === 'PENDING_PAYMENT' ? { paymentStatus: 'FAILED' } : {}),
      },
    });
    log.info(`Recorded failed payment attempt for order ${order.orderNumber}`);
  }

  cancelPaymentByIntent(paymentIntentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.byIntent(paymentIntentId, tx);
      if (!order) {
        log.warn(`Payment cancelled for unknown intent ${paymentIntentId} — ignoring`);
        return;
      }
      // Already cancelled (the expiry job's own cancel echoing back, or the customer path).
      if (order.status !== 'PENDING_PAYMENT') return;

      if ((await claimPendingCancellation(tx, order.id, 'Payment cancelled at the provider', 'GATEWAY')) === 1) {
        await restock(tx, order.items);
        log.info(`Order ${order.orderNumber} cancelled after its PaymentIntent was cancelled at the provider`);
      }
    }, TX.default);
  }

  /**
   * The source of truth for refunds. Our own refund-on-cancel already set
   * REFUNDED and restocked, so this no-ops; a dashboard refund of a paid order
   * gets the same outcome here. Partial refunds are logged and change nothing
   * until returns (FR-AD-07) exist.
   */
  recordRefundByIntent(paymentIntentId: string, amountRefundedMinor: bigint, _currency: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.byIntent(paymentIntentId, tx);
      if (!order) {
        log.warn(`Refund reported for unknown intent ${paymentIntentId} — ignoring`);
        return;
      }
      if (order.paymentStatus === 'REFUNDED') return;

      const total = toMinorUnits(order.grandTotal, order.currency);
      if (amountRefundedMinor < total) {
        log.warn(
          `Partial refund (${amountRefundedMinor} of ${total} minor units) reported for order ${order.orderNumber} — ` +
            'partial refunds are unsupported until returns/RMA; no state change',
        );
        return;
      }
      // Stock-holding (paid) order: this claim is shared with customer
      // cancel-with-refund, so exactly one of them restocks.
      if ((await claimRefundCancellation(tx, order.id, 'Refunded at the payment provider', 'GATEWAY')) === 1) {
        await restock(tx, order.items);
        log.info(`Order ${order.orderNumber} reconciled as fully refunded`);
        return;
      }
      // Already cancelled (stock already returned): just record the refund.
      if ((await markRefundedOnCancelled(tx, order.id)) === 1) {
        log.info(`Order ${order.orderNumber} marked refunded (was already cancelled)`);
      }
    }, TX.default);
  }

  private byIntent(paymentIntentId: string, db: Db = this.prisma) {
    return db.order.findFirst({ where: { paymentIntentId, deleted: false }, include: ORDER_ITEMS_INCLUDE });
  }
}

async function findOwned(db: Db, userId: string, orderId: string): Promise<OrderWithItems> {
  const order = await db.order.findFirst({ where: { id: orderId, userId, deleted: false }, include: ORDER_ITEMS_INCLUDE });
  if (!order) throw new OrderNotFoundError(orderId);
  return order;
}

function normalizeKey(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) throw new InvalidIdempotencyKeyError();
  return key;
}

/** e.g. NX-MFX3K2A1-1A2B3 — time-ordered, with a random suffix. */
async function generateOrderNumber(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate =
      `NX-${Date.now().toString(36).toUpperCase()}-${randomInt(0x10000, 0x100000).toString(36).toUpperCase()}`;
    if (!(await db.order.findUnique({ where: { orderNumber: candidate }, select: { id: true } }))) return candidate;
  }
  throw new Error('Unable to generate a unique order number after several attempts');
}
