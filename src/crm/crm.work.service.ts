import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { integer, oneOf, optionalString, optionalUuid, requiredString, ValidationError } from '../common/validation';
import type { Config } from '../config';
import type { Mailer } from '../notify/mailer';
import type { CrmCustomerService } from './crm.customers.service';
import type { CrmSupplierService } from './crm.suppliers.service';
import type { CrmTicketService } from './crm.tickets.service';
import {
  DAY,
  STAGE_LABEL,
  dayStart,
  logActivity,
  memberOf,
  nullableUuid,
  ticketRef,
  type PipelineStage,
  type Staff,
  type Team,
} from './crm.shared';

/** A date (`2026-11-30`, taken as noon) or a full timestamp. */
const due = z.unknown().transform((v, ctx): Date | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pick a due date' });
  return z.NEVER;
});

export const TaskCreateSchema = z.object({
  title: requiredString({ min: 3, max: 300, blankMessage: 'Describe the task', sizeMessage: 'Describe the task' }),
  customerId: optionalUuid(),
  supplierId: optionalUuid(),
  due,
  /** Omitted = the person adding it; null = nobody. */
  ownerId: nullableUuid,
});

export const TaskUpdateSchema = z.object({
  done: z.boolean().optional(),
  title: optionalString({ min: 3, max: 300 }),
  due,
  ownerId: nullableUuid,
});

export const CALL_OUTCOMES = ['Talked', 'Left voicemail', 'No answer', 'Wrong number'] as const;

export const ActivityCreateSchema = z.object({
  kind: oneOf(['note', 'call', 'email'] as const),
  body: requiredString({ max: 1800, blankMessage: 'Write something first', sizeMessage: 'Keep it under 1,800 characters' }),
  /** Emails only. */
  subject: optionalString({ max: 200 }),
  /** Calls only. */
  outcome: oneOf(CALL_OUTCOMES),
  minutes: integer({ positiveOrZero: true, max: 600 }),
});

export const TASK_TABS = ['today', 'up', 'done'] as const;
export type TaskTab = (typeof TASK_TABS)[number];

type Subject = { customerId: string } | { supplierId: string };

const TASK_INCLUDE = {
  customer: { include: { user: { select: { fullName: true, email: true } } } },
  supplier: { select: { id: true, number: true, company: true } },
} satisfies Prisma.CrmTaskInclude;
type TaskRow = Prisma.CrmTaskGetPayload<{ include: typeof TASK_INCLUDE }>;

/**
 * Tasks, history lines, notifications, the dashboard and search: the parts of
 * the CRM that look across customers, suppliers and tickets.
 */
export class CrmWorkService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly team: Team,
    private readonly mailer: Mailer,
    private readonly config: Config,
    private readonly customers: CrmCustomerService,
    private readonly suppliers: CrmSupplierService,
    private readonly tickets: CrmTicketService,
  ) {}

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /**
   * Tasks for one teammate (`owner` = their id, 'all' = everyone) or about one
   * contact. `tab` splits the teammate's list the way the dashboard does:
   * today (and overdue), upcoming, done.
   */
  async listTasks(
    filter: { owner?: string; tab?: TaskTab; customerId?: string; supplierId?: string; tz: number },
  ) {
    const now = new Date();
    const endOfToday = new Date(dayStart(now, filter.tz).getTime() + DAY);
    const base: Prisma.CrmTaskWhereInput = {
      ...(filter.owner && filter.owner !== 'all' ? { ownerId: filter.owner } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
    };
    const tabWhere: Record<TaskTab, Prisma.CrmTaskWhereInput> = {
      today: { doneAt: null, dueAt: { lt: endOfToday } },
      up: { doneAt: null, dueAt: { gte: endOfToday } },
      done: { doneAt: { not: null } },
    };
    const [rows, counts, team] = await Promise.all([
      this.prisma.crmTask.findMany({
        where: { ...base, ...(filter.tab ? tabWhere[filter.tab] : {}) },
        orderBy: filter.tab === 'done' ? { doneAt: 'desc' } : { dueAt: 'asc' },
        take: filter.tab === 'done' ? 50 : 300,
        include: TASK_INCLUDE,
      }),
      Promise.all(TASK_TABS.map((t) => this.prisma.crmTask.count({ where: { ...base, ...tabWhere[t] } }))),
      this.team.byId(),
    ]);
    return {
      content: rows.map((k) => this.taskRow(k, team)),
      counts: { today: counts[0], up: counts[1], done: counts[2] },
    };
  }

  async createTask(input: z.output<typeof TaskCreateSchema>, staff: Staff) {
    const subject = this.subjectOf(input);
    if (input.ownerId !== undefined) await this.team.assertMember(input.ownerId);
    const dueAt = input.due;
    if (!dueAt) throw new ValidationError({ due: 'Pick a due date' });
    const k = await this.prisma.crmTask.create({
      data: {
        title: input.title.trim(),
        dueAt,
        ownerId: input.ownerId === undefined ? staff.id : input.ownerId,
        createdBy: staff.id,
        ...(subject ?? {}),
      },
      include: TASK_INCLUDE,
    });
    if (subject) await logActivity(this.prisma, subject, 'task', `Task added: ${k.title}`, staff);
    return this.taskRow(k, await this.team.byId());
  }

  async updateTask(id: string, input: z.output<typeof TaskUpdateSchema>, staff: Staff) {
    const k = await this.prisma.crmTask.findUnique({ where: { id } });
    if (!k) throw new DomainError(404, 'Task not found');
    if (input.ownerId !== undefined) await this.team.assertMember(input.ownerId);
    const data: Prisma.CrmTaskUpdateInput = {};
    if (input.done !== undefined) data.doneAt = input.done ? (k.doneAt ?? new Date()) : null;
    if (input.title) data.title = input.title.trim();
    if (input.due) data.dueAt = input.due;
    if (input.ownerId !== undefined) data.ownerId = input.ownerId;
    const updated = await this.prisma.crmTask.update({ where: { id }, data, include: TASK_INCLUDE });
    if (input.done && !k.doneAt) {
      const subject = k.customerId ? { customerId: k.customerId } : k.supplierId ? { supplierId: k.supplierId } : null;
      if (subject) await logActivity(this.prisma, subject, 'task', `Task done: ${k.title}`, staff);
    }
    return this.taskRow(updated, await this.team.byId());
  }

  async deleteTask(id: string) {
    await this.prisma.crmTask.delete({ where: { id } }).catch(() => {
      throw new DomainError(404, 'Task not found');
    });
  }

  // ── Notes, calls and emails on a profile ─────────────────────────────────

  async addActivity(subject: Subject, input: z.output<typeof ActivityCreateSchema>, staff: Staff) {
    const kind = input.kind ?? 'note';
    const text = input.body.trim();
    let body = text;
    if (kind === 'call') body = `${input.outcome ?? 'Talked'} (${input.minutes ?? 0} min): ${text}`;
    if (kind === 'email') {
      const who = 'customerId' in subject ? await this.customers.emailOf(subject.customerId) : await this.suppliers.emailOf(subject.supplierId);
      if (!who.email) throw new ValidationError({ body: `${who.name} has no email address on file` });
      const title = input.subject?.trim() || '(no subject)';
      await this.mailer.send({
        template: 'SUPPORT_TICKET',
        to: who.email,
        subject: title,
        body: [text, '', `— ${staff.name}, ${this.config.store.name}`].join('\n'),
        userId: who.userId,
      });
      body = `Sent “${title}”: ${text}`;
    }
    const a = await logActivity(this.prisma, subject, kind, body, staff);
    return { id: a.id, kind: a.kind, body: a.body, by: a.authorName, at: a.createdAt };
  }

  // ── Notifications (worked out from live data) ────────────────────────────

  async notifications(me: string, tz: number) {
    const now = new Date();
    const start = dayStart(now, tz);
    const endOfToday = new Date(start.getTime() + DAY);
    const stuckCutoff = new Date(now.getTime() - this.config.crm.stuckDays * DAY);
    const [overdue, tasks, unassigned, stuck] = await Promise.all([
      this.prisma.crmTicket.findMany({ where: { status: 'open', slaDueAt: { lt: now } }, orderBy: { slaDueAt: 'asc' }, take: 10 }),
      this.prisma.crmTask.findMany({ where: { ownerId: me, doneAt: null, dueAt: { lt: endOfToday } }, orderBy: { dueAt: 'asc' }, take: 10, include: TASK_INCLUDE }),
      this.prisma.crmTicket.findMany({ where: { status: 'open', ownerId: null, slaDueAt: { gte: now } }, orderBy: { slaDueAt: 'asc' }, take: 10 }),
      this.prisma.crmSupplier.findMany({ where: { stage: { notIn: ['live', 'lost'] }, stageChangedAt: { lt: stuckCutoff } }, orderBy: { stageChangedAt: 'asc' }, take: 10 }),
    ]);
    const items = [
      ...overdue.map((t) => ({
        id: `o:${t.id}`,
        icon: 'clock',
        tone: 'bad',
        title: t.subject,
        subtitle: `Past reply time · ${t.requesterName}`,
        link: { type: 'ticket', id: ticketRef(t.number) },
      })),
      ...tasks.map((k) => {
        const days = Math.round((start.getTime() - dayStart(k.dueAt, tz).getTime()) / DAY);
        const label = days > 0 ? `${days} day${days === 1 ? '' : 's'} overdue` : 'Today';
        return {
          id: `k:${k.id}:${label}`,
          icon: 'check',
          tone: days > 0 ? 'bad' : 'warn',
          title: k.title,
          subtitle: `Your task · ${label}`,
          link: k.customerId ? { type: 'customer', id: k.customerId } : k.supplierId ? { type: 'supplier', id: k.supplierId } : { type: 'tasks', id: null },
        };
      }),
      ...unassigned.map((t) => ({
        id: `u:${t.id}`,
        icon: 'inbox',
        tone: '',
        title: t.subject,
        subtitle: `Unassigned ticket · ${t.requesterName}`,
        link: { type: 'ticket', id: ticketRef(t.number) },
      })),
      ...stuck.map((s) => ({
        id: `s:${s.id}:${s.stage}`,
        icon: 'kanban',
        tone: 'warn',
        title: `${s.company} is stuck in ${STAGE_LABEL[s.stage as PipelineStage]}`,
        subtitle: `${Math.round((now.getTime() - s.stageChangedAt.getTime()) / DAY)} days in this stage`,
        link: { type: 'supplier', id: s.id },
      })),
    ];
    return { content: items };
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async dashboard(me: string, tz: number) {
    const now = new Date();
    const start = dayStart(now, tz);
    const endOfToday = new Date(start.getTime() + DAY);
    const [open, unassigned, overdue, myDue, myOverdue, strip, funnel, stuck, queue, care, activity, members, openByOwner, tasksByOwner] = await Promise.all([
      this.prisma.crmTicket.count({ where: { status: 'open' } }),
      this.prisma.crmTicket.count({ where: { status: 'open', ownerId: null } }),
      this.prisma.crmTicket.count({ where: { status: 'open', slaDueAt: { lt: now } } }),
      this.prisma.crmTask.count({ where: { ownerId: me, doneAt: null, dueAt: { lt: endOfToday } } }),
      this.prisma.crmTask.count({ where: { ownerId: me, doneAt: null, dueAt: { lt: start } } }),
      this.suppliers.list({ includeLost: false }).then((r) => r.strip),
      this.suppliers.funnel(),
      this.suppliers.stuck(),
      this.tickets.list({ view: 'open' }, me, { page: 0, size: 5, sort: [] }).then((r) => r.content),
      this.customers.toLookAfter(8),
      this.prisma.crmActivity.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { customer: { include: { user: { select: { fullName: true, email: true } } } }, supplier: { select: { company: true } } },
      }),
      this.team.list(),
      this.prisma.crmTicket.groupBy({ by: ['ownerId'], where: { status: 'open', ownerId: { not: null } }, _count: { _all: true } }),
      this.prisma.crmTask.groupBy({ by: ['ownerId'], where: { doneAt: null, ownerId: { not: null } }, _count: { _all: true } }),
    ]);
    const tickets = new Map(openByOwner.map((g) => [g.ownerId, g._count._all]));
    const tasks = new Map(tasksByOwner.map((g) => [g.ownerId, g._count._all]));
    return {
      kpis: {
        openTickets: open,
        unassignedTickets: unassigned,
        overdueTickets: overdue,
        myTasksDue: myDue,
        myTasksOverdue: myOverdue,
        suppliersInProgress: strip.inProgress,
        liveSuppliers: strip.live,
        stuckSuppliers: stuck.length,
      },
      queue,
      funnel,
      stuckSuppliers: stuck,
      care: care.map((c) => ({ ...c, daysSinceOrder: c.lastOrderAt ? Math.round((now.getTime() - c.lastOrderAt.getTime()) / DAY) : null })),
      activity: activity.map((a) => ({
        id: a.id,
        kind: a.kind,
        body: a.body,
        by: a.authorName,
        at: a.createdAt,
        subject: a.customer
          ? { kind: 'customer', id: a.customer.id, name: a.customer.user?.fullName || a.customer.name || a.customer.user?.email || a.customer.email || 'Customer' }
          : a.supplier
            ? { kind: 'supplier', id: a.supplierId!, name: a.supplier.company }
            : null,
      })),
      workload: members.map((m) => ({ member: m, openTickets: tickets.get(m.id) ?? 0, openTasks: tasks.get(m.id) ?? 0 })),
    };
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /** Customers, suppliers and tickets matching `q`; with no `q`, the newest few (to pick from). */
  async search(q: string, limit: number) {
    const text = q.trim();
    const code = /^s-?(\d+)$/i.exec(text);
    const [customers, suppliers, tickets] = await Promise.all([
      this.customers.list({ q: text || undefined, sort: 'last', dir: -1 }, { page: 0, size: limit, sort: [] }),
      this.prisma.crmSupplier.findMany({
        where: text
          ? {
              OR: [
                { company: { contains: text, mode: 'insensitive' } },
                { contactName: { contains: text, mode: 'insensitive' } },
                { email: { contains: text, mode: 'insensitive' } },
                ...(code ? [{ number: Number(code[1]) }] : []),
              ],
            }
          : {},
        orderBy: text ? { company: 'asc' } : { createdAt: 'desc' },
        take: limit,
      }),
      text ? this.tickets.search(text, 4) : Promise.resolve([]),
    ]);
    return {
      customers: customers.content.map((c) => ({ id: c.id, code: c.code, name: c.name, email: c.email })),
      suppliers: suppliers.map((s) => ({ id: s.id, code: `S-${s.number}`, name: s.company, email: s.email, contact: s.contactName, stage: s.stage })),
      tickets,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private subjectOf(input: { customerId?: string; supplierId?: string }): Subject | null {
    if (input.customerId && input.supplierId) throw new ValidationError({ customerId: 'Choose one customer or supplier' });
    if (input.customerId) return { customerId: input.customerId };
    if (input.supplierId) return { supplierId: input.supplierId };
    return null;
  }

  private taskRow(k: TaskRow, team: Awaited<ReturnType<Team['byId']>>) {
    return {
      id: k.id,
      title: k.title,
      dueAt: k.dueAt,
      done: k.doneAt !== null,
      doneAt: k.doneAt,
      owner: memberOf(team, k.ownerId),
      contact: k.customer
        ? { kind: 'customer' as const, id: k.customer.id, code: `C-${k.customer.number}`, name: k.customer.user?.fullName || k.customer.name || k.customer.user?.email || k.customer.email || 'Customer' }
        : k.supplier
          ? { kind: 'supplier' as const, id: k.supplier.id, code: `S-${k.supplier.number}`, name: k.supplier.company }
          : null,
    };
  }
}
