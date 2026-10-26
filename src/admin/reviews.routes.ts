import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { REVIEW_STATUSES } from '../common/enums';
import { parsePageable } from '../common/pagination';
import { parseBody, pathUuid, ValidationError } from '../common/validation';
import type { Container } from '../container';
import { ADMIN_REVIEW_SORTS, isReviewStatus, ReviewRejectSchema } from '../account/reviews.service';
import { staffActor } from '../order/order-events';
import { CATALOG_ROLES } from '../routes';

/**
 * Review moderation, mounted on /api/admin. Catalog staff and admins; guards
 * are per route so other /api/admin paths fall through untouched.
 */
export function adminReviewRoutes(c: Container): Router {
  const r = Router();
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];
  const actor = (req: express.Request) => staffActor(currentUser(req));

  r.get('/reviews', ...staff, async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : undefined;
    if (status !== undefined && !isReviewStatus(status)) {
      throw new ValidationError({ status: `must be one of ${REVIEW_STATUSES.join(', ')}` });
    }
    const pageable = parsePageable(req, { sort: 'createdAt,desc', allowedSorts: ADMIN_REVIEW_SORTS });
    res.json(ok(await c.reviews.adminList(status, pageable)));
  });
  r.post('/reviews/:id/publish', ...staff, async (req, res) => {
    res.json(ok(await c.reviews.publish(pathUuid(req.params.id), actor(req)), 'Review published'));
  });
  r.post('/reviews/:id/reject', ...staff, async (req, res) => {
    const id = pathUuid(req.params.id);
    const { note } = parseBody(ReviewRejectSchema, req.body);
    res.json(ok(await c.reviews.reject(id, note, actor(req)), 'Review rejected'));
  });
  return r;
}
