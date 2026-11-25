import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, noContent, ok } from '../common/api-response';
import type { Pageable } from '../common/pagination';
import { ValidationError, parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { CUSTOMER_SORTS, CustomerCreateSchema, CustomerUpdateSchema, type CustomerSort } from './crm.customers.service';
import {
  CUSTOMER_TAG_FILTERS,
  LOST_REASONS,
  MANUAL_CUSTOMER_TAGS,
  PIPELINE_STAGES,
  AUTO_STAGES,
  REQUESTER_KINDS,
  SLA_HOURS,
  SUPPLIER_SOURCES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_VIEWS,
  staffFrom,
  type TicketView,
} from './crm.shared';
import { StageMoveSchema, SupplierCreateSchema, SupplierUpdateSchema } from './crm.suppliers.service';
import { TicketCreateSchema, TicketMessageSchema, TicketUpdateSchema } from './crm.tickets.service';
import { ActivityCreateSchema, CALL_OUTCOMES, TASK_TABS, TaskCreateSchema, TaskUpdateSchema, type TaskTab } from './crm.work.service';

const query = (req: express.Request, name: string) => {
  const v = req.query[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

/** The browser's `getTimezoneOffset()` (minutes behind UTC), so "today" is the admin's today. */
const tzOf = (req: express.Request) => {
  const v = Number(query(req, 'tz') ?? 0);
  return Number.isFinite(v) ? Math.max(-840, Math.min(840, Math.trunc(v))) : 0;
};

/** `page` (from 0) and `size` (default 25, at most 200). Lists here are ordered by the CRM, not by a `sort` the caller names. */
const pageOf = (req: express.Request, size = 25): Pageable => {
  const page = Number(query(req, 'page') ?? 0);
  const asked = Number(query(req, 'size') ?? size);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 0,
    size: Number.isInteger(asked) && asked > 0 ? Math.min(asked, 200) : size,
    sort: [],
  };
};

const oneOfQuery = <T extends string>(req: express.Request, name: string, values: readonly T[]): T | undefined => {
  const v = query(req, name);
  if (v === undefined) return undefined;
  if (!(values as readonly string[]).includes(v)) throw new ValidationError({ [name]: `must be one of ${values.join(', ')}` });
  return v as T;
};

/**
 * CRM (designs/crm), inside the admin portal: the team's view of customers,
 * suppliers and the tickets they raise, with tasks, notes and a dashboard.
 * ROLE_ADMIN only (it shows customers' contact details and spend). Mounted at
 * /api/admin/crm.
 *
 * Every read first brings the CRM up to date with the help center, the Seller
 * Portal and seller applications (see CrmIngestService), so a ticket raised a
 * moment ago is already in the queue.
 */
export function adminCrmRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];
  const crm = c.crm;
  const staff = (req: express.Request) => staffFrom(c.prisma, currentUser(req));

  r.use('/crm', ...admin, async (req, _res, next) => {
    if (req.method === 'GET') await crm.ingest.sync();
    next();
  });

  // ── Shell ─────────────────────────────────────────────────────────────────

  /** The words the screens use: types, priorities, stages, and the reply-time targets. */
  r.get('/crm/meta', (_req, res) => {
    res.json(
      ok({
        ticketStatuses: TICKET_STATUSES,
        ticketPriorities: TICKET_PRIORITIES,
        ticketCategories: TICKET_CATEGORIES,
        ticketViews: TICKET_VIEWS,
        requesterKinds: REQUESTER_KINDS,
        replyHours: SLA_HOURS,
        stages: PIPELINE_STAGES.map(([key, label, description]) => ({ key, label, description, auto: (AUTO_STAGES as readonly string[]).includes(key) })),
        lostReasons: LOST_REASONS,
        supplierSources: SUPPLIER_SOURCES,
        customerTags: CUSTOMER_TAG_FILTERS,
        manualCustomerTags: MANUAL_CUSTOMER_TAGS,
        callOutcomes: CALL_OUTCOMES,
        atRiskDays: c.config.crm.atRiskDays,
        stuckDays: c.config.crm.stuckDays,
      }),
    );
  });

  /** The team, and who is asking. */
  r.get('/crm/team', async (req, res) => {
    const me = currentUser(req);
    res.json(ok({ members: await crm.team.list(), me: me.id }));
  });

  /** Counts for the admin sidebar badge. */
  r.get('/crm/summary', async (req, res) => {
    res.json(ok({ tickets: await crm.tickets.counts(currentUser(req).id) }));
  });

  r.get('/crm/dashboard', async (req, res) => {
    res.json(ok(await crm.work.dashboard(currentUser(req).id, tzOf(req))));
  });

  r.get('/crm/notifications', async (req, res) => {
    res.json(ok(await crm.work.notifications(currentUser(req).id, tzOf(req))));
  });

  r.get('/crm/search', async (req, res) => {
    const limit = Math.max(1, Math.min(20, Number(query(req, 'limit') ?? 6) || 6));
    res.json(ok(await crm.work.search((query(req, 'q') ?? '').slice(0, 100), limit)));
  });

  /** Copies the latest tickets and applications now, without waiting for the next read. */
  r.post('/crm/sync', async (_req, res) => {
    await crm.ingest.sync(true);
    res.json(noContent('Up to date'));
  });

  // ── Tickets ───────────────────────────────────────────────────────────────

  r.get('/crm/tickets', async (req, res) => {
    const filter = {
      view: oneOfQuery(req, 'view', TICKET_VIEWS) ?? ('open' as TicketView),
      who: oneOfQuery(req, 'who', REQUESTER_KINDS),
      q: query(req, 'q')?.slice(0, 100),
    };
    res.json(ok(await crm.tickets.list(filter, currentUser(req).id, pageOf(req, 50))));
  });
  r.post('/crm/tickets', async (req, res) => {
    const input = parseBody(TicketCreateSchema, req.body);
    const ticket = await crm.tickets.create(input, await staff(req));
    res.status(201).json(created(ticket, `Ticket ${ticket.reference} created`));
  });
  r.get('/crm/tickets/:reference', async (req, res) => {
    res.json(ok(await crm.tickets.get(String(req.params.reference))));
  });
  r.patch('/crm/tickets/:reference', async (req, res) => {
    const input = parseBody(TicketUpdateSchema, req.body);
    res.json(ok(await crm.tickets.update(String(req.params.reference), input, await staff(req)), 'Ticket updated'));
  });
  r.post('/crm/tickets/:reference/messages', async (req, res) => {
    const input = parseBody(TicketMessageSchema, req.body);
    const message = input.mode === 'note' ? 'Note added' : input.after === 'solved' ? 'Sent. Ticket solved' : 'Sent. Waiting on their reply';
    res.status(201).json(created(await crm.tickets.addMessage(String(req.params.reference), input, await staff(req)), message));
  });

  // ── Customers ─────────────────────────────────────────────────────────────

  r.get('/crm/customers', async (req, res) => {
    const sort = oneOfQuery(req, 'sort', CUSTOMER_SORTS) ?? ('last' as CustomerSort);
    const owner = query(req, 'owner');
    if (owner && owner !== 'none') pathUuid(owner, 'owner');
    const tag = oneOfQuery(req, 'tag', CUSTOMER_TAG_FILTERS);
    const filter = { q: query(req, 'q')?.slice(0, 100), tag, owner, sort, dir: query(req, 'dir') === 'asc' ? (1 as const) : (-1 as const) };
    res.json(ok(await crm.customers.list(filter, pageOf(req))));
  });
  r.post('/crm/customers', async (req, res) => {
    const input = parseBody(CustomerCreateSchema, req.body);
    res.status(201).json(created(await crm.customers.create(input), 'Customer added'));
  });
  r.get('/crm/customers/:id', async (req, res) => {
    res.json(ok(await crm.customers.get(pathUuid(req.params.id))));
  });
  r.patch('/crm/customers/:id', async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(CustomerUpdateSchema, req.body);
    res.json(ok(await crm.customers.update(id, input, await staff(req)), 'Customer updated'));
  });
  r.post('/crm/customers/:id/activities', async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(ActivityCreateSchema, req.body);
    await crm.customers.emailOf(id); // 404 for an unknown customer before anything is written
    res.status(201).json(created(await crm.work.addActivity({ customerId: id }, input, await staff(req)), activityMessage(input.kind)));
  });

  // ── Suppliers ─────────────────────────────────────────────────────────────

  r.get('/crm/suppliers', async (req, res) => {
    const owner = query(req, 'owner');
    if (owner && owner !== 'none') pathUuid(owner, 'owner');
    res.json(ok(await crm.suppliers.list({ q: query(req, 'q')?.slice(0, 100), owner, includeLost: query(req, 'includeLost') === 'true' })));
  });
  r.post('/crm/suppliers', async (req, res) => {
    const input = parseBody(SupplierCreateSchema, req.body);
    const s = await crm.suppliers.create(input, await staff(req));
    res.status(201).json(created(s, `${s.company} added to Lead`));
  });
  r.get('/crm/suppliers/:id', async (req, res) => {
    res.json(ok(await crm.suppliers.get(pathUuid(req.params.id))));
  });
  r.patch('/crm/suppliers/:id', async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(SupplierUpdateSchema, req.body);
    res.json(ok(await crm.suppliers.update(id, input, await staff(req)), 'Supplier updated'));
  });
  r.post('/crm/suppliers/:id/stage', async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(StageMoveSchema, req.body);
    res.json(ok(await crm.suppliers.moveStage(id, input, await staff(req)), 'Stage updated'));
  });
  r.post('/crm/suppliers/:id/activities', async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(ActivityCreateSchema, req.body);
    await crm.suppliers.emailOf(id);
    res.status(201).json(created(await crm.work.addActivity({ supplierId: id }, input, await staff(req)), activityMessage(input.kind)));
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  r.get('/crm/tasks', async (req, res) => {
    const owner = query(req, 'owner');
    const me = currentUser(req).id;
    if (owner && owner !== 'me' && owner !== 'all') pathUuid(owner, 'owner');
    const customerId = query(req, 'customerId');
    const supplierId = query(req, 'supplierId');
    res.json(
      ok(
        await crm.work.listTasks({
          owner: owner === 'me' ? me : owner,
          tab: oneOfQuery(req, 'tab', TASK_TABS) as TaskTab | undefined,
          customerId: customerId ? pathUuid(customerId, 'customerId') : undefined,
          supplierId: supplierId ? pathUuid(supplierId, 'supplierId') : undefined,
          tz: tzOf(req),
        }),
      ),
    );
  });
  r.post('/crm/tasks', async (req, res) => {
    const input = parseBody(TaskCreateSchema, req.body);
    res.status(201).json(created(await crm.work.createTask(input, await staff(req)), 'Task added'));
  });
  r.patch('/crm/tasks/:id', async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(TaskUpdateSchema, req.body);
    const task = await crm.work.updateTask(id, input, await staff(req));
    res.json(ok(task, input.done === undefined ? 'Task updated' : input.done ? 'Task done' : 'Task reopened'));
  });
  r.delete('/crm/tasks/:id', async (req, res) => {
    await crm.work.deleteTask(pathUuid(req.params.id));
    res.json(noContent('Task deleted'));
  });

  return r;
}

const activityMessage = (kind: 'note' | 'call' | 'email' | undefined) =>
  kind === 'call' ? 'Call logged' : kind === 'email' ? 'Email sent and logged' : 'Note saved';
