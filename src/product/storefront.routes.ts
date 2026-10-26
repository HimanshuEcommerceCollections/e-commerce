import { Router } from 'express';
import { ok } from '../common/api-response';
import { ValidationError } from '../common/validation';
import type { Container } from '../container';
import { parseSearchQuery } from './storefront.service';

// Storefront catalog reads (contract A1–A4). Public. Mounted at /api/products
// before productRoutes, so its paths win over '/:id'; anything else falls through.

const limitOf = (v: unknown, def = 4) => {
  if (v === undefined) return def;
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isInteger(n) || n < 1 || n > 24) throw new ValidationError({ limit: 'must be between 1 and 24' });
  return n;
};

const ids = (v: unknown) =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v])
    .filter((x): x is string => typeof x === 'string')
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 100);

export function storefrontProductRoutes(c: Container): Router {
  const r = Router();
  /** A1: PLP, search and homepage rails, one item per parent product. */
  r.get('/search', async (req, res) => {
    res.json(ok(await c.storefront.search(parseSearchQuery(req.query as Record<string, unknown>))));
  });
  /** A3: cart recommendations (`exclude` = what's in the cart, SKU or parent ids). */
  r.get('/recommendations', async (req, res) => {
    res.json(ok(await c.storefront.recommendations(ids(req.query.exclude), limitOf(req.query.limit))));
  });
  /** A2: related products for a parent or SKU id. */
  r.get('/:id/related', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError({ id: 'must be a valid UUID' });
    res.json(ok(await c.storefront.related(id, limitOf(req.query.limit))));
  });
  return r;
}

/** A4: GET /api/search/suggest?q= — header autocomplete. */
export function searchRoutes(c: Container): Router {
  const r = Router();
  r.get('/suggest', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(ok(await c.storefront.suggest(q)));
  });
  return r;
}
