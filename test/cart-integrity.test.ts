import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CartItemNotFoundError } from '../src/common/errors';
import { harness } from './support/harness';

/** The V8 cart invariants and the cart behaviour that depends on them. (CartIntegrityIT) */
const { prisma, container, fixtures } = harness();
const cart = container.cart;

const liveCart = (userId: string) => prisma.cart.findFirst({ where: { userId, deleted: false } });

/** Prisma reports raw-query violations by SQLSTATE; 23505 = unique_violation. */
const uniqueViolation = { code: 'P2010', meta: expect.objectContaining({ code: '23505' }) };

async function partialIndex(name: string) {
  const [row] = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = ${name}`;
  return row?.indexdef ?? '';
}

describe('cart integrity', () => {
  it('getting the cart actually persists it', async () => {
    const user = await fixtures.newCustomer();
    await cart.getCart(user.id);
    expect(await liveCart(user.id)).not.toBeNull();
  });

  it('remove then re-add reuses the row instead of accumulating', async () => {
    const user = await fixtures.newCustomer();
    const product = await fixtures.newActiveProduct(10, '5.00');

    await fixtures.addToCart(user.id, product.id, 2);
    await cart.removeItem(user.id, product.id);
    await fixtures.addToCart(user.id, product.id, 3);
    await cart.removeItem(user.id, product.id);
    await fixtures.addToCart(user.id, product.id, 1);

    const cartId = (await liveCart(user.id))!.id;
    expect(await prisma.cartItem.count({ where: { cartId, productId: product.id } })).toBe(1);
    const items = (await cart.getCart(user.id)).items;
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(1);
  });

  it('clearing without a cart does not create one', async () => {
    const user = await fixtures.newCustomer();
    await cart.clearCart(user.id);
    expect(await liveCart(user.id)).toBeNull();
  });

  it('removing from a nonexistent cart is a 404, not a side effect', async () => {
    const user = await fixtures.newCustomer();
    await expect(cart.removeItem(user.id, randomUUID())).rejects.toBeInstanceOf(CartItemNotFoundError);
    expect(await liveCart(user.id)).toBeNull();
  });

  it('the database rejects a duplicate live cart per user', async () => {
    const user = await fixtures.newCustomer();
    await cart.getCart(user.id);
    await expect(
      prisma.$executeRaw`INSERT INTO carts (id, created_at, updated_at, deleted, user_id)
                         VALUES (${randomUUID()}::uuid, now(), now(), false, ${user.id}::uuid)`,
    ).rejects.toMatchObject(uniqueViolation);
    expect(await partialIndex('uniq_carts_user_live')).toMatch(/UNIQUE INDEX .* \(user_id\) WHERE \(deleted = false\)/);
  });

  it('the database rejects duplicate live lines per product', async () => {
    const user = await fixtures.newCustomer();
    const product = await fixtures.newActiveProduct(10, '5.00');
    await fixtures.addToCart(user.id, product.id, 1);
    const cartId = (await liveCart(user.id))!.id;
    await expect(
      prisma.$executeRaw`INSERT INTO cart_items (id, created_at, updated_at, deleted, cart_id, product_id, quantity)
                         VALUES (${randomUUID()}::uuid, now(), now(), false, ${cartId}::uuid, ${product.id}::uuid, 1)`,
    ).rejects.toMatchObject(uniqueViolation);
    expect(await partialIndex('uniq_cart_items_cart_product_live')).toMatch(
      /UNIQUE INDEX .* \(cart_id, product_id\) WHERE \(deleted = false\)/,
    );
  });

  it('concurrent first requests end with a single live cart', async () => {
    const user = await fixtures.newCustomer();
    const [a, b] = await Promise.all([cart.getCart(user.id), cart.getCart(user.id)]);
    expect(a.cartId).toBe(b.cartId);
    expect(await prisma.cart.count({ where: { userId: user.id, deleted: false } })).toBe(1);
  });
});
