import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { parseBody, ValidationError } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import { IntegrationCreateSchema, IntegrationUpdateSchema } from './integration.service';

/**
 * Admin › Settings › API integrations. Managing connections and secrets is
 * admin only; the sidebar list (no secrets) is open to catalog staff too.
 */
export function integrationRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];
  const svc = c.integrations;
  const actor = (req: express.Request) => currentUser(req).email;
  const slug = (v: string | string[] | undefined) => {
    if (typeof v !== 'string' || !/^[a-z0-9-]{1,60}$/.test(v)) throw new ValidationError({ slug: 'invalid integration' });
    return v;
  };

  r.get('/integrations-nav', ...staff, async (_req, res) => {
    res.json(ok(await svc.nav()));
  });
  r.get('/integrations/providers', ...admin, async (_req, res) => {
    res.json(ok(svc.providers()));
  });
  r.get('/integrations', ...admin, async (_req, res) => {
    res.json(ok(await svc.list()));
  });
  r.post('/integrations', ...admin, async (req, res) => {
    const input = parseBody(IntegrationCreateSchema, req.body);
    res.status(201).json(created(await svc.create(input, actor(req)), 'Integration added'));
  });
  r.get('/integrations/:slug', ...admin, async (req, res) => {
    res.json(ok(await svc.get(slug(req.params.slug))));
  });
  r.patch('/integrations/:slug', ...admin, async (req, res) => {
    const input = parseBody(IntegrationUpdateSchema, req.body);
    res.json(ok(await svc.update(slug(req.params.slug), input, actor(req)), 'Integration saved'));
  });
  r.delete('/integrations/:slug', ...admin, async (req, res) => {
    res.json(ok(await svc.remove(slug(req.params.slug)), 'Integration removed'));
  });
  r.post('/integrations/:slug/test', ...admin, async (req, res) => {
    res.json(ok(await svc.test(slug(req.params.slug))));
  });

  return r;
}
