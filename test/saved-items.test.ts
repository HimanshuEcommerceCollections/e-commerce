import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountShopping } from './support/account-shopping';
import { harness } from './support/harness';

/** Saved items and buy again (contract C4/C5). */
const h = harness();
const { prisma, fixtures } = h;
const { shopper, newOrder, as } = accountShopping(h);

describe('saved items', () => {
  it('saves idempotently, lists with the price drop, unsaves', async () => {
    const me = await shopper();
    const product = await fixtures.newActiveProduct(4, '40.00');
    await prisma.product.update({ where: { id: product.id }, data: { mrp: '50.00', color: 'Indigo', size: 'M', urlSlug: `jeans-${randomUUID()}` } });

    const first = await me.post('/api/users/me/saved-items', { productId: product.id });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ productId: product.id, price: 40, priceAtSave: 40, priceDrop: 0, mrp: 50, stock: 4 });
    const again = await me.post('/api/users/me/saved-items', { productId: product.id });
    expect(again.status).toBe(200);

    // The price falls after saving.
    await prisma.product.update({ where: { id: product.id }, data: { price: '32.50' } });
    const list = await me.get('/api/users/me/saved-items');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      productId: product.id,
      parentId: product.parentId,
      name: 'Test Product',
      price: 32.5,
      priceAtSave: 40,
      priceDrop: 7.5,
      color: 'Indigo',
      size: 'M',
    });
    expect(list.body.data[0].slug).toMatch(/^jeans-/);
    expect((await me.get('/api/users/me/saved-items/ids')).body.data).toEqual([product.id]);

    expect((await me.del(`/api/users/me/saved-items/${product.id}`)).status).toBe(200);
    expect((await me.del(`/api/users/me/saved-items/${product.id}`)).status).toBe(200);
    expect((await me.get('/api/users/me/saved-items/ids')).body.data).toEqual([]);
  });

  it('rejects unknown or unpublished products and bad ids', async () => {
    const me = await shopper();
    expect((await me.post('/api/users/me/saved-items', { productId: randomUUID() })).status).toBe(404);
    const draft = await fixtures.newActiveProduct(1, '5.00');
    await prisma.product.update({ where: { id: draft.id }, data: { status: 'DRAFT' } });
    expect((await me.post('/api/users/me/saved-items', { productId: draft.id })).status).toBe(404);
    expect((await me.post('/api/users/me/saved-items', { productId: 'nope' })).status).toBe(400);
    expect((await me.post('/api/users/me/saved-items', {})).status).toBe(400);
  });

  it('merges guest hearts, skipping unknown ones', async () => {
    const me = await shopper();
    const a = await fixtures.newActiveProduct(1, '5.00');
    const b = await fixtures.newActiveProduct(1, '6.00');
    await me.post('/api/users/me/saved-items', { productId: a.id });
    const res = await me.post('/api/users/me/saved-items/merge', { productIds: [a.id, b.id, randomUUID()] });
    expect(res.status).toBe(200);
    expect([...res.body.data].sort()).toEqual([a.id, b.id].sort());
    expect((await me.post('/api/users/me/saved-items/merge', { productIds: ['x'] })).status).toBe(400);
  });

  it('moves an item to the cart', async () => {
    const me = await shopper();
    const product = await fixtures.newActiveProduct(3, '9.00');
    await me.post('/api/users/me/saved-items', { productId: product.id });
    const res = await me.post(`/api/users/me/saved-items/${product.id}/move-to-cart`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([expect.objectContaining({ productId: product.id, quantity: 1 })]);
    expect((await me.get('/api/users/me/saved-items/ids')).body.data).toEqual([]);
    expect((await me.post(`/api/users/me/saved-items/${product.id}/move-to-cart`)).status).toBe(404);
  });

  it('is for customers only', async () => {
    const admin = as(await fixtures.registerUser('ROLE_ADMIN'));
    expect((await admin.get('/api/users/me/saved-items')).status).toBe(403);
  });
});

describe('buy again', () => {
  it('lists each received, still-active SKU once, most recent purchase first', async () => {
    const me = await shopper();
    const a = await fixtures.newActiveProduct(5, '10.00');
    const b = await fixtures.newActiveProduct(5, '20.00');
    const gone = await fixtures.newActiveProduct(5, '30.00');
    const day = 86_400_000;
    await newOrder(me.userId, [{ price: '10.00', qty: 1, product: a }], { createdAt: new Date(Date.now() - 10 * day) });
    await newOrder(me.userId, [{ price: '20.00', qty: 1, product: b }, { price: '30.00', qty: 1, product: gone }], { createdAt: new Date(Date.now() - 5 * day) });
    await newOrder(me.userId, [{ price: '10.00', qty: 2, product: a }], { status: 'REFUNDED', createdAt: new Date(Date.now() - 2 * day) });
    // Not received yet: not offered.
    const pending = await fixtures.newActiveProduct(5, '1.00');
    await newOrder(me.userId, [{ price: '1.00', qty: 1, product: pending }], { status: 'SHIPPED' });
    await prisma.product.update({ where: { id: gone.id }, data: { status: 'INACTIVE' } });

    const res = await me.get('/api/users/me/buy-again?size=10');
    expect(res.status).toBe(200);
    expect(res.body.data.totalElements).toBe(2);
    expect(res.body.data.content.map((r: { productId: string }) => r.productId)).toEqual([a.id, b.id]);
    expect(res.body.data.content[0]).toMatchObject({ price: 10, stock: 5, parentId: a.parentId, slug: a.id });
    expect(res.body.data.content[0].lastBoughtAt).toBeTruthy();
  });
});
