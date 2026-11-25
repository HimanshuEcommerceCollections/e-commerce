import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { toPage, type Pageable } from '../common/pagination';
import { optionalString, requiredString } from '../common/validation';
import type { Config } from '../config';
import {
  CUSTOMER_TAG_FILTERS,
  MANUAL_CUSTOMER_TAGS,
  NEW_CUSTOMER_DAYS,
  logActivity,
  memberOf,
  nullableUuid,
  ticketRef,
  type Staff,
  type Team,
} from './crm.shared';

export const CUSTOMER_SORTS = ['name', 'orders', 'ltv', 'last'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const CustomerCreateSchema = z.object({
  name: requiredString({ max: 200, blankMessage: 'Enter their name' }),
  email: requiredString({ max: 255, email: true, blankMessage: 'Enter a valid email', emailMessage: 'Enter a valid email' }),
  phone: optionalString({ max: 30 }),
});

export const CustomerUpdateSchema = z.object({
  /** null = no owner. */
  ownerId: nullableUuid,
  tags: z.array(z.enum(MANUAL_CUSTOMER_TAGS, { errorMap: () => ({ message: `must be one of ${MANUAL_CUSTOMER_TAGS.join(', ')}` }) })).optional(),
});

/** Payment states in which the customer actually paid (net of refunds). */
const PAID = Prisma.sql`('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')`;

/** Orders, spend (paid, net of refunds) and last order per account: the same definitions as Admin › Customers. */
const STATS = Prisma.sql`
  WITH stats AS (
    SELECT user_id,
           count(*)::int AS orders,
           coalesce(sum(CASE WHEN payment_status IN ${PAID} THEN grand_total - refunded_total ELSE 0 END), 0) AS ltv,
           max(created_at) AS last_order_at
      FROM orders
     WHERE deleted = false AND user_id IS NOT NULL
     GROUP BY user_id
  )`;

const NAME = Prisma.sql`coalesce(u.full_name, c.name)`;
const EMAIL = Prisma.sql`coalesce(u.email, c.email)`;
const ORDERS = Prisma.sql`coalesce(s.orders, 0)`;
const SINCE = Prisma.sql`coalesce(u.created_at, c.created_at)`;

const SORT_SQL: Record<CustomerSort, Prisma.Sql> = {
  name: Prisma.sql`lower(${NAME})`,
  orders: ORDERS,
  ltv: Prisma.sql`coalesce(s.ltv, 0)`,
  last: Prisma.sql`s.last_order_at`,
};

interface Row {
  id: string;
  number: number;
  user_id: string | null;
  owner_id: string | null;
  tags: string[] | null;
  name: string;
  email: string | null;
  phone: string | null;
  consent: boolean;
  since: Date;
  orders: number;
  ltv: Prisma.Decimal;
  last_order_at: Date | null;
  loc: string | null;
  open_tickets: number;
}

export interface CustomerFilter {
  q?: string;
  tag?: string;
  /** 'none' or a teammate's id. */
  owner?: string;
  sort: CustomerSort;
  /** 1 = ascending, -1 = descending. */
  dir: 1 | -1;
}

/**
 * Customers as the team sees them: one row per customer account (made on
 * first sight) plus anyone added by hand. Orders and spend come from the
 * store; the owner, VIP tag, tasks, tickets and notes are the CRM's.
 */
export class CrmCustomerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly team: Team,
    private readonly config: Config,
  ) {}

  /**
   * Gives every customer account a CRM record, and links a hand-added contact
   * to the account when that person signs up with the same email.
   */
  async ensureAccounts(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE crm_customers c
         SET user_id = u.id, name = NULL, email = NULL, phone = NULL, updated_at = now()
        FROM users u
       WHERE c.user_id IS NULL AND lower(c.email) = lower(u.email)
         AND u.role = 'ROLE_CUSTOMER' AND u.deleted = false
         AND NOT EXISTS (SELECT 1 FROM crm_customers x WHERE x.user_id = u.id)`;
    await this.prisma.$executeRaw`
      INSERT INTO crm_customers (id, user_id, created_at, updated_at, tags)
      SELECT gen_random_uuid(), u.id, now(), now(), ARRAY[]::text[]
        FROM users u
       WHERE u.role = 'ROLE_CUSTOMER' AND u.deleted = false
         AND NOT EXISTS (SELECT 1 FROM crm_customers c WHERE c.user_id = u.id)
      ON CONFLICT (user_id) DO NOTHING`;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(filter: CustomerFilter, pageable: Pageable) {
    const where = this.where(filter);
    const dir = filter.dir === 1 ? Prisma.sql`ASC NULLS FIRST` : Prisma.sql`DESC NULLS LAST`;
    const [rows, count, total] = await Promise.all([
      this.query(where, Prisma.sql`ORDER BY ${SORT_SQL[filter.sort]} ${dir}, c.number DESC LIMIT ${pageable.size} OFFSET ${pageable.page * pageable.size}`),
      this.prisma.$queryRaw<{ n: number }[]>`${STATS} SELECT count(*)::int AS n ${this.from()} WHERE ${where}`,
      this.prisma.crmCustomer.count(),
    ]);
    const team = await this.team.byId();
    return { ...toPage(rows.map((r) => this.row(r, team)), count[0]?.n ?? 0, pageable), allCount: total };
  }

  async get(id: string) {
    const [row] = await this.query(Prisma.sql`c.id = ${id}::uuid AND (c.user_id IS NULL OR u.deleted = false)`, Prisma.empty);
    if (!row) throw new DomainError(404, 'Customer not found');
    const team = await this.team.byId();
    const customer = this.row(row, team);
    const [tickets, tasks, activities, orders, returns] = await Promise.all([
      this.prisma.crmTicket.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.crmTask.findMany({ where: { customerId: id }, orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueAt: 'asc' }], take: 100 }),
      this.prisma.crmActivity.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      row.user_id
        ? this.prisma.order.findMany({
            where: { userId: row.user_id, deleted: false },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: { id: true, orderNumber: true, status: true, grandTotal: true, currency: true, createdAt: true },
          })
        : [],
      row.user_id
        ? this.prisma.orderReturn.findMany({
            where: { order: { userId: row.user_id } },
            orderBy: { createdAt: 'desc' },
            take: 25,
            select: { rmaNumber: true, status: true, createdAt: true, order: { select: { orderNumber: true } } },
          })
        : [],
    ]);

    // The store's own events join the team's notes: orders placed, returns.
    const history = [
      ...activities.map((a) => ({ id: a.id, kind: a.kind, body: a.body, by: a.authorName, at: a.createdAt })),
      ...orders.map((o) => ({
        id: `order:${o.id}`,
        kind: 'order',
        body: `Order #${o.orderNumber} placed · ${fmtMoney(o.grandTotal, o.currency)}`,
        by: null,
        at: o.createdAt,
      })),
      ...returns.map((r) => ({
        id: `return:${r.rmaNumber}`,
        kind: 'order',
        body: `Return ${r.rmaNumber} for order #${r.order.orderNumber} · ${r.status.toLowerCase()}`,
        by: null,
        at: r.createdAt,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 200);

    return {
      ...customer,
      hasAccount: row.user_id !== null,
      averageOrder: customer.orders ? Math.round((customer.ltv / customer.orders) * 100) / 100 : null,
      tickets: tickets.map((t) => ({ reference: ticketRef(t.number), subject: t.subject, status: t.status, createdAt: t.createdAt })),
      tasks: tasks.map((k) => ({
        id: k.id,
        title: k.title,
        dueAt: k.dueAt,
        done: k.doneAt !== null,
        owner: memberOf(team, k.ownerId),
      })),
      recentOrders: orders.slice(0, 5).map((o) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, total: Number(o.grandTotal), currency: o.currency, createdAt: o.createdAt })),
      history,
    };
  }

  /** One customer's list row (orders, spend, tags), or null. */
  async brief(id: string) {
    const [row] = await this.query(Prisma.sql`c.id = ${id}::uuid`, Prisma.empty);
    return row ? this.row(row, await this.team.byId()) : null;
  }

  /** Customers to look after: "At risk", or VIP with an open ticket. */
  async toLookAfter(limit = 8) {
    const where = Prisma.sql`(c.user_id IS NULL OR u.deleted = false) AND (
      (${ORDERS} >= 1 AND s.last_order_at < now() - make_interval(days => ${this.config.crm.atRiskDays}::int))
      OR ('VIP' = ANY(c.tags) AND EXISTS (SELECT 1 FROM crm_tickets t WHERE t.customer_id = c.id AND t.status <> 'solved')))`;
    const rows = await this.query(where, Prisma.sql`ORDER BY coalesce(s.ltv, 0) DESC LIMIT ${limit}`);
    const team = await this.team.byId();
    return rows.map((r) => this.row(r, team));
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** Adds someone who contacted us without an account (phone, email). */
  async create(input: z.output<typeof CustomerCreateSchema>) {
    const email = input.email.trim().toLowerCase();
    const [account, contact] = await Promise.all([
      this.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, deleted: false }, select: { id: true } }),
      this.prisma.crmCustomer.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
    ]);
    if (account || contact) throw new DomainError(409, 'A customer with this email already exists');
    const created = await this.prisma.crmCustomer.create({
      data: { name: input.name.trim(), email, phone: input.phone?.trim() || null, tags: [] },
    });
    return this.get(created.id);
  }

  async update(id: string, input: z.output<typeof CustomerUpdateSchema>, staff: Staff) {
    const c = await this.prisma.crmCustomer.findUnique({ where: { id } });
    if (!c) throw new DomainError(404, 'Customer not found');
    if (input.ownerId !== undefined) await this.team.assertMember(input.ownerId);
    const data: Prisma.CrmCustomerUpdateInput = {};
    if (input.ownerId !== undefined) data.ownerId = input.ownerId;
    if (input.tags !== undefined) data.tags = [...new Set(input.tags)];
    await this.prisma.crmCustomer.update({ where: { id }, data });
    if (input.ownerId !== undefined && input.ownerId !== c.ownerId) {
      const owner = memberOf(await this.team.byId(), input.ownerId);
      await logActivity(this.prisma, { customerId: id }, 'note', `Owner changed to ${owner?.name ?? 'nobody'}`, staff);
    }
    return this.get(id);
  }

  /** The customer's email, for sending them mail. */
  async emailOf(id: string): Promise<{ email: string | null; name: string; userId: string | null }> {
    const [row] = await this.query(Prisma.sql`c.id = ${id}::uuid`, Prisma.empty);
    if (!row) throw new DomainError(404, 'Customer not found');
    return { email: row.email, name: row.name, userId: row.user_id };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private from() {
    return Prisma.sql`FROM crm_customers c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN stats s ON s.user_id = c.user_id`;
  }

  private where(f: CustomerFilter): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`(c.user_id IS NULL OR u.deleted = false)`];
    const q = f.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      parts.push(Prisma.sql`(${NAME} ILIKE ${like} OR ${EMAIL} ILIKE ${like} OR ('C-' || c.number) ILIKE ${like}
        OR EXISTS (SELECT 1 FROM orders o WHERE o.user_id = c.user_id AND o.deleted = false AND o.ship_city ILIKE ${like}))`);
    }
    if (f.owner === 'none') parts.push(Prisma.sql`c.owner_id IS NULL`);
    else if (f.owner) parts.push(Prisma.sql`c.owner_id = ${f.owner}::uuid`);
    if (f.tag && (CUSTOMER_TAG_FILTERS as readonly string[]).includes(f.tag)) {
      parts.push(
        {
          VIP: Prisma.sql`'VIP' = ANY(c.tags)`,
          Repeat: Prisma.sql`${ORDERS} >= 2`,
          New: Prisma.sql`${SINCE} > now() - make_interval(days => ${NEW_CUSTOMER_DAYS}::int)`,
          'At risk': Prisma.sql`(${ORDERS} >= 1 AND s.last_order_at < now() - make_interval(days => ${this.config.crm.atRiskDays}::int))`,
        }[f.tag]!,
      );
    }
    return Prisma.join(parts, ' AND ');
  }

  private query(where: Prisma.Sql, tail: Prisma.Sql) {
    return this.prisma.$queryRaw<Row[]>`
      ${STATS}
      SELECT c.id, c.number, c.user_id, c.owner_id, c.tags,
             ${NAME} AS name, ${EMAIL} AS email, coalesce(u.phone_number, c.phone) AS phone,
             coalesce(u.marketing_opt_in, false) AS consent, ${SINCE} AS since,
             ${ORDERS} AS orders, coalesce(s.ltv, 0) AS ltv, s.last_order_at,
             (SELECT concat_ws(', ', o.ship_city, o.ship_state) FROM orders o
               WHERE o.user_id = c.user_id AND o.deleted = false ORDER BY o.created_at DESC LIMIT 1) AS loc,
             (SELECT count(*)::int FROM crm_tickets t WHERE t.customer_id = c.id AND t.status <> 'solved') AS open_tickets
        ${this.from()}
       WHERE ${where}
       ${tail}`;
  }

  private row(r: Row, team: Awaited<ReturnType<Team['byId']>>) {
    const now = Date.now();
    const orders = Number(r.orders);
    const tags = [...(r.tags ?? [])];
    if (orders >= 2) tags.push('Repeat');
    if (now - r.since.getTime() < NEW_CUSTOMER_DAYS * 86_400_000) tags.push('New');
    if (orders >= 1 && r.last_order_at && now - r.last_order_at.getTime() > this.config.crm.atRiskDays * 86_400_000) tags.push('At risk');
    return {
      id: r.id,
      code: `C-${r.number}`,
      name: r.name,
      email: r.email,
      phone: r.phone,
      location: r.loc && r.loc !== '' ? r.loc : null,
      since: r.since,
      orders,
      ltv: Number(new Prisma.Decimal(r.ltv).toFixed(2)),
      lastOrderAt: r.last_order_at,
      tags,
      marketingConsent: r.consent,
      owner: memberOf(team, r.owner_id),
      openTickets: Number(r.open_tickets),
    };
  }
}

const fmtMoney = (v: Prisma.Decimal, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(v));
