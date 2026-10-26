import express, { Router } from 'express';
import { assertRole, currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, noContent, ok } from '../common/api-response';
import { parsePageable } from '../common/pagination';
import { parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { CUSTOMER_RETURN_SORTS } from './returns.service';
import { PUBLIC_REVIEW_SORTS, ReviewCreateSchema } from './reviews.service';
import { MergeSavedItemsSchema, SaveItemSchema } from './saved-items.service';

// Customer account shopping (orders aside, which live on /api/orders):
// summary, returns, buy again, saved items and reviews, plus the public
// review reads. Guards are per route: these routers share their mount points
// with other routers (/api/users/me, /api/products).

/** Mounted on /api/users/me. Customers only. */
export function accountShoppingRoutes(c: Container): Router {
  const r = Router();
  const customer = [requireAuth, requireRole('ROLE_CUSTOMER')];
  const me = (req: express.Request) => currentUser(req).id;

  r.get('/summary', ...customer, async (req, res) => {
    res.json(ok(await c.accountSummary.summary(me(req))));
  });

  r.get('/returns', ...customer, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'createdAt,desc', allowedSorts: CUSTOMER_RETURN_SORTS });
    res.json(ok(await c.customerReturns.list(me(req), pageable)));
  });

  r.get('/buy-again', ...customer, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'lastBoughtAt,desc', allowedSorts: ['lastBoughtAt'] });
    res.json(ok(await c.buyAgain.list(me(req), pageable)));
  });

  // ── Saved items ──
  r.get('/saved-items', ...customer, async (req, res) => {
    res.json(ok(await c.savedItems.list(me(req))));
  });
  // Before '/saved-items/:productId'.
  r.get('/saved-items/ids', ...customer, async (req, res) => {
    res.json(ok(await c.savedItems.ids(me(req))));
  });
  r.post('/saved-items/merge', requireAuth, async (req, res) => {
    const { productIds } = parseBody(MergeSavedItemsSchema, req.body);
    res.json(ok(await c.savedItems.merge(assertRole(req, 'ROLE_CUSTOMER').id, productIds), 'Saved items merged'));
  });
  r.post('/saved-items', requireAuth, async (req, res) => {
    const { productId } = parseBody(SaveItemSchema, req.body);
    const { item, created: isNew } = await c.savedItems.save(assertRole(req, 'ROLE_CUSTOMER').id, productId);
    if (isNew) res.status(201).json(created(item, 'Saved'));
    else res.json(ok(item, 'Already saved'));
  });
  r.delete('/saved-items/:productId', ...customer, async (req, res) => {
    await c.savedItems.remove(me(req), pathUuid(req.params.productId, 'productId'));
    res.json(noContent('Removed from saved items'));
  });
  r.post('/saved-items/:productId/move-to-cart', ...customer, async (req, res) => {
    const cart = await c.savedItems.moveToCart(me(req), pathUuid(req.params.productId, 'productId'));
    res.json(ok(cart, 'Moved to cart'));
  });

  // ── Reviews ──
  r.get('/reviews', ...customer, async (req, res) => {
    res.json(ok(await c.reviews.mine(me(req))));
  });
  r.post('/reviews', requireAuth, async (req, res) => {
    const input = parseBody(ReviewCreateSchema, req.body);
    const data = await c.reviews.create(assertRole(req, 'ROLE_CUSTOMER').id, input);
    res.status(201).json(created(data, data.status === 'PUBLISHED' ? 'Review published' : 'Review submitted'));
  });
  r.delete('/reviews/:id', ...customer, async (req, res) => {
    await c.reviews.remove(me(req), pathUuid(req.params.id));
    res.json(noContent('Review deleted'));
  });
  return r;
}

/** Mounted on /api/products (public): GET /:id/reviews, id = parent or SKU id. */
export function productReviewRoutes(c: Container): Router {
  const r = Router();
  r.get('/:id/reviews', async (req, res) => {
    const pageable = parsePageable(req, { sort: 'recent', allowedSorts: PUBLIC_REVIEW_SORTS });
    pageable.size = Math.min(pageable.size, 50);
    res.json(ok(await c.reviews.forProduct(pathUuid(req.params.id), pageable)));
  });
  return r;
}

/** Mounted on /api/reviews (public). */
export function reviewRoutes(c: Container): Router {
  const r = Router();
  r.get('/featured', async (req, res) => {
    const raw = Number(req.query.limit ?? 3);
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 12) : 3;
    res.json(ok(await c.reviews.featured(limit)));
  });
  return r;
}
