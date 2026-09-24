import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidOrderStateError } from '../src/common/errors';
import { harness } from './support/harness';
import { RecordingPaymentGateway } from './support/recording-gateway';

/**
 * Customer cancellation against a scriptable gateway: paid orders refund before
 * cancelling, unpaid orders kill their PaymentIntent first. (OrderCancellationIT)
 */
const gateway = new RecordingPaymentGateway();
const { prisma, container, fixtures } = harness({ gateway });
const orders = container.orders;

afterEach(() => gateway.reset());

async function placeOrder() {
  const user = await fixtures.newCustomer();
  const product = await fixtures.newActiveProduct(10, '25.00');
  await fixtures.addToCart(user.id, product.id, 2);
  const address = await fixtures.newAddress(user.id);
  const res = await orders.checkout(user.id, { addressId: address.id }, null);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  return { userId: user.id, orderId: order.id, intentId: order.paymentIntentId!, productId: product.id };
}

const reload = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

describe('order cancellation', () => {
  it('cancelling an unpaid order kills its PaymentIntent', async () => {
    const placed = await placeOrder();
    await orders.cancel(placed.userId, placed.orderId);

    const order = await reload(placed.orderId);
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelledBy).toBe('CUSTOMER');
    expect(await fixtures.stockOf(placed.productId)).toBe(10);
    expect(gateway.cancelledReferences).toContain(placed.intentId);
    expect(gateway.refunds).toHaveLength(0);
  });

  it('cancelling a paid order refunds the full amount first', async () => {
    const placed = await placeOrder();
    await orders.markPaid(placed.orderId);
    await orders.cancel(placed.userId, placed.orderId);

    const order = await reload(placed.orderId);
    expect(order.status).toBe('CANCELLED');
    expect(order.paymentStatus).toBe('REFUNDED');
    expect(await fixtures.stockOf(placed.productId)).toBe(10);
    expect(gateway.refunds).toHaveLength(1);
    expect(gateway.refunds[0].paymentReference).toBe(placed.intentId);
    expect(gateway.refunds[0].amount.toFixed(2)).toBe('50.00');
    expect(gateway.refunds[0].currency).toBe('USD');
  });

  it('replay of a cancelled order returns it without a client secret', async () => {
    const user = await fixtures.newCustomer();
    const product = await fixtures.newActiveProduct(5, '10.00');
    await fixtures.addToCart(user.id, product.id, 1);
    const key = `key-${randomUUID()}`;
    const input = { addressId: (await fixtures.newAddress(user.id)).id };

    const placed = await orders.checkout(user.id, input, key);
    // A pending replay re-fetches the confirmation secret from the gateway.
    expect((await orders.checkout(user.id, input, key)).clientSecret).toBe('test-client-secret');

    await orders.cancel(user.id, placed.order.id);

    // Terminal replay: same order back, but no secret — start a new checkout.
    const terminal = await orders.checkout(user.id, input, key);
    expect(terminal.order.orderNumber).toBe(placed.order.orderNumber);
    expect(terminal.order.status).toBe('CANCELLED');
    expect(terminal.clientSecret).toBeNull();
  });

  it('cancellation is refused while payment is completing', async () => {
    const placed = await placeOrder();
    gateway.cancellable = false;

    await expect(orders.cancel(placed.userId, placed.orderId)).rejects.toBeInstanceOf(InvalidOrderStateError);
    expect((await reload(placed.orderId)).status).toBe('PENDING_PAYMENT');
    expect(await fixtures.stockOf(placed.productId)).toBe(8);
  });

  it('marking paid is refused for providers that report payments themselves', async () => {
    const placed = await placeOrder();
    gateway.manualConfirmation = false;
    await expect(orders.markPaid(placed.orderId)).rejects.toThrow(/Manual payment confirmation is disabled/);
  });
});
