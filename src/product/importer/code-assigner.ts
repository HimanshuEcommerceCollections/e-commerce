import type { Prisma } from '@prisma/client';
import type { RowResult } from './import.service';
import { SKU_PREFIX, categoryCode, colorCode, sizeCode, subcategoryCode, variantCode } from './sku-codes';

export interface ParentRef {
  id: string;
  categoryId: string | null;
}

/** Rows that become variants of one parent product. */
interface Group {
  rows: RowResult[];
  /** Set for a Parent_Product_ID given in the file; generated otherwise. */
  code: string;
  /** `GS-CL-MEN-` for a generated code. */
  prefix: string;
}

const norm = (value: string | null) => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const variantKey = (r: RowResult) => [r.color, r.size, r.color || r.size ? null : r.variantName].map(norm).join('|');
const variantLabel = (r: RowResult) =>
  [r.color, r.size].filter(Boolean).join(' / ') || r.variantName || 'with no Color, Size or Variant_Name';

/**
 * Generates SKU_ID and Parent_Product_ID for valid rows without a SKU_ID,
 * following `GS-<CATEGORY>-<SUBCATEGORY>-<SEQUENCE>` for parents and
 * `<parent>-<COLOR>-<SIZE>` for their variant SKUs.
 *
 * - Rows without a Parent_Product_ID are grouped by category, subcategory,
 *   brand and product name (without its variant part). A group joins this
 *   merchant's existing generated parent of the same name, so re-importing a
 *   sheet never creates the product twice; otherwise it takes the next free
 *   sequence for its prefix.
 * - Rows repeating a variant (same colour and size) of their product, in the
 *   file or in the catalog, are rejected like duplicate SKUs (FR-IM-05).
 * - A code already taken gets `-2`, `-3`… appended.
 *
 * Must run in the import transaction, holding the code-generation lock.
 */
export class CodeAssigner {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly merchantId: string,
    /** Parents the import attaches to, by code; groups joining an existing parent are added. */
    private readonly parents: Map<string, ParentRef>,
  ) {}

  async assign(results: RowResult[]) {
    const groups = this.group(results);
    await this.assignParentCodes(results, groups);
    this.rejectRepeatedVariantsInFile(groups);
    await this.assignSkus(results, groups);
  }

  private group(results: RowResult[]) {
    const groups = new Map<string, Group>();
    for (const r of results) {
      if (!r.valid || !r.generated) continue;
      const key = r.parentCode
        ? `code:${r.parentCode}`
        : ['name', r.category!.id, norm(r.subcategory), norm(r.brand), norm(r.baseName)].join('|');
      let group = groups.get(key);
      if (!group) {
        const prefix = r.parentCode
          ? ''
          : `${SKU_PREFIX}-${categoryCode(r.category!.name, r.category!.slug)}-${subcategoryCode(r.subcategory ?? '')}-`;
        group = { rows: [], code: r.parentCode, prefix };
        groups.set(key, group);
      }
      group.rows.push(r);
    }
    return [...groups.values()];
  }

  private async assignParentCodes(results: RowResult[], groups: Group[]) {
    const prefixes = [...new Set(groups.filter((g) => !g.code).map((g) => g.prefix))];
    if (!prefixes.length) return;

    const [parents, products] = await Promise.all([
      this.tx.parentProduct.findMany({
        where: { OR: prefixes.map((p) => ({ code: { startsWith: p } })) },
        select: { id: true, code: true, name: true, brand: true, categoryId: true, merchantId: true, deleted: true },
      }),
      this.tx.product.findMany({ where: { OR: prefixes.map((p) => ({ sku: { startsWith: p } })) }, select: { sku: true } }),
    ]);

    // Highest sequence per prefix, over the catalog and the codes given in this file.
    const used = [
      ...parents.map((p) => p.code),
      ...products.map((p) => p.sku),
      ...results.flatMap((r) => [r.sku, r.parentCode]).filter(Boolean),
    ];
    const next = new Map<string, number>();
    for (const prefix of prefixes) {
      const pattern = new RegExp(`^${escape(prefix)}(\\d+)(?:-|$)`);
      let max = 0;
      for (const code of used) {
        const m = pattern.exec(code);
        if (m) max = Math.max(max, Number(m[1]));
      }
      next.set(prefix, max + 1);
    }

    for (const group of groups) {
      if (group.code) continue;
      const first = group.rows[0];
      const own = new RegExp(`^${escape(group.prefix)}\\d+$`);
      const existing = parents.find(
        (p) =>
          own.test(p.code) &&
          !p.deleted &&
          p.merchantId === this.merchantId &&
          p.categoryId === first.category!.id &&
          norm(p.brand) === norm(first.brand) &&
          norm(p.name) === norm(first.baseName),
      );
      if (existing) {
        group.code = existing.code;
        this.parents.set(existing.code, { id: existing.id, categoryId: existing.categoryId });
      } else {
        const sequence = next.get(group.prefix)!;
        next.set(group.prefix, sequence + 1);
        group.code = `${group.prefix}${String(sequence).padStart(3, '0')}`;
      }
      for (const r of group.rows) r.parentCode = group.code;
    }
  }

  private rejectRepeatedVariantsInFile(groups: Group[]) {
    for (const group of groups) {
      const byVariant = new Map<string, RowResult[]>();
      for (const r of group.rows) byVariant.set(variantKey(r), [...(byVariant.get(variantKey(r)) ?? []), r]);
      for (const rows of byVariant.values()) {
        if (rows.length < 2) continue;
        const list = rows.map((r) => r.row.rowNumber).join(', ');
        for (const r of rows) {
          r.reject(`Variant '${variantLabel(r)}' of '${r.baseName}' appears more than once in the file (rows ${list})`);
        }
      }
    }
  }

  private async assignSkus(results: RowResult[], groups: Group[]) {
    const existingParentIds = groups.map((g) => this.parents.get(g.code)?.id).filter((id): id is string => !!id);
    const variants = existingParentIds.length
      ? await this.tx.product.findMany({
          where: { parentId: { in: existingParentIds } },
          select: { sku: true, parentId: true, color: true, size: true, variantName: true, deleted: true },
        })
      : [];
    const taken = new Set([...variants.map((v) => v.sku), ...results.map((r) => r.sku).filter(Boolean)]);

    const assigned: RowResult[] = [];
    for (const group of groups) {
      const parentId = this.parents.get(group.code)?.id;
      const inCatalog = new Map<string, string>();
      for (const v of variants) {
        if (v.parentId !== parentId || v.deleted) continue;
        const key = [v.color, v.size, v.color || v.size ? null : v.variantName].map(norm).join('|');
        inCatalog.set(key, v.sku);
      }
      for (const r of group.rows) {
        if (!r.valid) continue;
        const existingSku = inCatalog.get(variantKey(r));
        if (existingSku) {
          r.reject(`Variant '${variantLabel(r)}' of '${group.code}' already exists in the catalog as SKU ${existingSku}`);
          continue;
        }
        const suffix = [colorCode(r.color ?? ''), sizeCode(r.size ?? '')].filter(Boolean).join('-') ||
          variantCode(r.variantName ?? '');
        r.sku = nextFree(suffix ? `${group.code}-${suffix}` : group.code, taken);
        assigned.push(r);
      }
    }

    // A generated SKU may still belong to a product elsewhere in the catalog.
    let pending = assigned;
    while (pending.length) {
      const clash = new Set(
        (await this.tx.product.findMany({ where: { sku: { in: pending.map((r) => r.sku) } }, select: { sku: true } })).map(
          (p) => p.sku,
        ),
      );
      pending = pending.filter((r) => clash.has(r.sku));
      for (const r of pending) r.sku = nextFree(r.sku, taken);
    }
  }
}

/** `base`, or `base-2`, `base-3`… whichever is not yet taken; marks it taken. */
function nextFree(base: string, taken: Set<string>): string {
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
  taken.add(code);
  return code;
}
