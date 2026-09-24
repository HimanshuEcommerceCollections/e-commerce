import { z } from 'zod';
import { CategoryNotFoundError, SlugAlreadyExistsError } from '../common/errors';
import { optionalString, requiredString } from '../common/validation';
import type { Db } from '../db';
import { toCategoryResponse } from './product.mapper';

export const CategoryCreateSchema = z.object({
  name: requiredString({ max: 100 }),
  slug: requiredString({ max: 120 }),
  description: optionalString({ max: 500 }),
});

export class CategoryService {
  constructor(private readonly db: Db) {}

  async create(input: z.output<typeof CategoryCreateSchema>) {
    // Slugs are unique across soft-deleted rows too (uk_product_categories_slug).
    if (await this.db.productCategory.findUnique({ where: { slug: input.slug } })) {
      throw new SlugAlreadyExistsError(input.slug);
    }
    const category = await this.db.productCategory.create({
      data: { name: input.name, slug: input.slug, description: input.description ?? null },
    });
    return toCategoryResponse(category);
  }

  async findAll() {
    const rows = await this.db.productCategory.findMany({ where: { deleted: false }, orderBy: { createdAt: 'asc' } });
    return rows.map(toCategoryResponse);
  }

  async findById(id: string) {
    const category = await this.db.productCategory.findFirst({ where: { id, deleted: false } });
    if (!category) throw new CategoryNotFoundError(id);
    return toCategoryResponse(category);
  }
}
