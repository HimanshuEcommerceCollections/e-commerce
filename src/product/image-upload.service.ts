import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { imageSize } from 'image-size';
import { OPEN_SUBMISSION_STATUSES } from '../common/enums';
import { DomainError } from '../common/errors';
import { uploadsNotConfigured, type ObjectStorage } from '../storage/object-storage';

/** Formats we store, by image-size's type name. SVG is left out on purpose: it can carry scripts. */
const FORMATS: Record<string, { ext: string; contentType: string }> = {
  jpg: { ext: 'jpg', contentType: 'image/jpeg' },
  png: { ext: 'png', contentType: 'image/png' },
  webp: { ext: 'webp', contentType: 'image/webp' },
  gif: { ext: 'gif', contentType: 'image/gif' },
};
const CONTENT_TYPES = Object.fromEntries(Object.values(FORMATS).map((f) => [f.ext, f.contentType]));

/** `…/<uuid>-<width>x<height>.<ext>`: the size travels with the URL into imports and forms. */
const KEY_PATTERN = /-(\d{1,5})x(\d{1,5})\.([a-z]+)$/;

/** A stored image, in the shape product image rows take. */
export interface StoredImage {
  url: string;
  storageKey: string;
  width: number;
  height: number;
  contentType: string;
  fileSizeBytes: number;
}

/** Metadata for an image URL in our own storage; null for any other URL. */
export type DescribeImage = (url: string) => ImageMeta | null;

/** What a product_images row can learn from a URL alone. */
export interface ImageMeta {
  storageKey: string;
  width: number | null;
  height: number | null;
  contentType: string | null;
}

export interface ImageUploadSettings {
  /** Largest file accepted in an upload request. */
  maxFileSizeBytes: number;
  /** Largest file copied from a link. */
  fetchMaxFileSizeBytes: number;
  fetchTimeoutMs: number;
  /** Days an unreferenced upload is kept before the cleanup job removes it. */
  orphanGraceDays: number;
}

/**
 * Product image files: checks an upload is a real JPG/PNG/WebP/GIF, reads its
 * size, and stores it in object storage so the product page no longer depends
 * on the seller's own hosting. Links can be copied in the same way.
 */
export class ImageUploadService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
    private readonly settings: ImageUploadSettings,
  ) {}

  get enabled() {
    return this.storage.provider !== 'none';
  }

  get provider() {
    return this.storage.provider;
  }

  /** Validates and stores one image file, and records the upload. */
  async store(body: Buffer, uploadedBy: string | null = null): Promise<StoredImage> {
    if (!body.length) throw new DomainError(400, 'The image file is empty');
    if (body.length > this.settings.maxFileSizeBytes) throw tooLarge(this.settings.maxFileSizeBytes);
    const { width, height, format } = inspect(body);
    const now = new Date();
    const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const storageKey = `products/${month}/${randomUUID()}-${width}x${height}.${format.ext}`;
    const url = await this.storage.put(storageKey, body, format.contentType);
    const image = { url, storageKey, width, height, contentType: format.contentType, fileSizeBytes: body.length };
    try {
      await this.prisma.imageUpload.create({ data: { ...image, fileSizeBytes: BigInt(body.length), uploadedBy } });
    } catch (e) {
      // Unrecorded, the file could never be cleaned up: take it back out.
      await this.storage.delete([storageKey]).catch(() => undefined);
      throw e;
    }
    return image;
  }

  /**
   * Downloads the image at `url` and stores a copy, so a seller's link going
   * away no longer breaks the product page. A URL that is already ours is
   * returned as it is.
   */
  async storeFromUrl(url: string, uploadedBy: string | null = null): Promise<StoredImage | (ImageMeta & { url: string; fileSizeBytes: number | null })> {
    const own = this.describe(url);
    if (own) {
      const row = await this.prisma.imageUpload.findUnique({ where: { storageKey: own.storageKey } });
      return row
        ? { url, storageKey: row.storageKey, width: row.width, height: row.height, contentType: row.contentType, fileSizeBytes: Number(row.fileSizeBytes) }
        : { url, ...own, fileSizeBytes: null };
    }
    if (!this.enabled) throw uploadsNotConfigured();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DomainError(400, 'Enter a full image link starting with https://');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new DomainError(400, 'Enter a full image link starting with https://');
    }
    return this.store(await this.download(parsed), uploadedBy);
  }

  /**
   * Copies file size (and any missing size or type) from the upload records
   * onto these SKUs' image rows. Run after writing image rows, in the same
   * transaction: imports and forms only carry the URL.
   */
  async fillFromUploads(db: Prisma.TransactionClient | PrismaClient, productIds: string[]): Promise<void> {
    if (!productIds.length) return;
    await db.$executeRaw`
      UPDATE product_images pi
         SET file_size_bytes = iu.file_size_bytes,
             width = COALESCE(pi.width, iu.width),
             height = COALESCE(pi.height, iu.height),
             content_type = COALESCE(pi.content_type, iu.content_type)
        FROM image_uploads iu
       WHERE pi.storage_key = iu.storage_key
         AND pi.product_id = ANY(${productIds}::uuid[])
         AND pi.file_size_bytes IS DISTINCT FROM iu.file_size_bytes`;
  }

  /**
   * Removes uploaded files nothing refers to any more: no image row (live or
   * soft-deleted), no order line (orders keep their thumbnail), no parent
   * product image field, and no submission that is open or was decided within
   * the grace period. Only files older than the grace period are considered,
   * so an upload on a form that isn't saved yet is left alone. `dryRun` lists
   * what would go without removing anything.
   */
  async cleanup(options: { dryRun?: boolean; limit?: number } = {}): Promise<{ removed: number; storageKeys: string[]; dryRun: boolean }> {
    const dryRun = options.dryRun ?? false;
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
    const cutoff = new Date(Date.now() - this.settings.orphanGraceDays * 24 * 60 * 60 * 1000);
    const open = [...OPEN_SUBMISSION_STATUSES];
    // One NOT EXISTS per column, so each becomes a hash anti-join (no OR across columns).
    const orphans = await this.prisma.$queryRaw<{ id: string; storage_key: string }[]>`
      SELECT iu.id, iu.storage_key
        FROM image_uploads iu
       WHERE iu.deleted_at IS NULL
         AND iu.created_at < ${cutoff}
         AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.storage_key = iu.storage_key)
         AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.url = iu.url)
         AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.image_url = iu.url)
         AND NOT EXISTS (SELECT 1 FROM parent_products pp WHERE pp.lifestyle_image_url = iu.url)
         AND NOT EXISTS (SELECT 1 FROM parent_products pp WHERE pp.size_chart_url = iu.url)
         AND NOT EXISTS (SELECT 1 FROM parent_products pp WHERE pp.infographic_url = iu.url)
         AND NOT EXISTS (
               SELECT 1 FROM product_submissions ps
                WHERE (ps.status = ANY(${open}::varchar[]) OR ps.updated_at >= ${cutoff})
                  AND strpos(ps.payload::text, iu.storage_key) > 0)
       ORDER BY iu.created_at
       LIMIT ${limit}`;
    const storageKeys = orphans.map((o) => o.storage_key);
    if (dryRun || !orphans.length) return { removed: 0, storageKeys, dryRun };
    for (let i = 0; i < orphans.length; i += 100) {
      const batch = orphans.slice(i, i + 100);
      await this.storage.delete(batch.map((o) => o.storage_key));
      await this.prisma.imageUpload.updateMany({ where: { id: { in: batch.map((o) => o.id) } }, data: { deletedAt: new Date() } });
    }
    return { removed: orphans.length, storageKeys, dryRun };
  }

  /** Storage key, and size and type when the key carries them, for one of our URLs; null for any other URL. */
  describe(url: string): ImageMeta | null {
    const storageKey = this.storage.keyOf(url);
    if (!storageKey) return null;
    const m = KEY_PATTERN.exec(storageKey);
    return {
      storageKey,
      width: m ? Number(m[1]) : null,
      height: m ? Number(m[2]) : null,
      contentType: m ? (CONTENT_TYPES[m[3]!] ?? null) : null,
    };
  }

  private async download(url: URL): Promise<Buffer> {
    const max = this.settings.fetchMaxFileSizeBytes;
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(this.settings.fetchTimeoutMs),
        headers: { Accept: 'image/*' },
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      throw new DomainError(
        400,
        name === 'TimeoutError' || name === 'AbortError'
          ? `Couldn't download the image: no answer within ${this.settings.fetchTimeoutMs} ms`
          : "Couldn't download the image: the link can't be reached",
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new DomainError(400, `Couldn't download the image: HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length') ?? 0) > max) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge(max);
    }
    // Read with a cap: Content-Length can be missing or wrong.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new DomainError(400, "Couldn't download the image: empty response");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(max);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}

/** Format and displayed size (EXIF rotation applied) of a supported image; throws for anything else. */
function inspect(body: Buffer) {
  let result: ReturnType<typeof imageSize>;
  try {
    result = imageSize(body);
  } catch {
    throw unsupported();
  }
  const format = FORMATS[result.type ?? ''];
  if (!format || !result.width || !result.height) throw unsupported();
  // EXIF orientations 5–8 are rotated a quarter turn: width and height swap on screen.
  const turned = (result.orientation ?? 1) >= 5;
  return { format, width: turned ? result.height : result.width, height: turned ? result.width : result.height };
}

const unsupported = () => new DomainError(415, 'Upload a JPG, PNG, WebP or GIF image');

const tooLarge = (max: number) => new DomainError(413, `The image is larger than ${Math.round(max / 1024 / 1024)} MB`);

/** What catalog writers need: metadata from our URLs, and file sizes from the upload records. */
export type StoredImages = Pick<ImageUploadService, 'describe' | 'fillFromUploads'>;

/** For services built without storage (tests, scripts): no URL is ours. */
export const NO_STORED_IMAGES: StoredImages = { describe: () => null, fillFromUploads: async () => undefined };
