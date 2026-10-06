import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Cart pricing, guest preview, merge, quote and signed-in checkout options (FR-ST-09/10, FR-IN-06). */
const { app, prisma, container, fixtures } = harness({ env: { DEFAULT_TAX_RATE: '5' } });

async function product(stock: number, price: string, extra: Prisma.ProductUpdateInput = {}) {
  const p = await fixtures.newActiveProduct(stock, price);
  return prisma.product.update({ where: { id: p.id }, data: extra });
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('cart pricing', () => {
  it('the signed-in cart shows tax, savings and the shipping estimate', async () => {
    const user = await fixtures.newCustomer();
    const a = await product(10, '10.00', { mrp: new Prisma.Decimal('12.50'), taxRate: new Prisma.Decimal('10') });
    await fixtures.addToCart(user.id, a.id, 2);

    const cart = JSON.parse(JSON.stringify(await container.cart.getCart(user.id)));
    expect(cart).toMatchObject({
      totalItems: 2,
      totalPrice: 20,
      savings: 5,
      taxTotal: 2,
      shippingEstimate: 5.99, // below the 35.00 free threshold
      grandTotalEstimate: 27.99,
      pricesIncludeTax: false,
      freeShippingThreshold: 35,
    });
    expect(cart.items[0]).toMatchObject({ productId: a.id, parentId: a.parentId, mrp: 12.5, taxRate: 10, taxAmount: 2, subtotal: 20, lineTotal: 20, stockQuantity: 10, available: true });
  });

  it('a guest preview drops unknown products, flags unbuyable ones, and never errors', async () => {
    const live = await product(3, '40.00');
    const inactive = await product(5, '9.00', { status: 'INACTIVE' });
    const soldOut = await product(0, '9.00');
    const res = await request(app)
      .post('/api/cart/preview')
      .send({
        items: [
          { productId: live.id, quantity: 7 },
          { productId: inactive.id, quantity: 1 },
          { productId: soldOut.id, quantity: 1 },
          { productId: randomUUID(), quantity: 1 },
        ],
      });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.cartId).toBeNull();
    expect(data.items.map((i: { productId: string; available: boolean }) => [i.productId, i.available])).toEqual([
      [live.id, true],
      [inactive.id, false],
      [soldOut.id, false],
    ]);
    // Quantity reported as sent; the client caps it with stockQuantity.
    expect(data.items[0]).toMatchObject({ quantity: 7, stockQuantity: 3, taxRate: 5 });
    expect(data).toMatchObject({ totalItems: 7, totalPrice: 280, taxTotal: 14, shippingEstimate: 0, grandTotalEstimate: 294 });

    expect((await request(app).post('/api/cart/preview').send({ items: [{ productId: 'x', quantity: 0 }] })).status).toBe(400);
  });

  it('merge adds guest lines to the account cart, capped at stock, skipping unavailable ones', async () => {
    const token = await fixtures.registerUser();
    const userId = (await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).id;
    const a = await product(5, '10.00');
    const b = await product(10, '10.00');
    const gone = await product(5, '10.00', { status: 'INACTIVE' });
    await fixtures.addToCart(userId, a.id, 3);

    const res = await request(app)
      .post('/api/cart/merge')
      .set(bearer(token))
      .send({
        items: [
          { productId: a.id, quantity: 4 },
          { productId: b.id, quantity: 2 },
          { productId: gone.id, quantity: 1 },
        ],
      });
    expect(res.status).toBe(200);
    const lines = Object.fromEntries(res.body.data.items.map((i: { productId: string; quantity: number }) => [i.productId, i.quantity]));
    expect(lines).toEqual({ [a.id]: 5, [b.id]: 2 });

    expect((await request(app).post('/api/cart/merge').send({ items: [] })).status).toBe(401);
  });
});

describe('checkout quote', () => {
  it('prices both shipping methods; standard turns free at the threshold', async () => {
    const p = await product(10, '12.00', { taxRate: new Prisma.Decimal('8.25'), mrp: new Prisma.Decimal('15.00') });
    const quote = async (quantity: number, shippingMethod?: string) =>
      (await request(app).post('/api/checkout/quote').send({ items: [{ productId: p.id, quantity }], shippingMethod })).body.data;

    const small = await quote(2);
    expect(small).toMatchObject({
      currency: 'USD',
      shippingMethod: 'STANDARD',
      subtotal: 24,
      savings: 6,
      taxTotal: 1.98,
      shippingTotal: 5.99,
      discountTotal: 0,
      grandTotal: 31.97,
    });
    expect(small.shippingOptions).toEqual([
      expect.objectContaining({ method: 'STANDARD', fee: 5.99, free: false, minDays: 3, maxDays: 5 }),
      expect.objectContaining({ method: 'EXPRESS', fee: 9.99, free: false }),
    ]);

    const big = await quote(3);
    expect(big).toMatchObject({ subtotal: 36, taxTotal: 2.97, shippingTotal: 0, grandTotal: 38.97 });
    expect(big.shippingOptions[0]).toMatchObject({ fee: 0, free: true });

    const express = await quote(3, 'EXPRESS');
    expect(express).toMatchObject({ shippingTotal: 9.99, grandTotal: 48.96 });
  });

  it('a signed-in customer sending no lines gets the server cart quoted', async () => {
    const token = await fixtures.registerUser();
    const p = await product(10, '50.00');
    await request(app).post('/api/cart/items').set(bearer(token)).send({ productId: p.id, quantity: 1 });
    const res = await request(app).post('/api/checkout/quote').set(bearer(token)).send({});
    expect(res.body.data).toMatchObject({ subtotal: 50, taxTotal: 2.5, shippingTotal: 0, grandTotal: 52.5 });
    expect(res.body.data.lines).toHaveLength(1);
  });
});

describe('signed-in checkout', () => {
  it('takes an inline address, saves it, charges the chosen shipping and snapshots tax', async () => {
    const token = await fixtures.registerUser();
    const user = await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    const p = await product(4, '15.00', { taxRate: new Prisma.Decimal('10') });
    await request(app).post('/api/cart/items').set(bearer(token)).send({ productId: p.id, quantity: 2 });

    const res = await request(app)
      .post('/api/orders')
      .set(bearer(token))
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({
        shippingAddress: { recipientName: 'Sam', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '73301' },
        saveAddress: true,
        shippingMethod: 'EXPRESS',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.order).toMatchObject({
      guest: false,
      customerEmail: user.email,
      shippingMethod: 'EXPRESS',
      subtotal: 30,
      taxTotal: 3,
      shippingTotal: 9.99,
      grandTotal: 42.99,
    });
    expect(res.body.data.order.items[0]).toMatchObject({ taxRate: 10, taxAmount: 3 });
    const saved = await prisma.userAddress.findMany({ where: { userId: user.id, deleted: false } });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ addressLine1: '1 Main St', country: 'US', isDefault: true });
    // The cart was consumed.
    expect((await request(app).get('/api/cart').set(bearer(token))).body.data.items).toHaveLength(0);
  });

  it('needs exactly one of addressId and shippingAddress', async () => {
    const token = await fixtures.registerUser();
    const neither = await request(app).post('/api/orders').set(bearer(token)).send({});
    expect(neither.status).toBe(400);
    expect(neither.body.data).toEqual({ addressId: 'Shipping address id is required' });
  });
});
