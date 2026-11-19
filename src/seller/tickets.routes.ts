import express, { Router } from 'express';
import multer from 'multer';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { parsePageable } from '../common/pagination';
import { ValidationError, parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  TICKET_TABS,
  TicketCreateSchema,
  TicketReplySchema,
  type TicketTab,
  type UploadedAttachment,
} from './tickets.service';

const files = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS } });

/** Multipart fields arrive as strings: urgent=true/false; JSON bodies pass through. */
const fields = (req: express.Request) => {
  const b = { ...(req.body ?? {}) } as Record<string, unknown>;
  for (const k of ['urgent', 'resolve']) if (typeof b[k] === 'string') b[k] = b[k] === 'true';
  for (const k of Object.keys(b)) if (b[k] === '') delete b[k];
  return b;
};
const uploaded = (req: express.Request) => ((req.files as Express.Multer.File[] | undefined) ?? []) as UploadedAttachment[];

const reference = (req: express.Request) => {
  const ref = String(req.params.reference ?? '');
  if (!/^T-\d{1,10}$/.test(ref)) throw new ValidationError({ reference: 'is not a ticket reference' });
  return ref;
};
const tabOf = (req: express.Request): TicketTab => {
  const raw = typeof req.query.tab === 'string' && req.query.tab ? req.query.tab : 'open';
  if (!(TICKET_TABS as readonly string[]).includes(raw)) throw new ValidationError({ tab: `must be one of ${TICKET_TABS.join(', ')}` });
  return raw as TicketTab;
};

async function person(c: Container, req: express.Request) {
  const u = currentUser(req);
  const row = await c.prisma.user.findUnique({ where: { id: u.id }, select: { fullName: true } });
  return { id: u.id, email: u.email, name: row?.fullName || u.email };
}

const sendFile = (res: express.Response, a: { fileName: string; contentType: string; content: Uint8Array }) => {
  res.type(a.contentType).attachment(a.fileName).send(Buffer.from(a.content));
};

/**
 * Help & support for sellers (designs/seller/seller-support.html), mounted on
 * /api/seller inside sellerRoutes (ROLE_MERCHANT). Attachments are multipart
 * 'files' (up to 5, 4 MB each).
 */
export function sellerTicketRoutes(c: Container): Router {
  const r = Router();
  const t = c.sellerTickets;

  r.get('/tickets', async (req, res) => {
    res.json(ok(await t.list(await person(c, req), tabOf(req))));
  });
  r.get('/tickets/waiting-count', async (req, res) => {
    res.json(ok({ waiting: await t.waitingCount(currentUser(req).id) }));
  });
  r.post('/tickets', files.array('files', MAX_ATTACHMENTS), async (req, res) => {
    const input = parseBody(TicketCreateSchema, fields(req));
    const ticket = await t.create(await person(c, req), input, uploaded(req));
    res.status(201).json(ok(ticket, `Ticket ${ticket.reference} raised`));
  });
  r.get('/tickets/:reference', async (req, res) => {
    res.json(ok(await t.get(await person(c, req), reference(req))));
  });
  r.post('/tickets/:reference/messages', files.array('files', MAX_ATTACHMENTS), async (req, res) => {
    const input = parseBody(TicketReplySchema, fields(req));
    res.json(ok(await t.reply(await person(c, req), reference(req), input.body, uploaded(req)), 'Reply sent'));
  });
  r.post('/tickets/:reference/resolve', async (req, res) => {
    res.json(ok(await t.resolve(await person(c, req), reference(req)), 'Ticket resolved'));
  });
  r.post('/tickets/:reference/reopen', async (req, res) => {
    res.json(ok(await t.reopen(await person(c, req), reference(req)), 'Ticket reopened'));
  });
  r.get('/tickets/:reference/attachments/:id', async (req, res) => {
    sendFile(res, await t.attachment(reference(req), pathUuid(req.params.id), currentUser(req).id));
  });
  return r;
}

/** The staff side (ROLE_ADMIN, ROLE_CATALOG): every seller ticket, replies, assignment, resolving. */
export function adminSellerTicketRoutes(c: Container): Router {
  const r = Router();
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];
  const t = c.sellerTickets;

  r.get('/seller-tickets', ...staff, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'lastMessageAt,desc', allowedSorts: ['lastMessageAt'] });
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
    res.json(ok(await t.adminList({ tab: tabOf(req), q, mine: req.query.mine === 'true' }, currentUser(req).id, pageable)));
  });
  r.get('/seller-tickets/:reference', ...staff, async (req, res) => {
    res.json(ok(await t.adminGet(reference(req))));
  });
  r.post('/seller-tickets/:reference/messages', ...staff, files.array('files', MAX_ATTACHMENTS), async (req, res) => {
    const input = parseBody(TicketReplySchema, fields(req));
    res.json(ok(await t.staffReply(await person(c, req), reference(req), input, uploaded(req)), input.resolve ? 'Ticket resolved' : 'Reply sent'));
  });
  r.post('/seller-tickets/:reference/assign', ...staff, async (req, res) => {
    res.json(ok(await t.assign(await person(c, req), reference(req)), 'Assigned to you'));
  });
  r.get('/seller-tickets/:reference/attachments/:id', ...staff, async (req, res) => {
    sendFile(res, await t.attachment(reference(req), pathUuid(req.params.id)));
  });
  return r;
}
