import { Prisma, type PrismaClient } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';
import { money } from '../common/api-response';
import { USER_ROLES, type UserRole } from '../common/enums';
import { DomainError } from '../common/errors';
import { toPage, type Pageable } from '../common/pagination';
import { oneOf } from '../common/validation';

export const ADMIN_CUSTOMER_SORTS = ['totalSpent', 'lastOrderAt', 'orders', 'fullName', 'createdAt', 'email'] as const;

export const RoleUpdateSchema = z.object({
  role: oneOf(USER_ROLES).refine((v) => v !== undefined, 'must not be null'),
});

export interface CustomerFilter {
  search?: string;
  role?: UserRole;
}

/** Payment states in which the customer actually paid (net of refunds below). */
const PAID = Prisma.sql`('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')`;

/** Sort keys → SQL (whitelisted: never interpolate the request's text). */
const SORT_SQL: Record<(typeof ADMIN_CUSTOMER_SORTS)[number], string> = {
  totalSpent: 'total_spent',
  lastOrderAt: 'last_order_at',
  orders: 'orders',
  fullName: 'lower(u.full_name)',
  createdAt: 'u.created_at',
  email: 'u.email',
};

interface CustomerRowSql {
  id: string;
  email: string;
  full_name: string;
  phone_number: string | null;
  role: string;
  enabled: boolean;
  marketing_opt_in: boolean;
  created_at: Date;
  orders: number;
  total_spent: Prisma.Decimal;
  last_order_at: Date | null;
  ship_city: string | null;
  ship_state: string | null;
}

const EXPORT_LIMIT = 50_000;

/**
 * Customer records linked to their orders (FR-AD-06) and staff roles
 * (FR-AD-08). Spend and order counts are aggregated in SQL so the list can
 * sort by them across every account. Guest checkouts have no account and
 * appear only on their orders.
 */
export class AdminCustomerService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(filter: CustomerFilter, pageable: Pageable) {
    const where = customerWhere(filter);
    const [rows, count] = await Promise.all([
      this.query(where, pageable.sort, pageable.size, pageable.page * pageable.size),
      this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM users u WHERE ${where}`,
    ]);
    return toPage(rows.map(toRow), Number(count[0]?.n ?? 0), pageable);
  }

  async exportCsv(filter: CustomerFilter, sort: Pageable['sort']) {
    const rows = await this.query(customerWhere(filter), sort, EXPORT_LIMIT, 0);
    const header = [
      'Name', 'Email', 'Phone', 'Role', 'Enabled', 'Marketing opt-in', 'Location',
      'Orders', 'Total spent', 'Last order', 'Created',
    ];
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    return stringify([
      header,
      ...rows.map((r) => [
        r.full_name,
        r.email,
        r.phone_number ?? '',
        r.role,
        r.enabled ? 'yes' : 'no',
        r.marketing_opt_in ? 'yes' : 'no',
        location(r) ?? '',
        Number(r.orders),
        new Prisma.Decimal(r.total_spent).toFixed(2),
        iso(r.last_order_at),
        iso(r.created_at),
      ]),
    ]);
  }

  async get(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deleted: false },
      include: {
        addresses: { where: { deleted: false }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
        orders: { where: { deleted: false }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw customerNotFound(id);
    const spent = user.orders
      .filter((o) => o.paymentStatus && ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(o.paymentStatus))
      .reduce((sum, o) => sum.add(o.grandTotal.sub(o.refundedTotal)), new Prisma.Decimal(0));
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      role: user.role,
      enabled: user.enabled,
      marketingOptIn: user.marketingOptIn,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      totalSpent: money(spent),
      addresses: user.addresses.map((a) => ({
        id: a.id,
        label: a.label,
        isDefault: a.isDefault,
        recipientName: a.recipientName,
        phone: a.phone,
        addressLine1: a.addressLine1,
        addressLine2: a.addressLine2,
        city: a.city,
        state: a.state,
        postalCode: a.postalCode,
        country: a.country,
      })),
      orders: user.orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        fulfilmentStatus: o.fulfilmentStatus,
        currency: o.currency,
        grandTotal: money(o.grandTotal),
        createdAt: o.createdAt,
        paymentStatus: o.paymentStatus,
      })),
    };
  }

  /** FR-AD-08. An admin can't change their own role (and so can't lock the last admin out by accident). */
  async setRole(id: string, role: UserRole, actingUserId: string) {
    if (id === actingUserId) throw new DomainError(409, "You can't change your own role");
    const user = await this.prisma.user.findFirst({ where: { id, deleted: false } });
    if (!user) throw customerNotFound(id);
    const updated = await this.prisma.user.update({ where: { id }, data: { role } });
    return { id: updated.id, email: updated.email, fullName: updated.fullName, role: updated.role };
  }

  private query(where: Prisma.Sql, sort: Pageable['sort'], limit: number, offset: number) {
    const order = sort.length
      ? sort.map((s) => `${SORT_SQL[s.field as keyof typeof SORT_SQL]} ${s.direction === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`)
      : ['u.created_at DESC'];
    return this.prisma.$queryRaw<CustomerRowSql[]>`
      WITH stats AS (
        SELECT user_id,
               count(*)::int AS orders,
               coalesce(sum(CASE WHEN payment_status IN ${PAID} THEN grand_total - refunded_total ELSE 0 END), 0) AS total_spent,
               max(created_at) AS last_order_at
          FROM orders
         WHERE deleted = false AND user_id IS NOT NULL
         GROUP BY user_id
      ), latest AS (
        SELECT DISTINCT ON (user_id) user_id, ship_city, ship_state
          FROM orders
         WHERE deleted = false AND user_id IS NOT NULL
         ORDER BY user_id, created_at DESC
      )
      SELECT u.id, u.email, u.full_name, u.phone_number, u.role, u.enabled, u.marketing_opt_in, u.created_at,
             coalesce(s.orders, 0) AS orders,
             coalesce(s.total_spent, 0) AS total_spent,
             s.last_order_at, l.ship_city, l.ship_state
        FROM users u
        LEFT JOIN stats s ON s.user_id = u.id
        LEFT JOIN latest l ON l.user_id = u.id
       WHERE ${where}
       ORDER BY ${Prisma.raw([...order, 'u.id'].join(', '))}
       LIMIT ${limit} OFFSET ${offset}`;
  }
}

const customerNotFound = (id: string) => new DomainError(404, `Customer ${id} was not found`);

function customerWhere(f: CustomerFilter): Prisma.Sql {
  const parts = [Prisma.sql`u.deleted = false`];
  if (f.role) parts.push(Prisma.sql`u.role = ${f.role}`);
  const q = f.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(Prisma.sql`(u.full_name ILIKE ${like} OR u.email ILIKE ${like} OR u.phone_number ILIKE ${like})`);
  }
  return Prisma.join(parts, ' AND ');
}

/** "City, ST" from the latest order. */
const location = (r: CustomerRowSql) => (r.ship_city ? [r.ship_city, r.ship_state].filter(Boolean).join(', ') : null);

function toRow(r: CustomerRowSql) {
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    phoneNumber: r.phone_number,
    role: r.role,
    enabled: r.enabled,
    marketingOptIn: r.marketing_opt_in,
    location: location(r),
    createdAt: r.created_at,
    orders: Number(r.orders),
    totalSpent: money(new Prisma.Decimal(r.total_spent)),
    lastOrderAt: r.last_order_at,
  };
}
