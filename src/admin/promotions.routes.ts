import express, { Router } from 'express';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { parsePageable } from '../common/pagination';
import { parseBody, pathUuid, ValidationError } from '../common/validation';
import type { Container } from '../container';
import { ADMIN_PROMOTION_SORTS, PromotionCreateSchema, PromotionUpdateSchema } from './promotions.service';

/** Promotion codes (contract D3). ROLE_ADMIN only; DELETE deactivates. */
export function adminPromotionRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];

  r.get('/promotions', ...admin, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const active = req.query.active;
    if (active !== undefined && active !== 'true' && active !== 'false') {
      throw new ValidationError({ active: 'must be true or false' });
    }
    const pageable = parsePageable(req, { sort: 'createdAt,desc', allowedSorts: ADMIN_PROMOTION_SORTS });
    res.json(ok(await c.adminPromotions.list({ search: q, active: active === undefined ? undefined : active === 'true' }, pageable)));
  });
  r.get('/promotions/:id', ...admin, async (req, res) => {
    res.json(ok(await c.adminPromotions.get(pathUuid(req.params.id))));
  });
  r.post('/promotions', ...admin, async (req, res) => {
    const input = parseBody(PromotionCreateSchema, req.body);
    res.status(201).json(created(await c.adminPromotions.create(input), 'Promotion created'));
  });
  r.patch('/promotions/:id', ...admin, async (req: express.Request, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(PromotionUpdateSchema, req.body);
    res.json(ok(await c.adminPromotions.update(id, input), 'Promotion updated'));
  });
  r.delete('/promotions/:id', ...admin, async (req, res) => {
    res.json(ok(await c.adminPromotions.deactivate(pathUuid(req.params.id)), 'Promotion deactivated'));
  });

  return r;
}
