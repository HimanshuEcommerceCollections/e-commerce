import { z } from 'zod';
import { CategoryNotFoundError, SlugAlreadyExistsError } from '../common/errors';
import { integer, optionalString, optionalUuid, requiredString, ValidationError } from '../common/validation';
import type { Db } from '../db';
import { toCategoryResponse } from './product.mapper';

export const CategoryCreateSchema = z.object({
  name: requiredString({ max: 100 }),
  slug: requiredString({ max: 120 }),
  description: optionalString({ max: 500 }),
  /** Makes the new row a subcategory ("section") of this department. */
  parentId: optionalUuid(),
  position: integer({ positiveOrZero: true }),
  /** SKU code segment (CL, MEN): letters and digits only. */
  code: optionalString({ max: 10, pattern: /^[A-Za-z0-9]*$/, patternMessage: 'may contain only letters and digits' }),
});

/** Parent products with at least one live SKU count as live. */
const LIVE_PARENT = { deleted: false, variants: { some: { deleted: false, status: 'ACTIVE' } } };

export class CategoryService {
  constructor(private readonly db: Db) {}

  async create(input: z.output<typeof CategoryCreateSchema>) {
    // Slugs are unique across soft-deleted rows too (uk_product_categories_slug).
    if (await this.db.productCategory.findUnique({ where: { slug: input.slug } })) {
      throw new SlugAlreadyExistsError(input.slug);
    }
    if (input.parentId) {
      // The taxonomy is two levels: department → section.
      const parent = await this.db.productCategory.findFirst({ where: { id: input.parentId, deleted: false } });
      if (!parent) throw new CategoryNotFoundError(input.parentId);
      if (parent.parentId) throw new ValidationError({ parentId: 'must be a top-level category' });
    }
    const category = await this.db.productCategory.create({
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        position: input.position ?? 0,
        code: input.code?.toUpperCase() || null,
      },
    });
    return toCategoryResponse(category);
  }

  async findAll() {
    const rows = await this.db.productCategory.findMany({
      where: { deleted: false },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toCategoryResponse);
  }

  async findById(id: string) {
    const category = await this.db.productCategory.findFirst({ where: { id, deleted: false } });
    if (!category) throw new CategoryNotFoundError(id);
    return toCategoryResponse(category);
  }

  /**
   * Departments (by position) → sections, with live product counts and the
   * product types each section holds — the storefront's navigation (FR-ST-02).
   * One pass over live parents; the catalog is ~1,000 SKUs.
   */
  async tree() {
    const [categories, parents] = await Promise.all([
      this.db.productCategory.findMany({
        where: { deleted: false },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
      this.db.parentProduct.findMany({
        where: LIVE_PARENT,
        select: { categoryId: true, subcategoryId: true, productType: true },
      }),
    ]);

    const byId = new Map(categories.map((c) => [c.id, c]));
    const deptCount = new Map<string, number>();
    const subCount = new Map<string, number>();
    const typeCount = new Map<string, Map<string, number>>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

    for (const p of parents) {
      // A parent mapped straight to a section still counts for its department.
      let deptId = p.categoryId;
      let subId = p.subcategoryId;
      const assigned = deptId ? byId.get(deptId) : undefined;
      if (assigned?.parentId) {
        subId ??= assigned.id;
        deptId = assigned.parentId;
      }
      if (!deptId && subId) deptId = byId.get(subId)?.parentId ?? null;
      if (deptId) bump(deptCount, deptId);
      if (subId) {
        bump(subCount, subId);
        if (p.productType) {
          const types = typeCount.get(subId) ?? new Map<string, number>();
          bump(types, p.productType);
          typeCount.set(subId, types);
        }
      }
    }

    return categories
      .filter((c) => !c.parentId)
      .map((dept) => ({
        ...toCategoryResponse(dept),
        productCount: deptCount.get(dept.id) ?? 0,
        subcategories: categories
          .filter((s) => s.parentId === dept.id)
          .map((sub) => ({
            ...toCategoryResponse(sub),
            productCount: subCount.get(sub.id) ?? 0,
            productTypes: [...(typeCount.get(sub.id) ?? new Map<string, number>())]
              .map(([name, productCount]) => ({ name, productCount }))
              .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name)),
          })),
      }));
  }
}
