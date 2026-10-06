import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../common/logger';

const log = logger('image-check');

/** Outcome of one URL check: `error` is null when the URL serves an image. */
export interface UrlCheck {
  ok: boolean;
  error: string | null;
}

export type UrlChecker = (url: string) => Promise<UrlCheck>;

/** Methods servers commonly refuse for HEAD while serving GET fine. */
const RETRY_WITH_GET = (status: number) => status >= 400;

/**
 * Checks an image URL over HTTP (FR-IM-08): HEAD first, GET when HEAD is
 * refused or fails (some CDNs answer HEAD with 403/405). Only the headers of a
 * GET are read; the body is cancelled. A response is broken when its status is
 * not 2xx (after redirects) or its Content-Type is not an image.
 */
export function httpUrlChecker(timeoutMs: number): UrlChecker {
  const attempt = async (url: string, method: 'HEAD' | 'GET'): Promise<UrlCheck & { status?: number }> => {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'image/*,*/*;q=0.5' },
    });
    if (method === 'GET') await res.body?.cancel().catch(() => undefined);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const type = res.headers.get('content-type');
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) {
      return { ok: false, error: `Not an image (Content-Type ${type.split(';')[0]})`, status: res.status };
    }
    return { ok: true, error: null, status: res.status };
  };

  return async (url) => {
    try {
      const head = await attempt(url, 'HEAD');
      if (head.ok || !RETRY_WITH_GET(head.status ?? 0)) return { ok: head.ok, error: head.error };
      const get = await attempt(url, 'GET');
      return { ok: get.ok, error: get.error };
    } catch (e) {
      return { ok: false, error: describe(e, timeoutMs) };
    }
  };
}

function describe(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `Timed out after ${timeoutMs} ms`;
  const cause = err?.cause?.code ?? err?.cause?.message;
  return (cause ? `Request failed (${cause})` : `Request failed (${err?.message ?? String(e)})`).slice(0, 500);
}

/**
 * Checks many URLs with bounded concurrency. URLs not started before
 * `deadline` (epoch ms) are left out of the result.
 */
export async function checkUrls(
  urls: string[],
  checker: UrlChecker,
  options: { concurrency?: number; deadline?: number } = {},
): Promise<Map<string, UrlCheck>> {
  const results = new Map<string, UrlCheck>();
  const queue = [...new Set(urls)];
  const deadline = options.deadline ?? Infinity;
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (Date.now() >= deadline) return;
      results.set(url, await checker(url));
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 16, queue.length) }, worker));
  return results;
}

/**
 * Stores URL check results on product_images (check_status, check_error,
 * checked_at). Checks are on when IMAGE_CHECKS_ENABLED; off, images stay
 * unchecked (check_status null).
 */
export class ImageCheckService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: { enabled: boolean; timeoutMs: number },
    private readonly checker: UrlChecker = httpUrlChecker(settings.timeoutMs),
  ) {}

  get enabled() {
    return this.settings.enabled;
  }

  /** Checks URLs without storing anything (parent-level images, which have no status columns). */
  check(urls: string[], deadline?: number) {
    return checkUrls(urls, this.checker, { deadline });
  }

  /**
   * Checks the never-checked images of these SKUs until `deadline`, stores
   * the results, and returns them by URL. Images left unchecked at the
   * deadline are checked in the background.
   */
  async checkProducts(productIds: string[], deadline = Infinity): Promise<Map<string, UrlCheck>> {
    if (!this.enabled || productIds.length === 0) return new Map();
    const where = { productId: { in: productIds }, deleted: false, checkStatus: null } satisfies Prisma.ProductImageWhereInput;
    const images = await this.prisma.productImage.findMany({ where, select: { url: true } });
    const results = await this.check(images.map((i) => i.url), deadline);
    await this.store(results, where);
    if (results.size < new Set(images.map((i) => i.url)).size) {
      void this.checkProducts(productIds).catch((e) => log.warn(`Background image checks failed: ${String(e)}`));
    }
    return results;
  }

  /** Re-checks broken and unchecked images (`problems`) or every image (`all`), optionally only those matching `filter`. */
  async recheck(scope: 'problems' | 'all', filter: Prisma.ProductImageWhereInput = {}) {
    if (!this.enabled) return { checked: 0, broken: 0, enabled: false };
    const where: Prisma.ProductImageWhereInput = {
      ...filter,
      deleted: false,
      product: { deleted: false },
      ...(scope === 'problems' ? { OR: [{ checkStatus: null }, { checkStatus: { in: ['BROKEN', 'UNCHECKED'] } }] } : {}),
    };
    const images = await this.prisma.productImage.findMany({ where, select: { id: true, url: true } });
    const results = await this.check(images.map((i) => i.url));
    await this.store(results, { id: { in: images.map((i) => i.id) } });
    return {
      checked: images.filter((i) => results.has(i.url)).length,
      broken: images.filter((i) => results.get(i.url)?.ok === false).length,
      enabled: true,
    };
  }

  /** One UPDATE per distinct outcome, limited to `scope`. */
  private async store(results: Map<string, UrlCheck>, scope: Prisma.ProductImageWhereInput) {
    const byOutcome = new Map<string, string[]>();
    for (const [url, r] of results) {
      const key = r.ok ? '' : (r.error ?? 'Unreachable');
      byOutcome.set(key, [...(byOutcome.get(key) ?? []), url]);
    }
    const checkedAt = new Date();
    for (const [error, urls] of byOutcome) {
      for (let i = 0; i < urls.length; i += 500) {
        await this.prisma.productImage.updateMany({
          where: { AND: [scope, { url: { in: urls.slice(i, i + 500) } }] },
          data: error ? { checkStatus: 'BROKEN', checkError: error.slice(0, 500), checkedAt } : { checkStatus: 'OK', checkError: null, checkedAt },
        });
      }
    }
  }
}
