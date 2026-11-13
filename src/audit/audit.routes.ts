import express, { Router } from 'express';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { parsePageable } from '../common/pagination';
import { ValidationError, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import { AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_SORTS, isAuditCategory, type AuditActorType, type AuditFilter } from './audit.service';

const text = (req: express.Request, name: string, max = 200) => {
  const v = req.query[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ValidationError({ [name]: `must be text of at most ${max} characters` });
  return v.trim() || undefined;
};

const date = (req: express.Request, name: string, endOfDay = false) => {
  const v = text(req, name, 40);
  if (v === undefined) return undefined;
  // A bare date covers that whole day.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new ValidationError({ [name]: 'must be an ISO date or date-time' });
  return d;
};

/** The filters shared by the list and the CSV export. */
export function auditFilter(req: express.Request): AuditFilter {
  const days = text(req, 'days', 5);
  let from = date(req, 'from');
  if (days !== undefined) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new ValidationError({ days: 'must be an integer from 1 to 3650' });
    from = new Date(Date.now() - n * 86_400_000);
  }
  const categories = text(req, 'category', 300)?.split(',').map((c) => c.trim()).filter(Boolean);
  if (categories?.some((c) => !isAuditCategory(c))) {
    throw new ValidationError({ category: `must be one of ${Object.keys(AUDIT_CATEGORIES).join(', ')}` });
  }
  const actorType = text(req, 'actorType', 10);
  if (actorType !== undefined && !(AUDIT_ACTOR_TYPES as readonly string[]).includes(actorType)) {
    throw new ValidationError({ actorType: `must be one of ${AUDIT_ACTOR_TYPES.join(', ')}` });
  }
  const alerts = text(req, 'alerts', 5);
  if (alerts !== undefined && alerts !== 'true' && alerts !== 'false') throw new ValidationError({ alerts: 'must be true or false' });
  const actorId = text(req, 'actorId', 36);
  const sellerId = text(req, 'sellerId', 36);
  return {
    from,
    to: date(req, 'to', true),
    categories: categories as AuditFilter['categories'],
    action: text(req, 'action', 60),
    actorType: actorType as AuditActorType | undefined,
    actorId: actorId ? pathUuid(actorId, 'actorId') : undefined,
    sellerId: sellerId ? pathUuid(sellerId, 'sellerId') : undefined,
    entityType: text(req, 'entityType', 30),
    entityId: text(req, 'entityId', 100),
    entityCode: text(req, 'entityCode', 255),
    q: text(req, 'q'),
    alerts: alerts === 'true',
  };
}

/**
 * Catalog audit log, mounted on /api/admin (catalog staff and admins). Read
 * only: records can't be edited or deleted.
 */
export function adminAuditRoutes(c: Container): Router {
  const r = Router();
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];

  r.get('/audit-events', ...staff, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'createdAt,desc', allowedSorts: AUDIT_SORTS });
    res.json(ok(await c.audit.list(auditFilter(req), pageable)));
  });
  r.get('/audit-events/stats', ...staff, async (_req, res) => {
    res.json(ok(await c.audit.stats()));
  });
  r.get('/audit-events/export', ...staff, async (req, res) => {
    const { csv, rows } = await c.audit.exportCsv(auditFilter(req));
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .type('text/csv; charset=utf-8')
      .attachment(`audit-log-${stamp}.csv`)
      .set('X-Total-Rows', String(rows))
      .send(`﻿${csv}`);
  });
  r.get('/audit-events/:id', ...staff, async (req, res) => {
    res.json(ok(await c.audit.get(String(req.params.id))));
  });
  return r;
}
