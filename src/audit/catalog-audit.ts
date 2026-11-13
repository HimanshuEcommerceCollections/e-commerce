import type { PrismaClient } from '@prisma/client';
import { stockAlert, type AuditActor, type AuditInput } from './audit.service';

/**
 * Before/after snapshots for the admin catalog's actions, and the audit events
 * they make. The routes take a snapshot, run the change, then record the
 * difference, so the catalog services stay unaware of the audit log.
 */
const SOURCE = 'Admin catalog';

export interface ParentSnapshot {
  id: string;
  code: string;
  name: string;
  merchantId: string;
  brand: string | null;
  productType: string | null;
  shortDescription: string | null;
  description: string | null;
  subcategory: string | null;
  featured: boolean;
  keyFeatures: string | null;
  statuses: string[];
}

export async function parentSnapshots(prisma: PrismaClient, ids: string[]): Promise<Map<string, ParentSnapshot>> {
  const rows = await prisma.parentProduct.findMany({
    where: { id: { in: [...new Set(ids)] } },
    include: { subcategory: { select: { name: true } }, variants: { where: { deleted: false }, select: { status: true } } },
  });
  return new Map(
    rows.map((p) => [
      p.id,
      {
        id: p.id,
        code: p.code,
        name: p.name,
        merchantId: p.merchantId,
        brand: p.brand,
        productType: p.productType,
        shortDescription: p.shortDescription,
        description: p.description,
        subcategory: p.subcategory?.name ?? null,
        featured: p.featured,
        keyFeatures: p.keyFeatures,
        statuses: [...new Set(p.variants.map((v) => v.status))].sort(),
      },
    ]),
  );
}

/** "ACTIVE", or "Mixed (ACTIVE, DRAFT)". */
export const statusText = (statuses: string[]) =>
  statuses.length === 0 ? '—' : statuses.length === 1 ? statuses[0] : `Mixed (${statuses.join(', ')})`;

const productEntity = (p: { id: string; code: string; name: string }) => ({ type: 'product', id: p.id, code: p.code, label: p.name });

export function productCreatedEvent(actor: AuditActor, p: { id: string; code: string; name: string; merchantId?: string; variants?: { sku: string; status: string }[] }): AuditInput {
  const statuses = [...new Set((p.variants ?? []).map((v) => v.status))];
  return {
    action: 'product.created',
    category: 'product',
    actor,
    source: SOURCE,
    entity: productEntity(p),
    seller: p.merchantId ? { id: p.merchantId } : null,
    summary: `Created ${p.name} with ${p.variants?.length ?? 0} SKU(s)`,
    before: '—',
    after: statusText(statuses),
    details: { skus: (p.variants ?? []).map((v) => v.sku) },
  };
}

const CONTENT_FIELDS: Array<[keyof ParentSnapshot, string]> = [
  ['name', 'Title'],
  ['brand', 'Brand'],
  ['productType', 'Product type'],
  ['subcategory', 'Subcategory'],
  ['featured', 'Featured'],
  ['shortDescription', 'Short description'],
  ['description', 'Description'],
  ['keyFeatures', 'Key features'],
];
const short = (v: unknown) => {
  const s = v === null || v === undefined || v === '' ? '—' : String(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

/** A content edit and/or a status change of one product. */
export function productUpdatedEvents(actor: AuditActor, before: ParentSnapshot, after: ParentSnapshot): AuditInput[] {
  const events: AuditInput[] = [];
  const changed = CONTENT_FIELDS.filter(([k]) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.length) {
    events.push({
      action: 'product.updated',
      category: 'product',
      actor,
      source: SOURCE,
      entity: productEntity(after),
      seller: { id: after.merchantId },
      summary: `Edited ${changed.map(([, l]) => l.toLowerCase()).join(', ')}`,
      before: changed.map(([k, l]) => `${l}: ${short(before[k])}`).join(' · '),
      after: changed.map(([k, l]) => `${l}: ${short(after[k])}`).join(' · '),
      details: { fields: changed.map(([k, l]) => ({ field: l, before: before[k], after: after[k] })) },
    });
  }
  if (statusText(before.statuses) !== statusText(after.statuses)) events.push(statusEvent(actor, before, after.statuses));
  return events;
}

export function statusEvent(actor: AuditActor, before: ParentSnapshot, to: string[] | string): AuditInput {
  const after = Array.isArray(to) ? statusText(to) : to;
  return {
    action: 'product.status_changed',
    category: 'status',
    actor,
    source: SOURCE,
    entity: productEntity(before),
    seller: { id: before.merchantId },
    summary: `Status ${statusText(before.statuses)} → ${after}`,
    before: statusText(before.statuses),
    after,
  };
}

export function productDeletedEvent(actor: AuditActor, before: ParentSnapshot): AuditInput {
  return {
    action: 'product.deleted',
    category: 'product',
    actor,
    source: SOURCE,
    entity: productEntity(before),
    seller: { id: before.merchantId },
    summary: `Deleted ${before.name} and its SKUs`,
    before: statusText(before.statuses),
    after: 'Deleted',
  };
}

export interface VariantSnapshot {
  id: string;
  sku: string;
  name: string;
  merchantId: string;
  parentCode: string;
  price: string;
  mrp: string | null;
  cost: string | null;
  status: string;
  stockQuantity: number;
  taxRate: string | null;
  lowStockThreshold: number | null;
  urlSlug: string | null;
}

export async function variantSnapshot(prisma: PrismaClient, id: string): Promise<VariantSnapshot | null> {
  const v = await prisma.product.findUnique({ where: { id }, include: { parent: { select: { code: true } } } });
  if (!v) return null;
  return {
    id: v.id,
    sku: v.sku,
    name: v.name,
    merchantId: v.merchantId,
    parentCode: v.parent.code,
    price: v.price.toFixed(2),
    mrp: v.mrp?.toFixed(2) ?? null,
    cost: v.cost?.toFixed(2) ?? null,
    status: v.status,
    stockQuantity: v.stockQuantity,
    taxRate: v.taxRate?.toFixed(2) ?? null,
    lowStockThreshold: v.lowStockThreshold,
    urlSlug: v.urlSlug,
  };
}

const variantEntity = (v: VariantSnapshot) => ({ type: 'variant', id: v.id, code: v.sku, label: v.name });
const pct = (from: number, to: number) => (from === 0 ? '' : ` (${to >= from ? '+' : '−'}${Math.abs(((to - from) / from) * 100).toFixed(1)}%)`);

export function stockEvent(
  actor: AuditActor | null,
  v: { id: string; sku: string; name: string; merchantId: string },
  from: number,
  to: number,
  source: string,
  note?: string | null,
  action = 'stock.changed',
): AuditInput {
  return {
    action,
    category: 'stock',
    actor,
    source,
    entity: { type: 'variant', id: v.id, code: v.sku, label: v.name },
    seller: { id: v.merchantId },
    summary: `Stock ${from} → ${to}`,
    before: String(from),
    after: String(to),
    note: note ?? null,
    alert: stockAlert(from, to),
    details: { from, to, delta: to - from },
  };
}

/** Price, stock, status and the other SKU fields, one event per kind of change. */
export function variantUpdatedEvents(actor: AuditActor, before: VariantSnapshot, after: VariantSnapshot): AuditInput[] {
  const events: AuditInput[] = [];
  if (before.price !== after.price || before.mrp !== after.mrp) {
    const from = Number(before.price);
    const to = Number(after.price);
    events.push({
      action: 'price.changed',
      category: 'price',
      actor,
      source: SOURCE,
      entity: variantEntity(after),
      seller: { id: after.merchantId },
      summary: `Price $${before.price} → $${after.price}${pct(from, to)}`,
      before: `$${before.price}${before.mrp ? ` · MRP $${before.mrp}` : ''}`,
      after: `$${after.price}${after.mrp ? ` · MRP $${after.mrp}` : ''}`,
      details: { price: { before: before.price, after: after.price }, mrp: { before: before.mrp, after: after.mrp } },
    });
  }
  if (before.stockQuantity !== after.stockQuantity) {
    events.push(stockEvent(actor, after, before.stockQuantity, after.stockQuantity, SOURCE, 'Stock level set'));
  }
  if (before.status !== after.status) {
    events.push({
      action: 'variant.status_changed',
      category: 'status',
      actor,
      source: SOURCE,
      entity: variantEntity(after),
      seller: { id: after.merchantId },
      summary: `SKU status ${before.status} → ${after.status}`,
      before: before.status,
      after: after.status,
    });
  }
  const other = (['cost', 'taxRate', 'lowStockThreshold', 'urlSlug'] as const).filter((k) => before[k] !== after[k]);
  if (other.length) {
    events.push({
      action: 'variant.updated',
      category: 'product',
      actor,
      source: SOURCE,
      entity: variantEntity(after),
      seller: { id: after.merchantId },
      summary: `Edited ${other.join(', ')}`,
      before: other.map((k) => `${k}: ${short(before[k])}`).join(' · '),
      after: other.map((k) => `${k}: ${short(after[k])}`).join(' · '),
      details: { fields: other.map((k) => ({ field: k, before: before[k], after: after[k] })) },
    });
  }
  return events;
}
