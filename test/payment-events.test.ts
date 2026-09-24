import { describe, expect, it } from 'vitest';
import { PaymentAmountMismatchError } from '../src/common/errors';
import { harness } from './support/harness';

/**
 * What verified gateway events (Stripe webhooks) do to an order. Every order is
 * 2 × $25.00 = $50.00 = 5000 minor units. (PaymentEventsIT)
 */
const { prisma, container, fixtures } = harness();
const orders = container.orders;

async function placeOrder() {
  const user = await fixtures.newCustomer();
  const product = await fixtures.newActiveProduct(10, '25.00');
  await fixtures.addToCart(user.id, product.id, 2);
  const res = await orders.checkout(user.id, { addressId: (await fixtures.newAddress(user.id)).id }, null);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  return { orderId: order.id, intentId: order.paymentIntentId!, productId: product.id };
}

const reload = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

describe('payment events', () => {
  it('success with the matching amount marks the order paid', async () => {
    const placed = await placeOrder();
    await orders.confirmPaymentByIntent(placed.intentId, 5000n, 'usd');
    const order = await reload(placed.orderId);
    expect(order.status).toBe('PAID');
    expect(order.paymentStatus).toBe('SUCCEEDED');
  });

  it('success with a wrong amount or currency throws and leaves the order unpaid', async () => {
    const placed = await placeOrder();
    await expect(orders.confirmPaymentByIntent(placed.intentId, 4999n, 'usd')).rejects.toBeInstanceOf(
      PaymentAmountMismatchError,
    );
    await expect(orders.confirmPaymentByIntent(placed.intentId, 5000n, 'eur')).rejects.toBeInstanceOf(
      PaymentAmountMismatchError,
    );
    expect((await reload(placed.orderId)).status).toBe('PENDING_PAYMENT');
  });

  it('a failed attempt is recorded but not terminal', async () => {
    const placed = await placeOrder();
    expect(await fixtures.stockOf(placed.productId)).toBe(8);

    await orders.recordPaymentFailureByIntent(placed.intentId);
    const order = await reload(placed.orderId);
    // Still payable: no cancel, no restock — the customer can retry.
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.paymentStatus).toBe('FAILED');
    expect(order.lastPaymentFailureAt).not.toBeNull();
    expect(await fixtures.stockOf(placed.productId)).toBe(8);

    await orders.confirmPaymentByIntent(placed.intentId, 5000n, 'usd');
    expect((await reload(placed.orderId)).status).toBe('PAID');
  });

  it('a cancelled intent cancels and restocks exactly once', async () => {
    const placed = await placeOrder();
    await orders.cancelPaymentByIntent(placed.intentId);
    await orders.cancelPaymentByIntent(placed.intentId); // redelivery — no-op

    const order = await reload(placed.orderId);
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelledBy).toBe('GATEWAY');
    expect(await fixtures.stockOf(placed.productId)).toBe(10);
  });

  it('a full refund reconciles a paid order', async () => {
    const placed = await placeOrder();
    await orders.confirmPaymentByIntent(placed.intentId, 5000n, 'usd');
    await orders.recordRefundByIntent(placed.intentId, 5000n, 'usd');

    const order = await reload(placed.orderId);
    expect(order.paymentStatus).toBe('REFUNDED');
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelledBy).toBe('GATEWAY');
    expect(await fixtures.stockOf(placed.productId)).toBe(10);
  });

  it('a partial refund is logged but changes nothing', async () => {
    const placed = await placeOrder();
    await orders.confirmPaymentByIntent(placed.intentId, 5000n, 'usd');
    await orders.recordRefundByIntent(placed.intentId, 1000n, 'usd');

    const order = await reload(placed.orderId);
    expect(order.status).toBe('PAID');
    expect(order.paymentStatus).toBe('SUCCEEDED');
    expect(await fixtures.stockOf(placed.productId)).toBe(8);
  });

  it('events for unknown intents are ignored', async () => {
    await orders.confirmPaymentByIntent('pi_unknown', 1n, 'usd');
    await orders.recordPaymentFailureByIntent('pi_unknown');
    await orders.cancelPaymentByIntent('pi_unknown');
    await orders.recordRefundByIntent('pi_unknown', 1n, 'usd');
  });
});
