import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EmptyCartError, IdempotencyKeyConflictError, InvalidIdempotencyKeyError } from '../src/common/errors';
import { harness } from './support/harness';

/** Idempotency-Key semantics of checkout. (CheckoutIdempotencyIT) */
const { prisma, container, fixtures } = harness();
const orders = container.orders;

const orderByKey = (userId: string, key: string) =>
  prisma.order.findFirst({ where: { userId, idempotencyKey: key, deleted: false } });

describe('checkout idempotency', () => {
  it('the same key replays the existing order instead of creating a second one', async () => {
    const user = await fixtures.newCustomer();
    const address = await fixtures.newAddress(user.id);
    const product = await fixtures.newActiveProduct(10, '25.00');
    await fixtures.addToCart(user.id, product.id, 2);
    const key = `key-${randomUUID()}`;

    const first = await orders.checkout(user.id, { addressId: address.id }, key);
    const replay = await orders.checkout(user.id, { addressId: address.id }, key);

    expect(replay.order.orderNumber).toBe(first.order.orderNumber);
    expect(await orderByKey(user.id, key)).not.toBeNull();
    // Stock taken exactly once: the replay didn't run checkout again.
    expect(await fixtures.stockOf(product.id)).toBe(8);
  });

  it('the same key with a different request is rejected', async () => {
    const user = await fixtures.newCustomer();
    const address = await fixtures.newAddress(user.id);
    const other = await fixtures.newAddress(user.id, false);
    const product = await fixtures.newActiveProduct(5, '10.00');
    await fixtures.addToCart(user.id, product.id, 1);
    const key = `key-${randomUUID()}`;

    await orders.checkout(user.id, { addressId: address.id }, key);
    await expect(orders.checkout(user.id, { addressId: other.id }, key)).rejects.toBeInstanceOf(
      IdempotencyKeyConflictError,
    );
  });

  it('a malformed key is rejected before any work', async () => {
    const user = await fixtures.newCustomer();
    const address = await fixtures.newAddress(user.id);
    await expect(orders.checkout(user.id, { addressId: address.id }, 'not valid!!')).rejects.toBeInstanceOf(
      InvalidIdempotencyKeyError,
    );
  });

  it('two concurrent checkouts with the same key produce one order', async () => {
    const user = await fixtures.newCustomer();
    const address = await fixtures.newAddress(user.id);
    const product = await fixtures.newActiveProduct(10, '25.00');
    await fixtures.addToCart(user.id, product.id, 2);
    const key = `key-${randomUUID()}`;

    const [a, b] = await Promise.all([
      orders.checkout(user.id, { addressId: address.id }, key),
      orders.checkout(user.id, { addressId: address.id }, key),
    ]);

    // Both callers get a response, for the SAME order.
    expect(a.order.orderNumber).toBe(b.order.orderNumber);
    // One order, one stock decrement — the loser's transaction rolled back.
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    expect(await fixtures.stockOf(product.id)).toBe(8);
  });

  it('without a key, a retry finds the cart already consumed', async () => {
    const user = await fixtures.newCustomer();
    const address = await fixtures.newAddress(user.id);
    const product = await fixtures.newActiveProduct(5, '10.00');
    await fixtures.addToCart(user.id, product.id, 1);

    await orders.checkout(user.id, { addressId: address.id }, null);
    await expect(orders.checkout(user.id, { addressId: address.id }, null)).rejects.toBeInstanceOf(EmptyCartError);
  });
});
