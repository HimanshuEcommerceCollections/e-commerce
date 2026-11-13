import { Prisma, type AuditEvent, type PrismaClient } from '@prisma/client';
import { logger } from '../common/logger';
import { DomainError } from '../common/errors';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';

const log = logger('audit');

/** Who made a change: the catalog team, a seller, or an automatic rule. */
export const AUDIT_ACTOR_TYPES = ['team', 'seller', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Filter groups of the audit log, with the label the admin page shows.
 * `supplier`, `doc`, `unpub` are written by supplier onboarding and automatic
 * rules; every other group is written by the catalog and seller flows.
 */
export const AUDIT_CATEGORIES = {
  stock: 'Stock change',
  price: 'Price change',
  submit: 'Product submitted',
  edit: 'Edit submitted',
  decision: 'Review decision',
  assign: 'Review assigned',
  delist: 'Delisting',
  status: 'Status change',
  product: 'Product edit',
  import: 'Import',
  supplier: 'Supplier status',
  doc: 'Document',
  unpub: 'Auto-unpublished',
  integration: 'Integration',
} as const;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;
export const isAuditCategory = (v: string): v is AuditCategory => Object.hasOwn(AUDIT_CATEGORIES, v);

export const AUDIT_SORTS = ['createdAt'] as const;

/** The person (or rule) behind an event. Name and role are looked up from `id` when left out. */
export interface AuditActor {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  role?: string | null;
  /** Derived from the role when left out: ROLE_MERCHANT → seller, other roles → team, no actor → system. */
  type?: AuditActorType;
}

export interface AuditInput {
  /** Dotted event type, e.g. `product.status_changed`. */
  action: string;
  category: AuditCategory;
  /** Null for automatic rules. */
  actor: AuditActor | null;
  /** Where it came from: "Admin catalog", "Review queue", "Portal", "Bulk upload", "System"... */
  source: string;
  entity: { type: string; id?: string | null; code?: string | null; label?: string | null };
  /** The seller whose item it is; the name is looked up from `id` when left out. */
  seller?: { id?: string | null; name?: string | null } | null;
  summary: string;
  before?: string | null;
  after?: string | null;
  note?: string | null;
  alert?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditFilter {
  from?: Date;
  to?: Date;
  categories?: AuditCategory[];
  action?: string;
  actorType?: AuditActorType;
  actorId?: string;
  sellerId?: string;
  entityType?: string;
  entityId?: string;
  entityCode?: string;
  q?: string;
  alerts?: boolean;
}

/** A staff or seller account as the auth middleware loads it. */
export const auditActor = (user: { id: string; email: string; fullName?: string | null; role?: string | null }): AuditActor => ({
  id: user.id,
  email: user.email,
  name: user.fullName ?? null,
  role: user.role ?? null,
});

/** "Dropped to zero" / "Fell 88% in one update", or null when the change is unremarkable. */
export function stockAlert(from: number, to: number): string | null {
  if (from > 0 && to === 0) return 'Dropped to zero';
  if (from > 0 && to < from && (from - to) / from >= 0.8) return `Fell ${Math.round(((from - to) / from) * 100)}% in one update`;
  return null;
}

const MAX_EXPORT_ROWS = 50_000;
const clip = (v: string | null | undefined, max: number) => (v == null ? null : v.length > max ? `${v.slice(0, max - 1)}…` : v);

/**
 * The catalog audit log. `record` is called after the business change has
 * committed and never throws: a failed write is logged and the request carries
 * on, so auditing can never undo or block a change. Rows are append-only.
 */
export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: AuditInput | AuditInput[]): Promise<void> {
    const inputs = Array.isArray(input) ? input : [input];
    if (!inputs.length) return;
    try {
      const names = await this.names(inputs);
      await this.prisma.auditEvent.createMany({
        data: inputs.map((i) => {
          const actor = i.actor;
          const known = actor?.id ? names.get(actor.id) : undefined;
          const role = actor?.role ?? known?.role ?? null;
          const sellerName = i.seller?.name ?? (i.seller?.id ? names.get(i.seller.id)?.name : null) ?? null;
          return {
            action: i.action.slice(0, 60),
            category: i.category,
            actorId: actor?.id ?? null,
            actorEmail: clip(actor?.email ?? known?.email ?? null, 255),
            actorName: clip(actor?.name ?? known?.name ?? null, 200),
            actorRole: clip(role, 20),
            actorType: actor ? actor.type ?? (role === 'ROLE_MERCHANT' ? 'seller' : 'team') : 'system',
            source: clip(i.source, 100)!,
            entityType: i.entity.type.slice(0, 30),
            entityId: clip(i.entity.id ?? null, 100),
            entityCode: clip(i.entity.code ?? null, 255),
            entityLabel: clip(i.entity.label ?? null, 255),
            sellerId: i.seller?.id ?? null,
            sellerName: clip(sellerName, 200),
            summary: clip(i.summary, 500)!,
            beforeValue: clip(i.before ?? null, 500),
            afterValue: clip(i.after ?? null, 500),
            note: clip(i.note ?? null, 2000),
            alert: clip(i.alert ?? null, 255),
            details: (i.details ?? {}) as Prisma.InputJsonValue,
          };
        }),
      });
    } catch (e) {
      log.error(`Audit write failed for ${inputs.map((i) => i.action).join(', ')}: ${(e as Error).message}`);
    }
  }

  /** Names, emails and roles of the actors and sellers given only by id. */
  private async names(inputs: AuditInput[]) {
    const ids = new Set<string>();
    for (const i of inputs) {
      if (i.actor?.id && (!i.actor.name || !i.actor.role || !i.actor.email)) ids.add(i.actor.id);
      if (i.seller?.id && !i.seller.name) ids.add(i.seller.id);
    }
    if (!ids.size) return new Map<string, { name: string; email: string; role: string }>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, fullName: true, email: true, role: true },
    });
    return new Map(users.map((u) => [u.id, { name: u.fullName, email: u.email, role: u.role }]));
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(filter: AuditFilter, pageable: Pageable) {
    const where = this.where(filter);
    const [rows, total] = await Promise.all([
      this.prisma.auditEvent.findMany({ where, orderBy: orderBy(pageable, []).concat({ seq: 'desc' }), ...skipTake(pageable) }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return toPage(rows.map(view), total, pageable);
  }

  /** By uuid or by its display number (EV-123). */
  async get(id: string) {
    const seq = eventSeq(id);
    const row = seq !== null
      ? await this.prisma.auditEvent.findUnique({ where: { seq } })
      : /^[0-9a-f-]{36}$/i.test(id)
        ? await this.prisma.auditEvent.findUnique({ where: { id } })
        : null;
    if (!row) throw new DomainError(404, `Audit event '${id}' was not found`);
    return view(row);
  }

  /** Tiles for the last 24 hours, and the sellers and categories to filter by. */
  async stats() {
    const since = new Date(Date.now() - 86_400_000);
    const day = { createdAt: { gte: since } };
    const [events, stock, alerts, decisions, sellers] = await Promise.all([
      this.prisma.auditEvent.count({ where: day }),
      this.prisma.auditEvent.count({ where: { ...day, category: 'stock' } }),
      this.prisma.auditEvent.count({ where: { ...day, alert: { not: null } } }),
      this.prisma.auditEvent.count({ where: { ...day, category: { in: ['decision', 'supplier'] } } }),
      this.prisma.auditEvent.groupBy({
        by: ['sellerId', 'sellerName'],
        where: { sellerId: { not: null } },
        orderBy: { sellerName: 'asc' },
        take: 500,
      }),
    ]);
    const seen = new Map<string, string>();
    for (const s of sellers) if (s.sellerId && !seen.has(s.sellerId)) seen.set(s.sellerId, s.sellerName ?? s.sellerId);
    return {
      last24h: { events, stockChanges: stock, stockAlerts: alerts, reviewDecisions: decisions },
      sellers: [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      categories: Object.entries(AUDIT_CATEGORIES).map(([key, label]) => ({ key, label })),
    };
  }

  /** The filtered set as CSV, newest first (capped at 50,000 rows). */
  async exportCsv(filter: AuditFilter): Promise<{ csv: string; rows: number }> {
    const rows = await this.prisma.auditEvent.findMany({
      where: this.where(filter),
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: MAX_EXPORT_ROWS,
    });
    const header = [
      'event_id', 'time', 'action', 'category', 'item_code', 'item', 'before', 'after', 'actor', 'actor_email',
      'actor_type', 'source', 'seller', 'summary', 'note', 'alert',
    ];
    const lines = rows.map((r) =>
      [
        `EV-${r.seq}`, r.createdAt.toISOString(), r.action, AUDIT_CATEGORIES[r.category as AuditCategory] ?? r.category,
        r.entityCode, r.entityLabel, r.beforeValue, r.afterValue, r.actorName ?? (r.actorType === 'system' ? 'System' : r.actorEmail),
        r.actorEmail, r.actorType, r.source, r.sellerName, r.summary, r.note, r.alert,
      ].map(csvCell).join(','),
    );
    return { csv: [header.join(','), ...lines].join('\r\n') + '\r\n', rows: rows.length };
  }

  private where(f: AuditFilter): Prisma.AuditEventWhereInput {
    const and: Prisma.AuditEventWhereInput[] = [];
    if (f.from || f.to) and.push({ createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } });
    if (f.categories?.length) and.push({ category: { in: f.categories } });
    if (f.action) and.push({ action: f.action });
    if (f.actorType) and.push({ actorType: f.actorType });
    if (f.actorId) and.push({ actorId: f.actorId });
    if (f.sellerId) and.push({ sellerId: f.sellerId });
    if (f.entityType) and.push({ entityType: f.entityType });
    if (f.entityId) and.push({ entityId: f.entityId });
    if (f.entityCode) and.push({ entityCode: { equals: f.entityCode, mode: 'insensitive' } });
    if (f.alerts) and.push({ alert: { not: null } });
    const q = f.q?.trim();
    if (q) {
      const seq = eventSeq(q);
      const contains = { contains: q, mode: 'insensitive' as const };
      and.push({
        OR: [
          ...(seq !== null ? [{ seq }] : []),
          { summary: contains },
          { entityCode: contains },
          { entityLabel: contains },
          { entityId: contains },
          { actorEmail: contains },
          { actorName: contains },
          { sellerName: contains },
          { note: contains },
          { action: contains },
        ],
      });
    }
    return and.length ? { AND: and } : {};
  }
}

function eventSeq(v: string): bigint | null {
  const m = /^EV-?(\d{1,18})$/i.exec(v.trim());
  return m ? BigInt(m[1]) : null;
}

function view(r: AuditEvent) {
  return {
    id: r.id,
    eventId: `EV-${r.seq}`,
    createdAt: r.createdAt,
    action: r.action,
    category: r.category,
    categoryLabel: AUDIT_CATEGORIES[r.category as AuditCategory] ?? r.category,
    actor: { id: r.actorId, email: r.actorEmail, name: r.actorName, role: r.actorRole, type: r.actorType as AuditActorType },
    source: r.source,
    entity: { type: r.entityType, id: r.entityId, code: r.entityCode, label: r.entityLabel },
    seller: r.sellerId ? { id: r.sellerId, name: r.sellerName } : null,
    summary: r.summary,
    before: r.beforeValue,
    after: r.afterValue,
    note: r.note,
    alert: r.alert,
    details: r.details as Record<string, unknown>,
  };
}

/** Quoted, with spreadsheet formulas neutralised. */
function csvCell(v: string | null | undefined): string {
  let s = v ?? '';
  if (/^[=+@\t\r]/.test(s) || /^-[^\d]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
