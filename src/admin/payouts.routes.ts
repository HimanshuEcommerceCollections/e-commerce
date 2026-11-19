import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { parsePageable } from '../common/pagination';
import { ValidationError } from '../common/validation';
import type { Container } from '../container';

/**
 * Seller payouts for the payments team (ROLE_ADMIN): the weekly list, closing
 * a week by hand (the Friday cron does it on Vercel), and marking a payout
 * paid once the money is sent.
 */
export function adminPayoutRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];

  r.get('/payouts', ...admin, async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    if (status && status !== 'SCHEDULED' && status !== 'PAID') throw new ValidationError({ status: 'must be SCHEDULED or PAID' });
    const pageable = parsePageable(req, { sort: 'scheduledFor,desc', allowedSorts: ['scheduledFor'] });
    res.json(ok(await c.sellerOrders.adminPayouts(status, pageable)));
  });
  r.post('/payouts/close-week', ...admin, async (_req, res) => {
    const result = await c.sellerOrders.closeWeek();
    res.json(ok(result, result.payouts.length ? `Created ${result.payouts.length} payout(s)` : 'No delivered orders waiting for a payout'));
  });
  r.post('/payouts/:reference/paid', ...admin, async (req, res) => {
    const ref = String(req.params.reference ?? '');
    if (!/^PO-\d{1,10}$/.test(ref)) throw new ValidationError({ reference: 'is not a payout reference' });
    res.json(ok(await c.sellerOrders.markPaid(ref, currentUser(req).email), `${ref} marked as paid`));
  });
  return r;
}
