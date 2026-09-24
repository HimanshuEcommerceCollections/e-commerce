import type { Request } from 'express';
import { DomainError } from './errors';

/**
 * Spring Data `Pageable` query parameters (`page`, `size`, `sort=field,dir`)
 * and the JSON a Spring `Page` serialized to, so list responses keep their
 * exact shape.
 */
export interface Pageable {
  page: number;
  size: number;
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

const DEFAULT_SIZE = 20;
const MAX_SIZE = 2000; // spring.data.web.pageable.max-page-size default

export function parsePageable(
  req: Request,
  defaults: { sort: string; allowedSorts: readonly string[] },
): Pageable {
  const page = Math.max(0, toInt(req.query.page) ?? 0);
  const rawSize = toInt(req.query.size);
  const size = rawSize === undefined || rawSize < 1 ? DEFAULT_SIZE : Math.min(rawSize, MAX_SIZE);

  const rawSort = req.query.sort;
  const sortParams = (Array.isArray(rawSort) ? rawSort : rawSort === undefined ? [] : [rawSort]).map(String);
  const sort: Pageable['sort'] = [];
  for (const param of sortParams.length ? sortParams : [defaults.sort]) {
    const parts = param.split(',').map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1]?.toLowerCase();
    const direction = last === 'desc' ? 'desc' : 'asc';
    const fields = last === 'asc' || last === 'desc' ? parts.slice(0, -1) : parts;
    for (const f of fields) {
      if (!defaults.allowedSorts.includes(f)) {
        throw new DomainError(400, `Unknown sort property '${f}'`);
      }
      sort.push({ field: f, direction });
    }
  }
  return { page, size, sort };
}

function toInt(v: unknown): number | undefined {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) return undefined;
  return Number(v);
}

/** Prisma `orderBy` for the pageable's sort, after any fixed leading order. */
export function orderBy(pageable: Pageable, leading: Array<Record<string, 'asc' | 'desc'>> = []) {
  return [...leading, ...pageable.sort.map((s) => ({ [s.field]: s.direction }))];
}

export function skipTake(pageable: Pageable) {
  return { skip: pageable.page * pageable.size, take: pageable.size };
}

export interface PageJson<T> {
  content: T[];
  pageable: {
    pageNumber: number;
    pageSize: number;
    sort: SortJson;
    offset: number;
    paged: true;
    unpaged: false;
  };
  last: boolean;
  totalElements: number;
  totalPages: number;
  size: number;
  number: number;
  sort: SortJson;
  first: boolean;
  numberOfElements: number;
  empty: boolean;
}

interface SortJson {
  empty: boolean;
  sorted: boolean;
  unsorted: boolean;
}

export function toPage<T>(content: T[], total: number, pageable: Pageable): PageJson<T> {
  const sorted = pageable.sort.length > 0;
  const sort: SortJson = { empty: !sorted, sorted, unsorted: !sorted };
  const totalPages = Math.ceil(total / pageable.size);
  return {
    content,
    pageable: {
      pageNumber: pageable.page,
      pageSize: pageable.size,
      sort,
      offset: pageable.page * pageable.size,
      paged: true,
      unpaged: false,
    },
    last: pageable.page + 1 >= totalPages,
    totalElements: total,
    totalPages,
    size: pageable.size,
    number: pageable.page,
    sort,
    first: pageable.page === 0,
    numberOfElements: content.length,
    empty: content.length === 0,
  };
}
