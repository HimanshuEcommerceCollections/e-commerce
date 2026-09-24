import { afterEach, describe, expect, it } from 'vitest';
import { harness } from './support/harness';
import { RecordingPaymentGateway } from './support/recording-gateway';

/**
 * Stale PENDING_PAYMENT orders are cancelled (intent first, then an atomic
 * claim) and their reserved stock released. (PendingOrderExpiryIT)
 */
const gateway = new RecordingPaymentGateway();
const { prisma, container, fixtures } = harness({ gateway });
const expiry = container.expiry;

afterEach(() => gateway.reset());

async function placeOrder() {
  const user = await fixtures.newCustomer();
  const product = await fixtures.newActiveProduct(10, '25.00');
  await fixtures.addToCart(user.id, product.id, 2);
  const res = await container.orders.checkout(user.id, { addressId: (await fixtures.newAddress(user.id)).id }, null);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  return { orderId: order.id, intentId: order.paymentIntentId!, productId: product.id };
}

const backdate = (orderId: string) =>
  prisma.$executeRaw`UPDATE orders SET created_at = now() - interval '2 hours' WHERE id = ${orderId}::uuid`;

const statusOf = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

describe('pending order expiry', () => {
  it('the job expires stale orders and releases their stock', async () => {
    const placed = await placeOrder();
    expect(await fixtures.stockOf(placed.productId)).toBe(8);
    await backdate(placed.orderId);

    await expiry.expireAbandonedOrders();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelledBy).toBe('SYSTEM_EXPIRY');
    expect(order.cancellationReason).toBe('Expired before payment');
    expect(await fixtures.stockOf(placed.productId)).toBe(10);
    expect(gateway.cancelledReferences).toContain(placed.intentId);

    // Idempotent: a second pass restocks nothing.
    await expiry.expireAbandonedOrders();
    expect(await fixtures.stockOf(placed.productId)).toBe(10);
  });

  it('fresh orders are not touched', async () => {
    const placed = await placeOrder();
    await expiry.expireAbandonedOrders();
    expect(await statusOf(placed.orderId)).toBe('PENDING_PAYMENT');
    expect(await fixtures.stockOf(placed.productId)).toBe(8);
  });

  it('expiry skips when the payment is completing at the provider', async () => {
    const placed = await placeOrder();
    await backdate(placed.orderId);
    gateway.cancellable = false;

    expect(await expiry.expire(placed.orderId)).toBe(false);
    expect(await statusOf(placed.orderId)).toBe('PENDING_PAYMENT');
    expect(await fixtures.stockOf(placed.productId)).toBe(8);
  });

  it('the job is inert when the gateway does not support expiry', async () => {
    const placed = await placeOrder();
    await backdate(placed.orderId);
    gateway.supportsExpiry = false;

    await expiry.expireAbandonedOrders();
    // Manual-gateway semantics: orders legitimately wait for an admin.
    expect(await statusOf(placed.orderId)).toBe('PENDING_PAYMENT');
  });
});
