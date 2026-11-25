import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { isUuid } from '../common/validation';

/** A teammate's id, null to clear it, or absent to leave it alone. */
export const nullableUuid = z.unknown().transform((v, ctx): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'string' && isUuid(v)) return v.toLowerCase();
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid UUID' });
  return z.NEVER;
});

/**
 * CRM (designs/crm): shared vocabulary and small helpers. The CRM is for the
 * admin team: staff are the users with ROLE_ADMIN.
 */

// ── Tickets ─────────────────────────────────────────────────────────────────

export const TICKET_STATUSES = ['open', 'pending', 'solved'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = [
  'Order',
  'Delivery',
  'Return / refund',
  'Product question',
  'Account',
  'Listing issue',
  'Stock / feed',
  'Documents',
  'Payouts',
  'Other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Hours to a first answer, by priority: a ticket past it is "past reply time". */
export const SLA_HOURS: Record<TicketPriority, number> = { urgent: 4, high: 8, normal: 24, low: 72 };

/** The ticket list's views (the design's "View" menu). */
export const TICKET_VIEWS = ['mine', 'unassigned', 'overdue', 'open', 'pending', 'solved'] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];

export const REQUESTER_KINDS = ['customer', 'supplier'] as const;
export type RequesterKind = (typeof REQUESTER_KINDS)[number];

export const TICKET_SOURCES = ['STAFF', 'HELP_CENTER', 'SELLER_PORTAL'] as const;

export const slaDue = (from: Date, priority: TicketPriority) => new Date(from.getTime() + SLA_HOURS[priority] * HOUR);

export const ticketRef = (n: number) => `TK-${n}`;
/** "TK-5312" → 5312; anything else is a 404 at the route. */
export function parseTicketRef(ref: string): number {
  const m = /^TK-(\d{1,9})$/i.exec(ref.trim());
  if (!m) throw new DomainError(404, 'Ticket not found');
  return Number(m[1]);
}

// ── Suppliers ───────────────────────────────────────────────────────────────

/** The pipeline, left to right. */
export const PIPELINE_STAGES = [
  ['lead', 'Lead', 'Found, not contacted yet'],
  ['contacted', 'Contacted', 'First email or call sent'],
  ['interested', 'Interested', 'Replied and wants to know more'],
  ['applied', 'Applied', 'Application started in the Seller Portal'],
  ['review', 'In review', 'Scorecard check by catalog manager'],
  ['documents', 'Documents', 'W-9, agreement, insurance'],
  ['live', 'Live', 'Approved and selling'],
  ['lost', 'Lost', 'Not moving forward'],
] as const;
export const STAGE_KEYS = PIPELINE_STAGES.map((s) => s[0]) as unknown as readonly [PipelineStage, ...PipelineStage[]];
export type PipelineStage = (typeof PIPELINE_STAGES)[number][0];
export const STAGE_LABEL = Object.fromEntries(PIPELINE_STAGES.map((s) => [s[0], s[1]])) as Record<PipelineStage, string>;
/** Stages that follow the Seller Portal on their own. */
export const AUTO_STAGES: readonly PipelineStage[] = ['applied', 'review', 'documents', 'live'];
export const isOpenStage = (s: string) => s !== 'live' && s !== 'lost';

export const SUPPLIER_SOURCES = ['Outreach', 'Inbound', 'Referral', 'Trade show', 'Instagram', 'Seller Portal'] as const;
export const LOST_REASONS = [
  'Fees too high',
  'Not a fit for our catalog',
  'No response',
  'Failed scorecard',
  'Chose another marketplace',
  'Other',
] as const;

// ── Customers ───────────────────────────────────────────────────────────────

/** Tags the team sets by hand; New, Repeat and At risk come from orders. */
export const MANUAL_CUSTOMER_TAGS = ['VIP'] as const;
export const CUSTOMER_TAG_FILTERS = ['VIP', 'Repeat', 'New', 'At risk'] as const;
/** An account this young is "New". */
export const NEW_CUSTOMER_DAYS = 30;

// ── Activity ────────────────────────────────────────────────────────────────

export const ACTIVITY_KINDS = ['note', 'call', 'email', 'ticket', 'stage', 'task'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

// ── Time ────────────────────────────────────────────────────────────────────

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * Start of the caller's local day. `tz` is the browser's `getTimezoneOffset()`
 * (minutes behind UTC), so "today" means the admin's today, not the server's.
 */
export function dayStart(now: Date, tz = 0): Date {
  const local = now.getTime() - tz * MINUTE;
  return new Date(Math.floor(local / DAY) * DAY + tz * MINUTE);
}

// ── People ──────────────────────────────────────────────────────────────────

/** A signed-in admin acting. */
export interface Staff {
  id: string;
  email: string;
  name: string;
}

/** A teammate who can own tickets, tasks and contacts. */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

/** Looks up the team (admins); the answer is kept for `ttlMs` so one request asks once. */
export class Team {
  private cache: { at: number; rows: Promise<Member[]> } | null = null;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs = 5000,
  ) {}

  list(): Promise<Member[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.rows;
    const rows = this.prisma.user
      .findMany({
        where: { role: 'ROLE_ADMIN', deleted: false, enabled: true },
        select: { id: true, fullName: true, email: true },
        orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
      })
      .then((found) => found.map((u) => ({ id: u.id, name: u.fullName || u.email, email: u.email, role: 'Admin' })));
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  async byId(): Promise<Map<string, Member>> {
    return new Map((await this.list()).map((m) => [m.id, m]));
  }

  /** An owner must be someone on the team. */
  async assertMember(id: string | null | undefined): Promise<void> {
    if (!id) return;
    if (!(await this.list()).some((m) => m.id === id)) throw new DomainError(400, 'That person is not on the team');
  }
}

/** The team member for an id, or null. Plain lookup over `byId()`. */
export const memberOf = (team: Map<string, Member>, id: string | null | undefined): Member | null =>
  (id && team.get(id)) || null;

export async function staffFrom(prisma: PrismaClient, user: { id: string; email: string }): Promise<Staff> {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { fullName: true } });
  return { id: user.id, email: user.email, name: row?.fullName || user.email };
}

// ── History ─────────────────────────────────────────────────────────────────

type Db = PrismaClient | Prisma.TransactionClient;

/** Adds a line to a customer's or supplier's history. `by: null` is the system. */
export function logActivity(
  db: Db,
  subject: { customerId: string } | { supplierId: string },
  kind: ActivityKind,
  body: string,
  by: { id: string; name: string } | null,
  at?: Date,
) {
  return db.crmActivity.create({
    data: {
      ...('customerId' in subject ? { customerId: subject.customerId } : { supplierId: subject.supplierId }),
      kind,
      body: body.slice(0, 2000),
      authorId: by?.id ?? null,
      authorName: by?.name ?? null,
      ...(at ? { createdAt: at } : {}),
    },
  });
}

export const initialsOf = (name: string) =>
  name
    .replace(/[&.]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** Unique-violation from a concurrent copy of the same source row: safe to skip. */
export const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
