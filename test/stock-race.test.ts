import { describe, expect, it } from 'vitest';
import { OutOfStockError } from '../src/common/errors';
import { harness } from './support/harness';

/**
 * Two customers race for the last unit: the conditional decrement lets exactly
 * one checkout through, and the loser's whole transaction rolls back (NFR-08).
 * (StockRaceIT)
 */
const { prisma, container, fixtures } = harness();

describe('stock race', () => {
  it('only one of two concurrent checkouts gets the last unit', async () => {
    const lastUnit = await fixtures.newActiveProduct(1, '99.00');
    const buyers = [];
    for (let i = 0; i < 2; i++) {
      const user = await fixtures.newCustomer();
      await fixtures.addToCart(user.id, lastUnit.id, 1);
      buyers.push({ userId: user.id, addressId: (await fixtures.newAddress(user.id)).id });
    }

    const results = await Promise.allSettled(
      buyers.map((b) => container.orders.checkout(b.userId, { addressId: b.addressId }, null)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(OutOfStockError);
    expect(await fixtures.stockOf(lastUnit.id)).toBe(0);
    // The loser left no order behind.
    expect(await prisma.order.count({ where: { userId: { in: buyers.map((b) => b.userId) } } })).toBe(1);
  });
});
