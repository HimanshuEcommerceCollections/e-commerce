import { del, put } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { DomainError } from '../common/errors';

/**
 * Where uploaded product images live. Every provider stores an object under a
 * provider-neutral key (`products/2026/11/<uuid>-1200x900.jpg`) and serves it
 * at `<public base>/<key>`, so moving providers (Vercel Blob → Cloudflare R2)
 * is: copy the objects keeping their keys, switch the config, and rewrite
 * product_images.url from storage_key (`url = <new base>/<storage_key>`).
 */
export interface ObjectStorage {
  /** 'none' when uploads are switched off. */
  readonly provider: string;
  /** Stores `body` under `key` and returns its public URL. */
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  /** Removes objects; keys that don't exist are ignored. */
  delete(keys: string[]): Promise<void>;
  /** The key behind one of this store's public URLs, or null for any other URL. */
  keyOf(url: string): string | null;
  /** The public URL an object stored under `key` has (or will have). */
  urlFor(key: string): string;
  /** An object's bytes, or null when there is none under `key`. */
  get(key: string): Promise<Buffer | null>;
  /**
   * Lets a browser upload one object straight to the store, past the API's
   * request size limit. Absent when the provider can't.
   */
  directUpload?(key: string, contentType: string, maxBytes: number): Promise<DirectUploadTarget>;
}

/** What a browser needs to upload one file straight to the store. */
export interface DirectUploadTarget {
  /** How the browser uploads: with @vercel/blob/client's put() and this token. */
  method: 'vercel-blob';
  pathname: string;
  clientToken: string;
}

/** A direct-upload token is good for this long. */
const DIRECT_UPLOAD_TTL_MS = 15 * 60 * 1000;

export interface StorageSettings {
  provider: 'none' | 'vercel-blob';
  blobToken: string;
  /** Custom domain in front of the store (e.g. https://images.example.com); empty = the provider's own URL. */
  publicBaseUrl: string;
}

/** Immutable keys (each upload gets a new UUID), so browsers and CDNs may cache for a year. */
const CACHE_SECONDS = 365 * 24 * 60 * 60;

/** Vercel Blob public store: https://<store-id>.public.blob.vercel-storage.com/<key>. */
export class VercelBlobStorage implements ObjectStorage {
  readonly provider = 'vercel-blob';

  constructor(
    private readonly token: string,
    private readonly publicBaseUrl = '',
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    const blob = await put(key, body, {
      access: 'public',
      contentType,
      token: this.token,
      // The key is the pathname as given: R2 can later serve the same paths.
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: CACHE_SECONDS,
    });
    return this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : blob.url;
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await del(keys, { token: this.token });
  }

  /** The store id is the token's fourth part (vercel_blob_rw_<storeId>_<secret>); its URL host is that, lowercased. */
  urlFor(key: string): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/${key}`;
    const storeId = this.token.split('_')[3]?.toLowerCase();
    if (!storeId) throw new Error('BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token');
    return `https://${storeId}.public.blob.vercel-storage.com/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async get(key: string): Promise<Buffer | null> {
    // A query string skips any CDN copy of an earlier answer for this path.
    const res = await fetch(`${this.urlFor(key)}?check=${Date.now()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Reading ${key} from Vercel Blob failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async directUpload(key: string, contentType: string, maxBytes: number): Promise<DirectUploadTarget> {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: this.token,
      pathname: key,
      allowedContentTypes: [contentType],
      maximumSizeInBytes: maxBytes,
      validUntil: Date.now() + DIRECT_UPLOAD_TTL_MS,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: CACHE_SECONDS,
    });
    return { method: 'vercel-blob', pathname: key, clientToken };
  }

  keyOf(url: string): string | null {
    const u = parseUrl(url);
    if (!u) return null;
    if (this.publicBaseUrl) {
      const key = keyUnder(url, this.publicBaseUrl);
      if (key) return key;
    }
    return u.hostname.endsWith('.public.blob.vercel-storage.com') ? decodeURIComponent(u.pathname.slice(1)) || null : null;
  }
}

/** Uploads switched off: links still work, files are refused. */
export class DisabledStorage implements ObjectStorage {
  readonly provider = 'none';

  put(): Promise<string> {
    return Promise.reject(uploadsNotConfigured());
  }

  async delete(): Promise<void> {}

  keyOf(): string | null {
    return null;
  }

  urlFor(): string {
    throw uploadsNotConfigured();
  }

  async get(): Promise<Buffer | null> {
    return null;
  }
}

export const uploadsNotConfigured = () =>
  new DomainError(503, 'Image uploads are not configured on this server; paste image links instead');

export function createObjectStorage(settings: StorageSettings): ObjectStorage {
  switch (settings.provider) {
    case 'vercel-blob':
      return new VercelBlobStorage(settings.blobToken, settings.publicBaseUrl);
    default:
      return new DisabledStorage();
  }
}

function parseUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** The path after `base/`, or null when `url` is not under `base`. */
export function keyUnder(url: string, base: string): string | null {
  const prefix = `${base.replace(/\/+$/, '')}/`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length).split(/[?#]/)[0]!;
  return key ? decodeURIComponent(key) : null;
}
