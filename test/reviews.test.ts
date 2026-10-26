import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { accountShopping } from './support/account-shopping';
import { harness } from './support/harness';

/** Reviews: customer writing, moderation, rating rollups, public reads (contract C6). */
const h = harness();
const { app, prisma, fixtures } = h;
const { shopper, newOrder, as } = accountShopping(h);

const auto = harness({ env: { REVIEWS_AUTO_PUBLISH: 'true' } });
const shop = accountShopping(auto);

let catalog: ReturnType<typeof as>;
beforeAll(async () => {
  catalog = as(await fixtures.registerUser('ROLE_CATALOG'));
});

const BODY = 'Fits true to size and the denim is soft.';

/** A customer with a delivered purchase of a fresh product. */
async function buyer(fullName = 'Jordan Miller') {
  const me = await shopper();
  await prisma.user.update({ where: { id: me.userId }, data: { fullName } });
  const product = await fixtures.newActiveProduct(5, '40.00');
  await prisma.product.update({ where: { id: product.id }, data: { color: 'Indigo', size: 'M' } });
  const order = await newOrder(me.userId, [{ price: '40.00', qty: 1, product }]);
  return { me, product, order };
}

describe('writing a review', () => {
  it('lists the delivered purchase as pending, validates, then stores a PENDING review once', async () => {
    const { me, product, order } = await buyer();
    const before = await me.get('/api/users/me/reviews');
    expect(before.body.data.pending).toEqual([
      expect.objectContaining({ productId: product.id, parentId: product.parentId, orderNumber: order.orderNumber, orderItemId: order.items[0].id, variant: 'Indigo · M' }),
    ]);

    const invalid = await me.post('/api/users/me/reviews', { productId: product.id, rating: 0, title: ' ', body: 'short' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.data).toEqual({ rating: 'Choose a star rating.', title: 'Add a short title.', body: 'Write at least 20 characters.' });

    const created = await me.post('/api/users/me/reviews', { productId: product.id, rating: 5, title: 'Great jeans', body: BODY });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ productId: product.id, parentId: product.parentId, rating: 5, recommend: true, status: 'PENDING' });

    const after = await me.get('/api/users/me/reviews');
    expect(after.body.data.pending).toEqual([]);
    expect(after.body.data.reviews).toHaveLength(1);

    const dup = await me.post('/api/users/me/reviews', { productId: product.id, rating: 4, title: 'Again', body: BODY });
    expect(dup.status).toBe(409);
    // Pending reviews don't count yet.
    expect((await prisma.parentProduct.findUniqueOrThrow({ where: { id: product.parentId } })).ratingCount).toBe(0);
  });

  it('needs a delivered purchase of the product', async () => {
    const me = await shopper();
    const product = await fixtures.newActiveProduct(5, '10.00');
    expect((await me.post('/api/users/me/reviews', { productId: product.id, rating: 4, title: 'Nice', body: BODY })).status).toBe(403);
    await newOrder(me.userId, [{ price: '10.00', qty: 1, product }], { status: 'SHIPPED' });
    expect((await me.post('/api/users/me/reviews', { productId: product.id, rating: 4, title: 'Nice', body: BODY })).status).toBe(403);
    expect((await me.post('/api/users/me/reviews', { productId: randomUUID(), rating: 4, title: 'Nice', body: BODY })).status).toBe(404);
  });
});

describe('moderation and rollups', () => {
  it('publishing and rejecting recompute the parent rating; the public endpoints show published reviews', async () => {
    const first = await buyer('Jordan Miller');
    await prisma.userAddress.create({
      data: { userId: first.me.userId, label: 'Home', recipientName: 'Jordan', addressLine1: '1 Main', city: 'Portland', state: 'OR', postalCode: '97214', country: 'US', isDefault: true },
    });
    const parentId = first.product.parentId;
    const r1 = (await first.me.post('/api/users/me/reviews', { productId: first.product.id, rating: 5, title: 'Love it', body: BODY })).body.data.id;

    // A second buyer of the same parent product.
    const second = await shopper();
    await newOrder(second.userId, [{ price: '40.00', qty: 1, product: first.product }]);
    const r2 = (await second.post('/api/users/me/reviews', { productId: parentId, rating: 2, title: 'Not for me', body: BODY, recommend: false })).body.data.id;

    const queue = await catalog.get('/api/admin/reviews?status=PENDING&size=200');
    expect(queue.status).toBe(200);
    expect(queue.body.data.content.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([r1, r2]));
    expect((await first.me.get('/api/admin/reviews')).status).toBe(403);

    expect((await catalog.post(`/api/admin/reviews/${r1}/publish`)).body.data).toMatchObject({ status: 'PUBLISHED', author: 'Jordan M.' });
    expect((await catalog.post(`/api/admin/reviews/${r2}/publish`)).status).toBe(200);
    expect((await catalog.post(`/api/admin/reviews/${r2}/publish`)).status).toBe(409);
    let parent = await prisma.parentProduct.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.ratingCount).toBe(2);
    expect(parent.ratingAvg.toFixed(2)).toBe('3.50');

    const pub = await request(app).get(`/api/products/${first.product.id}/reviews?sort=rating`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.summary).toEqual({ average: 3.5, count: 2, distribution: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 }, recommendPercent: 50 });
    expect(pub.body.data.page.content[0]).toMatchObject({
      id: r1,
      rating: 5,
      author: 'Jordan M.',
      location: 'Portland, OR',
      variant: 'Indigo · M',
      verifiedBuyer: true,
    });
    expect(pub.body.data.page.content[0]).not.toHaveProperty('userId');

    const rejected = await catalog.post(`/api/admin/reviews/${r2}/reject`, { note: 'Off topic' });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', moderatorNote: 'Off topic' });
    parent = await prisma.parentProduct.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.ratingCount).toBe(1);
    expect(parent.ratingAvg.toFixed(2)).toBe('5.00');
    expect(await prisma.notification.count({ where: { userId: second.userId, template: 'REVIEW_UPDATE' } })).toBe(2);

    const featured = await request(app).get('/api/reviews/featured?limit=50');
    expect(featured.status).toBe(200);
    expect(featured.body.data.count).toBeGreaterThanOrEqual(1);
    expect(featured.body.data.reviews).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: r1, productName: 'Test Product', productSlug: first.product.id })]),
    );
    expect(featured.body.data.reviews.every((r: { rating: number }) => r.rating >= 4)).toBe(true);

    // The author deletes it: gone from the rating.
    expect((await first.me.del(`/api/users/me/reviews/${r1}`)).status).toBe(200);
    parent = await prisma.parentProduct.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.ratingCount).toBe(0);
    expect((await first.me.del(`/api/users/me/reviews/${r1}`)).status).toBe(404);
    expect((await request(app).get(`/api/products/${parentId}/reviews`)).body.data.summary.count).toBe(0);
  });

  it('auto-publishes when REVIEWS_AUTO_PUBLISH=true', async () => {
    const me = await shop.shopper();
    const product = await auto.fixtures.newActiveProduct(5, '10.00');
    await shop.newOrder(me.userId, [{ price: '10.00', qty: 1, product }]);
    const res = await me.post('/api/users/me/reviews', { productId: product.id, rating: 4, title: 'Good', body: BODY });
    expect(res.body.data.status).toBe('PUBLISHED');
    const parent = await prisma.parentProduct.findUniqueOrThrow({ where: { id: product.parentId } });
    expect(parent.ratingCount).toBe(1);
  });
});
