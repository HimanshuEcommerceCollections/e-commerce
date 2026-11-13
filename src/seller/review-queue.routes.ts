import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { parsePageable } from '../common/pagination';
import { ValidationError, parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import {
  BulkApproveSchema,
  DecisionSchema,
  FIX_OPTIONS,
  QUEUE_VIEWS,
  REJECT_REASONS,
  isQueueView,
  isSubmissionKind,
} from './review-queue.service';
import type { Actor } from './submission.service';

const actor = (req: express.Request): Actor => {
  const u = currentUser(req);
  return { id: u.id, email: u.email };
};

const reference = (value: string | string[] | undefined) => {
  if (typeof value !== 'string' || !/^PS-\d{6}$/i.test(value)) throw new ValidationError({ reference: 'must be a submission reference (PS-123456)' });
  return value.toUpperCase();
};

const DONE: Record<string, string> = { approve: 'Approved', 'request-changes': 'Sent back with your notes', reject: 'Rejected' };

/**
 * The review queue's tabs, automatic checks, price history, structured
 * decisions and bulk approval, mounted on /api/admin (catalog staff and
 * admins). The plain decision routes stay on /api/admin/submissions.
 */
export function adminReviewQueueRoutes(c: Container): Router {
  const r = Router();
  const svc = c.reviewQueue;
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];

  r.get('/review-queue', ...staff, async (req, res) => {
    const view = typeof req.query.view === 'string' && req.query.view ? req.query.view : 'all';
    if (!isQueueView(view)) throw new ValidationError({ view: `must be one of ${QUEUE_VIEWS.join(', ')}` });
    const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : undefined;
    if (kind !== undefined && !isSubmissionKind(kind)) throw new ValidationError({ kind: 'must be one of NEW_PRODUCT, EDIT, DELIST' });
    const merchantId = typeof req.query.merchantId === 'string' && req.query.merchantId ? pathUuid(req.query.merchantId, 'merchantId') : undefined;
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 200) : undefined;
    // Ordering is fixed (oldest first; newest first for "reviewed"), so only page and size count.
    const pageable = parsePageable(req, { sort: 'submittedAt,asc', allowedSorts: ['submittedAt'] });
    res.json(ok(await svc.queue({ view, kind, merchantId, q }, actor(req), pageable)));
  });
  r.get('/review-queue/counts', ...staff, async (req, res) => {
    res.json(ok(await svc.counts(actor(req))));
  });
  r.get('/review-queue/reasons', ...staff, (_req, res) => {
    res.json(ok({ rejectReasons: REJECT_REASONS, fixOptions: FIX_OPTIONS }));
  });
  r.post('/review-queue/bulk-approve', ...staff, async (req, res) => {
    const { references, note } = parseBody(BulkApproveSchema, req.body);
    const result = await svc.bulkApprove(references, actor(req), note);
    res.json(ok(result, `${result.approved} approved${result.skipped ? `, ${result.skipped} skipped` : ''}`));
  });
  r.get('/review-queue/:ref', ...staff, async (req, res) => {
    res.json(ok(await svc.item(reference(req.params.ref), actor(req))));
  });
  r.post('/review-queue/:ref/decision', ...staff, async (req, res) => {
    const input = parseBody(DecisionSchema, req.body);
    res.json(ok(await svc.decide(reference(req.params.ref), input, actor(req)), DONE[input.decision]));
  });
  return r;
}
