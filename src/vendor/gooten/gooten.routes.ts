import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../../auth/auth.middleware';
import { created, ok } from '../../common/api-response';
import { parseBody, pathUuid, ValidationError } from '../../common/validation';
import type { Container } from '../../container';
import { CATALOG_ROLES } from '../../routes';
import { GootenImportSchema, GootenLinkUpdateSchema, GootenSubmitSchema } from './gooten.service';

/**
 * Admin › Vendors › Gooten. Catalog staff browse Gooten's catalog and import
 * products; sending orders (which bills the partner account) is admin only.
 */
export function gootenRoutes(c: Container): Router {
  const r = Router();
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];
  const svc = c.gooten;
  const actor = (req: express.Request) => {
    const u = currentUser(req);
    return { id: u.id, email: u.email };
  };
  const productId = (v: string | string[] | undefined) => {
    const s = typeof v === 'string' ? v : '';
    if (!/^\d{1,9}$/.test(s)) throw new ValidationError({ productId: 'must be a Gooten product number' });
    return Number(s);
  };
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

  r.get('/vendors/gooten/status', ...staff, async (_req, res) => {
    res.json(ok(await svc.status()));
  });
  r.get('/vendors/gooten/catalog', ...staff, async (req, res) => {
    res.json(ok(await svc.listCatalog(text(req.query.search), text(req.query.category))));
  });
  r.get('/vendors/gooten/catalog/:productId', ...staff, async (req, res) => {
    res.json(ok(await svc.catalogProduct(productId(req.params.productId))));
  });
  r.post('/vendors/gooten/catalog/:productId/import', ...staff, async (req, res) => {
    const id = productId(req.params.productId);
    const input = parseBody(GootenImportSchema, req.body);
    res.status(201).json(created(await svc.importProduct(id, input, actor(req)), 'Product imported from Gooten'));
  });
  r.get('/vendors/gooten/products', ...staff, async (_req, res) => {
    res.json(ok(await svc.listLinks()));
  });
  r.patch('/vendors/gooten/products/:id', ...staff, async (req, res) => {
    const id = pathUuid(req.params.id);
    res.json(ok(await svc.updateLink(id, parseBody(GootenLinkUpdateSchema, req.body)), 'Saved'));
  });

  r.get('/vendors/gooten/orders', ...admin, async (_req, res) => {
    res.json(ok(await svc.listOrders()));
  });
  r.post('/vendors/gooten/orders/:orderId/submit', ...admin, async (req, res) => {
    const orderId = pathUuid(req.params.orderId, 'orderId');
    const input = parseBody(GootenSubmitSchema, req.body);
    res.status(201).json(created(await svc.submitOrder(orderId, input.shipMethod ?? 'STANDARD', actor(req)), 'Order sent to Gooten'));
  });
  r.post('/vendors/gooten/submissions/:id/refresh', ...admin, async (req, res) => {
    res.json(ok(await svc.refreshSubmission(pathUuid(req.params.id))));
  });

  return r;
}
