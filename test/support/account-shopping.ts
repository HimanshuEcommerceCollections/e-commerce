import { randomUUID } from 'node:crypto';
import { Prisma, type Product } from '@prisma/client';
import request from 'supertest';
import type { Harness } from './harness';

/** Builders shared by the account-shopping tests (orders, returns, saved items, reviews). */
export function accountShopping({ app, prisma, fixtures }: Harness) {
  const self = {
    /** A registered customer: token, id and an `as` helper for HTTP calls. */
    async shopper() {
      const token = await fixtures.registerUser();
      const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);
      const userId: string = me.body.data.id;
      return { token, userId, ...self.as(token) };
    },

    as(token: string) {
      const auth = { Authorization: `Bearer ${token}` };
      return {
        get: (url: string) => request(app).get(url).set(auth),
        post: (url: string, body: object = {}) => request(app).post(url).set(auth).send(body),
        del: (url: string) => request(app).delete(url).set(auth),
      };
    },

    /**
     * An order written straight to the database, as checkout and fulfilment
     * would leave it. Lines reuse `products` when given.
     */
    async newOrder(
      userId: string,
      lines: { price: string; qty: number; product?: Product }[],
      options: { status?: string; deliveredAt?: Date | null; createdAt?: Date; name?: string } = {},
    ) {
      const status = options.status ?? 'DELIVERED';
      const products: Product[] = [];
      for (const l of lines) products.push(l.product ?? (await fixtures.newActiveProduct(10, l.price)));
      const total = lines.reduce((s, l) => s.add(new Prisma.Decimal(l.price).mul(l.qty)), new Prisma.Decimal(0));
      const paid = !['PENDING_PAYMENT', 'PAYMENT_FAILED'].includes(status);
      const delivered = options.deliveredAt !== undefined ? options.deliveredAt : status === 'DELIVERED' || status === 'REFUNDED' ? new Date() : null;
      return prisma.order.create({
        data: {
          userId,
          orderNumber: `EC-${Math.floor(Math.random() * 10_000_000).toString().padStart(7, '0')}`,
          status,
          currency: 'USD',
          subtotal: total,
          taxTotal: 0,
          shippingTotal: 0,
          discountTotal: 0,
          grandTotal: total,
          paymentStatus: paid ? 'SUCCEEDED' : 'PENDING',
          paymentReference: `TEST-${randomUUID()}`,
          paymentIntentId: `TEST-${randomUUID()}`,
          shippingMethod: 'STANDARD',
          paidAt: paid ? new Date() : null,
          deliveredAt: delivered,
          createdAt: options.createdAt,
          customerEmail: `order-${randomUUID()}@test.local`,
          shipRecipientName: 'Jordan Miller',
          shipAddressLine1: '1 Test Street',
          shipCity: 'Portland',
          shipState: 'OR',
          shipPostalCode: '97214',
          shipCountry: 'US',
          items: {
            create: lines.map((l, i) => ({
              productId: products[i].id,
              merchantId: products[i].merchantId,
              productName: options.name ?? products[i].name,
              sku: products[i].sku,
              unitPrice: new Prisma.Decimal(l.price),
              quantity: l.qty,
              lineTotal: new Prisma.Decimal(l.price).mul(l.qty),
              color: 'Indigo',
              size: 'M',
            })),
          },
        },
        include: { items: { orderBy: { createdAt: 'asc' } } },
      });
    },
  };
  return self;
}
