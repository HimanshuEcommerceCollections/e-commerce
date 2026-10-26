import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { SELLER_APPLICATION_STATUSES, SUPPORT_MESSAGE_STATUSES } from '../common/enums';
import { parsePageable } from '../common/pagination';
import { parseBody, pathUuid, ValidationError } from '../common/validation';
import type { Container } from '../container';
import { INBOX_SORTS, SellerApplicationUpdateSchema, SupportMessageUpdateSchema } from './inbox.service';

/**
 * Admin inbox (contract D1): help-center messages, seller applications and
 * the badge counts for the admin nav. ROLE_ADMIN only; mounted at /api/admin
 * with per-route guards like the other admin routers.
 */
export function adminInboxRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];
  const query = (req: express.Request, name: string) => {
    const v = req.query[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const filter = <S extends string>(req: express.Request, statuses: readonly S[]) => {
    const status = query(req, 'status');
    if (status !== undefined && !(statuses as readonly string[]).includes(status)) {
      throw new ValidationError({ status: `must be one of ${statuses.join(', ')}` });
    }
    return { status: status as S | undefined, search: query(req, 'q') ?? query(req, 'search') };
  };
  const pageable = (req: express.Request) => parsePageable(req, { sort: 'createdAt,desc', allowedSorts: INBOX_SORTS });
  const adminEmail = (req: express.Request) => currentUser(req).email;

  r.get('/inbox/counts', ...admin, async (_req, res) => {
    res.json(ok(await c.adminInbox.counts()));
  });

  r.get('/support-messages', ...admin, async (req, res) => {
    res.json(ok(await c.adminInbox.listMessages(filter(req, SUPPORT_MESSAGE_STATUSES), pageable(req))));
  });
  r.get('/support-messages/:id', ...admin, async (req, res) => {
    res.json(ok(await c.adminInbox.getMessage(pathUuid(req.params.id))));
  });
  r.patch('/support-messages/:id', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(SupportMessageUpdateSchema, req.body);
    res.json(ok(await c.adminInbox.updateMessage(id, input, adminEmail(req)), 'Message updated'));
  });

  r.get('/seller-applications', ...admin, async (req, res) => {
    res.json(ok(await c.adminInbox.listApplications(filter(req, SELLER_APPLICATION_STATUSES), pageable(req))));
  });
  r.get('/seller-applications/:id', ...admin, async (req, res) => {
    res.json(ok(await c.adminInbox.getApplication(pathUuid(req.params.id))));
  });
  r.patch('/seller-applications/:id', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(SellerApplicationUpdateSchema, req.body);
    res.json(ok(await c.adminInbox.updateApplication(id, input, adminEmail(req)), 'Application updated'));
  });

  return r;
}
