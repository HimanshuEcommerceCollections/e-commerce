import { createHash } from 'node:crypto';
import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { parseBody, ValidationError } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import { IntegrationCreateSchema, IntegrationUpdateSchema } from './integration.service';
import { auditActor } from '../audit/audit.service';

/** What the audit log keeps of an integration: never secret values, only which secrets are set. */
const auditView = (v: {
  name: string;
  enabled: boolean;
  baseUrl: string | null;
  settings: Record<string, unknown>;
  notes: string | null;
  secrets: Array<{ name: string; hint: string }>;
}) => ({
  name: v.name,
  enabled: v.enabled,
  baseUrl: v.baseUrl,
  settings: v.settings,
  notes: v.notes,
  // A fingerprint of the hint shows that a secret was replaced without keeping any of it.
  secrets: v.secrets.map((s) => `${s.name} (${createHash('sha256').update(s.hint).digest('hex').slice(0, 8)})`),
});

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
    const row = await svc.create(input, actor(req));
    await c.audit.record({
      action: 'integration.created',
      category: 'integration',
      actor: auditActor(currentUser(req)),
      source: 'API integrations',
      entity: { type: 'integration', id: row.id, code: row.slug, label: row.name },
      summary: `Added the ${row.providerLabel} integration ${row.name}`,
      before: '—',
      after: row.enabled ? 'Enabled' : 'Disabled',
      details: { after: auditView(row) },
    });
    res.status(201).json(created(row, 'Integration added'));
  });
  r.get('/integrations/:slug', ...admin, async (req, res) => {
    res.json(ok(await svc.get(slug(req.params.slug))));
  });
  r.patch('/integrations/:slug', ...admin, async (req, res) => {
    const input = parseBody(IntegrationUpdateSchema, req.body);
    const before = auditView(await svc.get(slug(req.params.slug)));
    const row = await svc.update(slug(req.params.slug), input, actor(req));
    const after = auditView(row);
    const changed = (Object.keys(after) as Array<keyof typeof after>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) {
      await c.audit.record({
        action: 'integration.updated',
        category: 'integration',
        actor: auditActor(currentUser(req)),
        source: 'API integrations',
        entity: { type: 'integration', id: row.id, code: row.slug, label: row.name },
        summary: `Changed ${changed.join(', ')} of ${row.name}`,
        before: changed.map((k) => `${k}: ${JSON.stringify(before[k])}`).join(' · '),
        after: changed.map((k) => `${k}: ${JSON.stringify(after[k])}`).join(' · '),
        details: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) },
      });
    }
    res.json(ok(row, 'Integration saved'));
  });
  r.delete('/integrations/:slug', ...admin, async (req, res) => {
    const before = await svc.get(slug(req.params.slug));
    const result = await svc.remove(slug(req.params.slug));
    await c.audit.record({
      action: 'integration.removed',
      category: 'integration',
      actor: auditActor(currentUser(req)),
      source: 'API integrations',
      entity: { type: 'integration', id: before.id, code: before.slug, label: before.name },
      summary: `Removed the ${before.providerLabel} integration ${before.name}`,
      before: before.enabled ? 'Enabled' : 'Disabled',
      after: 'Removed',
      details: { before: auditView(before) },
    });
    res.json(ok(result, 'Integration removed'));
  });
  r.post('/integrations/:slug/test', ...admin, async (req, res) => {
    res.json(ok(await svc.test(slug(req.params.slug))));
  });

  return r;
}
