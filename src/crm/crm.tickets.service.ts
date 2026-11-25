import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { toPage, type Pageable } from '../common/pagination';
import { oneOf, optionalUuid, requiredString, ValidationError } from '../common/validation';
import type { Config } from '../config';
import type { Mailer } from '../notify/mailer';
import type { SellerTicketService } from '../seller/tickets.service';
import type { CrmCustomerService } from './crm.customers.service';
import type { CrmIngestService } from './crm.ingest.service';
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_VIEWS,
  SLA_HOURS,
  logActivity,
  memberOf,
  nullableUuid,
  parseTicketRef,
  slaDue,
  ticketRef,
  type Staff,
  type Team,
  type TicketPriority,
  type TicketStatus,
  type TicketView,
} from './crm.shared';

export const TicketCreateSchema = z.object({
  customerId: optionalUuid(),
  supplierId: optionalUuid(),
  subject: requiredString({ min: 4, max: 200, blankMessage: 'Add a short subject', sizeMessage: 'Add a short subject' }),
  category: oneOf(TICKET_CATEGORIES),
  priority: oneOf(TICKET_PRIORITIES),
  body: requiredString({ min: 4, max: 5000, blankMessage: 'Add the details', sizeMessage: 'Add the details' }),
  /** Omitted = the person opening it; null = unassigned. */
  ownerId: nullableUuid,
});

export const TicketUpdateSchema = z.object({
  status: oneOf(TICKET_STATUSES),
  priority: oneOf(TICKET_PRIORITIES),
  ownerId: nullableUuid,
});

export const TicketMessageSchema = z.object({
  body: requiredString({ max: 5000, blankMessage: 'Write something first' }),
  /** A reply goes to them; a note is for the team. */
  mode: oneOf(['reply', 'note'] as const),
  /** After a reply: wait for them, or solve. */
  after: oneOf(['pending', 'solved'] as const),
});

export interface TicketFilter {
  view: TicketView;
  who?: 'customer' | 'supplier';
  q?: string;
}

const LIST_INCLUDE = { _count: { select: { messages: true } } } satisfies Prisma.CrmTicketInclude;
type ListRow = Prisma.CrmTicketGetPayload<{ include: typeof LIST_INCLUDE }>;

const SELLER_STATUS: Record<TicketStatus, string> = { open: 'OPEN', pending: 'WAITING', solved: 'RESOLVED' };
const SUPPORT_STATUS: Record<TicketStatus, string> = { open: 'OPEN', pending: 'IN_PROGRESS', solved: 'CLOSED' };

/**
 * Tickets: the team's queue of customer and supplier conversations, most
 * urgent (soonest reply due) first. A ticket that came from the help center or
 * the Seller Portal stays tied to it: a reply here goes out the way the person
 * wrote in (their Seller Portal thread, or email), and solving it closes the
 * original too.
 */
export class CrmTicketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly team: Team,
    private readonly mailer: Mailer,
    private readonly config: Config,
    private readonly sellerTickets: SellerTicketService,
    private readonly ingest: CrmIngestService,
    private readonly customers: CrmCustomerService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(filter: TicketFilter, me: string, pageable: Pageable) {
    const now = new Date();
    const where: Prisma.CrmTicketWhereInput = { AND: [viewWhere(filter.view, me, now), ...(filter.who ? [{ requesterKind: filter.who }] : []), ...searchWhere(filter.q)] };
    const [rows, total, counts, team] = await Promise.all([
      this.prisma.crmTicket.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: filter.view === 'solved' ? [{ createdAt: 'desc' }] : [{ slaDueAt: 'asc' }, { number: 'asc' }],
        skip: pageable.page * pageable.size,
        take: pageable.size,
      }),
      this.prisma.crmTicket.count({ where }),
      this.counts(me, now),
      this.team.byId(),
    ]);
    return { ...toPage(rows.map((t) => this.row(t, team)), total, pageable), counts };
  }

  /** Counts for the view menu and the nav badge. */
  async counts(me: string, now = new Date()) {
    const entries = await Promise.all(TICKET_VIEWS.map(async (v) => [v, await this.prisma.crmTicket.count({ where: viewWhere(v, me, now) })] as const));
    return Object.fromEntries(entries) as Record<TicketView, number>;
  }

  async get(reference: string) {
    const t = await this.find(reference, true);
    const team = await this.team.byId();
    const [others, requester] = await Promise.all([
      this.prisma.crmTicket.count({
        where: { id: { not: t.id }, ...(t.customerId ? { customerId: t.customerId } : t.supplierId ? { supplierId: t.supplierId } : { id: '00000000-0000-0000-0000-000000000000' }) },
      }),
      this.requesterOf(t),
    ]);
    return {
      ...this.row(t, team),
      messages: t.messages.map((m) => ({
        id: m.id,
        kind: m.kind as 'requester' | 'staff' | 'note',
        author: { id: m.authorId, name: m.authorName },
        body: m.body,
        createdAt: m.createdAt,
      })),
      requester,
      otherTickets: others,
      linked:
        t.source === 'SELLER_PORTAL' && t.externalRef
          ? { type: 'seller_ticket' as const, reference: t.externalRef, href: `/admin/seller-tickets/${t.externalRef}` }
          : t.source === 'HELP_CENTER' && t.externalRef
            ? { type: 'support_message' as const, reference: t.externalRef, href: '/admin/support' }
            : null,
    };
  }

  /** For the global search box. */
  async search(q: string, limit: number) {
    const rows = await this.prisma.crmTicket.findMany({ where: { AND: searchWhere(q) }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((t) => ({ reference: ticketRef(t.number), subject: t.subject, status: t.status }));
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** The team opens a ticket for a customer or supplier (a phone call, a note from a meeting). */
  async create(input: z.output<typeof TicketCreateSchema>, staff: Staff) {
    const errors: Record<string, string> = {};
    if (!input.customerId && !input.supplierId) errors.customerId = 'Choose who this is for';
    if (input.customerId && input.supplierId) errors.customerId = 'Choose one customer or supplier';
    if (Object.keys(errors).length) throw new ValidationError(errors);
    await this.team.assertMember(input.ownerId);

    const who = input.customerId
      ? await this.customers.emailOf(input.customerId)
      : await this.supplierBrief(input.supplierId!);
    const priority = (input.priority ?? 'normal') as TicketPriority;
    const now = new Date();
    const owner = input.ownerId === undefined ? staff.id : input.ownerId;
    const t = await this.prisma.crmTicket.create({
      data: {
        subject: input.subject.trim(),
        category: input.category ?? 'Order',
        priority,
        status: 'open',
        channel: 'Created by team',
        requesterKind: input.customerId ? 'customer' : 'supplier',
        customerId: input.customerId ?? null,
        supplierId: input.supplierId ?? null,
        requesterName: who.name.slice(0, 200),
        requesterEmail: who.email,
        ownerId: owner,
        slaDueAt: slaDue(now, priority),
        createdAt: now,
        lastMessageAt: now,
        source: 'STAFF',
        messages: { create: { kind: 'note', authorId: staff.id, authorName: staff.name, body: input.body.trim() } },
      },
    });
    await logActivity(this.prisma, input.customerId ? { customerId: input.customerId } : { supplierId: input.supplierId! }, 'ticket', `Opened ticket ${ticketRef(t.number)}: ${t.subject}`, staff);
    return this.get(ticketRef(t.number));
  }

  async update(reference: string, input: z.output<typeof TicketUpdateSchema>, staff: Staff) {
    const t = await this.find(reference);
    if (input.ownerId !== undefined) await this.team.assertMember(input.ownerId);
    const data: Prisma.CrmTicketUpdateInput = {};
    if (input.priority && input.priority !== t.priority) {
      data.priority = input.priority;
      // The reply clock follows the new priority, from when the ticket was opened.
      data.slaDueAt = new Date(t.createdAt.getTime() + SLA_HOURS[input.priority] * 3_600_000);
    }
    if (input.ownerId !== undefined && input.ownerId !== t.ownerId) data.ownerId = input.ownerId;
    const statusChanged = input.status && input.status !== t.status;
    if (statusChanged) {
      data.status = input.status;
      data.solvedAt = input.status === 'solved' ? new Date() : null;
      // Reopened: the clock starts again from now.
      if (t.status === 'solved') data.slaDueAt = slaDue(new Date(), (input.priority ?? t.priority) as TicketPriority);
    }
    if (Object.keys(data).length) await this.prisma.crmTicket.update({ where: { id: t.id }, data });
    if (statusChanged) {
      await this.pushStatus(t, input.status as TicketStatus, staff);
      if (input.status === 'solved') await this.log(t, 'ticket', `Solved ticket ${ticketRef(t.number)}`, staff);
    }
    if (input.ownerId !== undefined && input.ownerId !== t.ownerId && t.source === 'SELLER_PORTAL' && t.sourceRef) {
      await this.prisma.sellerTicket.update({ where: { id: t.sourceRef }, data: { assigneeId: input.ownerId } }).catch(() => undefined);
      await this.prisma.crmTicket.update({ where: { id: t.id }, data: { syncedAt: new Date() } });
    }
    return this.get(ticketRef(t.number));
  }

  /** A reply to the requester, or an internal note. */
  async addMessage(reference: string, input: z.output<typeof TicketMessageSchema>, staff: Staff) {
    const t = await this.find(reference);
    const body = input.body.trim();
    const mode = input.mode ?? 'reply';

    if (mode === 'note') {
      await this.prisma.crmTicket.update({
        where: { id: t.id },
        data: { lastMessageAt: new Date(), ...(t.ownerId ? {} : { ownerId: staff.id }), messages: { create: { kind: 'note', authorId: staff.id, authorName: staff.name, body } } },
      });
      return this.get(ticketRef(t.number));
    }

    if (t.status === 'solved') throw new DomainError(409, 'This ticket is solved. Change its status to reopen it first.');
    const after = (input.after ?? 'pending') as 'pending' | 'solved';
    const link = t.source === 'SELLER_PORTAL' && t.sourceRef ? await this.prisma.sellerTicket.findUnique({ where: { id: t.sourceRef }, select: { id: true, reference: true } }) : null;

    if (link) {
      // Their Seller Portal thread: the seller sees it there and is emailed. The reply comes back here on the copy.
      await this.sellerTickets.staffReply(staff, link.reference, { body, resolve: after === 'solved' }, []);
      await this.ingest.copySellerTicket(link.id);
      if (!t.ownerId) await this.prisma.crmTicket.update({ where: { id: t.id }, data: { ownerId: staff.id } });
    } else {
      const now = new Date();
      await this.prisma.crmTicket.update({
        where: { id: t.id },
        data: {
          status: after,
          solvedAt: after === 'solved' ? now : null,
          lastMessageAt: now,
          ...(t.ownerId ? {} : { ownerId: staff.id }),
          messages: { create: { kind: 'staff', authorId: staff.id, authorName: staff.name, body } },
        },
      });
      await this.pushStatus(t, after, staff);
      await this.emailRequester(t, body, staff);
    }
    await this.log(t, 'email', `Replied on ${ticketRef(t.number)}: ${body.slice(0, 60)}${body.length > 60 ? '…' : ''}`, staff);
    if (after === 'solved') await this.log(t, 'ticket', `Solved ticket ${ticketRef(t.number)}`, staff);
    return this.get(ticketRef(t.number));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async find(reference: string, withMessages: true): Promise<Prisma.CrmTicketGetPayload<{ include: typeof LIST_INCLUDE & { messages: { orderBy: { createdAt: 'asc' } } } }>>;
  private async find(reference: string): Promise<Prisma.CrmTicketGetPayload<{ include: typeof LIST_INCLUDE }>>;
  private async find(reference: string, withMessages = false) {
    const t = await this.prisma.crmTicket.findUnique({
      where: { number: parseTicketRef(reference) },
      include: { ...LIST_INCLUDE, ...(withMessages ? { messages: { orderBy: { createdAt: 'asc' as const } } } : {}) },
    });
    if (!t) throw new DomainError(404, 'Ticket not found');
    return t;
  }

  private async supplierBrief(id: string) {
    const s = await this.prisma.crmSupplier.findUnique({ where: { id }, select: { contactName: true, company: true, email: true } });
    if (!s) throw new DomainError(404, 'Supplier not found');
    return { name: s.contactName || s.company, email: s.email };
  }

  /** Who the ticket is from, with what the team wants to know at a glance. */
  private async requesterOf(t: { requesterKind: string; customerId: string | null; supplierId: string | null; requesterName: string; requesterEmail: string | null }) {
    if (t.customerId) {
      const brief = await this.customers.brief(t.customerId);
      if (brief) return { kind: 'customer' as const, id: brief.id, code: brief.code, name: brief.name, email: brief.email, summary: `${brief.orders} order${brief.orders === 1 ? '' : 's'} · ${fmt(brief.ltv)}`, tags: brief.tags };
    }
    if (t.supplierId) {
      const s = await this.prisma.crmSupplier.findUnique({ where: { id: t.supplierId } });
      if (s) return { kind: 'supplier' as const, id: s.id, code: `S-${s.number}`, name: s.company, email: s.email, summary: `${s.stage} · ${s.contactName ?? ''}`.replace(/ · $/, ''), stage: s.stage, tags: [] as string[] };
    }
    return { kind: t.requesterKind as 'customer' | 'supplier', id: null, code: null, name: t.requesterName, email: t.requesterEmail, summary: 'No profile yet', tags: [] as string[] };
  }

  /** Tell the original source: the seller's ticket, or the help-center message, follows our status. */
  private async pushStatus(t: { source: string; sourceRef: string | null; id: string }, status: TicketStatus, staff: Staff) {
    if (!t.sourceRef) return;
    if (t.source === 'SELLER_PORTAL') {
      await this.prisma.sellerTicket
        .update({ where: { id: t.sourceRef }, data: { status: SELLER_STATUS[status], resolvedAt: status === 'solved' ? new Date() : null } })
        .catch(() => undefined);
      await this.prisma.crmTicket.update({ where: { id: t.id }, data: { syncedAt: new Date() } });
    } else if (t.source === 'HELP_CENTER') {
      await this.prisma.supportMessage
        .update({ where: { id: t.sourceRef }, data: { status: SUPPORT_STATUS[status], handledBy: staff.email, updatedAt: new Date() } })
        .catch(() => undefined);
    }
  }

  private async emailRequester(t: { requesterEmail: string | null; subject: string; number: number; customerId: string | null; supplierId: string | null }, body: string, staff: Staff) {
    if (!t.requesterEmail) return;
    const ref = ticketRef(t.number);
    await this.mailer.send({
      template: 'SUPPORT_TICKET',
      to: t.requesterEmail,
      subject: `Re: ${t.subject} (${ref})`,
      body: [`${staff.name} replied to your request ${ref}:`, '', body, '', `Need more help? Reply to this email or visit ${this.config.store.appBaseUrl}/help.`, '', this.config.store.name].join('\n'),
    });
  }

  private log(t: { customerId: string | null; supplierId: string | null }, kind: 'email' | 'ticket', body: string, staff: Staff) {
    if (t.customerId) return logActivity(this.prisma, { customerId: t.customerId }, kind, body, staff);
    if (t.supplierId) return logActivity(this.prisma, { supplierId: t.supplierId }, kind, body, staff);
    return Promise.resolve(null);
  }

  private row(t: ListRow, team: Awaited<ReturnType<Team['byId']>>) {
    return {
      id: t.id,
      reference: ticketRef(t.number),
      subject: t.subject,
      category: t.category,
      priority: t.priority as TicketPriority,
      status: t.status as TicketStatus,
      channel: t.channel,
      source: t.source,
      requester: { kind: t.requesterKind as 'customer' | 'supplier', id: t.customerId ?? t.supplierId, name: t.requesterName, email: t.requesterEmail },
      owner: memberOf(team, t.ownerId),
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      slaDueAt: t.slaDueAt,
      solvedAt: t.solvedAt,
      messageCount: t._count.messages,
    };
  }
}

const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

function viewWhere(view: TicketView, me: string, now: Date): Prisma.CrmTicketWhereInput {
  switch (view) {
    case 'mine':
      return { ownerId: me, status: { not: 'solved' } };
    case 'unassigned':
      return { ownerId: null, status: { not: 'solved' } };
    case 'overdue':
      return { status: 'open', slaDueAt: { lt: now } };
    case 'open':
      return { status: 'open' };
    case 'pending':
      return { status: 'pending' };
    case 'solved':
      return { status: 'solved' };
  }
}

/** Words match the subject, the person, or the ticket number (TK-5312, 5312, the help-center or seller reference). */
function searchWhere(q: string | undefined): Prisma.CrmTicketWhereInput[] {
  const text = q?.trim();
  if (!text) return [];
  const num = /^(?:tk-)?(\d{1,9})$/i.exec(text);
  return [
    {
      OR: [
        { subject: { contains: text, mode: 'insensitive' } },
        { requesterName: { contains: text, mode: 'insensitive' } },
        { requesterEmail: { contains: text, mode: 'insensitive' } },
        { externalRef: { contains: text, mode: 'insensitive' } },
        ...(num ? [{ number: Number(num[1]) }] : []),
      ],
    },
  ];
}
