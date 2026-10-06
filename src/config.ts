import { z } from 'zod';

/**
 * Runtime configuration, read from environment variables (a local `.env` is
 * loaded by src/server.ts). Variable names and defaults are the Java server's,
 * so one `.env` serves both during the switch-over.
 */
const bool = (def: boolean) =>
  z
    .enum(['true', 'false'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true');

const int = (def: number) => z.coerce.number().int().default(def);

/** Spring-style sizes: "10MB", "512KB", or plain bytes. */
const dataSize = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v, ctx) => {
      const m = /^\s*(\d+)\s*(B|KB|MB|GB)?\s*$/i.exec(v);
      if (!m) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid size '${v}'` });
        return z.NEVER;
      }
      const unit = (m[2] ?? 'B').toUpperCase();
      const factor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit]!;
      return Number(m[1]) * factor;
    });

/** Non-negative money amount, normalised to two decimals ("5.99"). */
const amount = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v, ctx) => {
      const t = v.trim();
      if (!/^\d+(\.\d{1,2})?$/.test(t)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid amount '${v}'` });
        return z.NEVER;
      }
      return Number(t).toFixed(2);
    });

/** Percentage 0–100 with up to two decimals, as a string ("8.25"). */
const percent = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v, ctx) => {
      const t = v.trim();
      if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) > 100) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid percentage '${v}'` });
        return z.NEVER;
      }
      return Number(t).toFixed(2);
    });

/** Business-day range "3-5" (or a single "2"), min ≤ max. */
const dayRange = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v, ctx) => {
      const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(v);
      const minDays = m ? Number(m[1]) : NaN;
      const maxDays = m ? Number(m[2] ?? m[1]) : NaN;
      if (!m || minDays > maxDays) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid day range '${v}' (expected e.g. 3-5)` });
        return z.NEVER;
      }
      return { minDays, maxDays };
    });

const EnvSchema = z.object({
  SERVER_PORT: int(8080),
  // A full DATABASE_URL wins; otherwise it is assembled from the DB_* parts.
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: int(5432),
  DB_NAME: z.string().default('nexus_commerce'),
  DB_USERNAME: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),

  // REQUIRED, no default: booting with a publicly known signing key would let
  // anyone mint valid tokens.
  JWT_SECRET: z
    .string({ required_error: 'JWT_SECRET is required' })
    .refine((s) => Buffer.byteLength(s, 'utf8') >= 32, 'JWT_SECRET must be at least 32 bytes (256 bits)'),
  JWT_EXPIRATION_MS: int(86_400_000),

  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  // 'framework' or 'native' (Spring's values) trust X-Forwarded-For from a
  // reverse proxy; 'none' uses the socket address.
  SERVER_FORWARD_HEADERS_STRATEGY: z.enum(['none', 'framework', 'native']).default('none'),

  USER_ADDRESS_MAX_PER_USER: int(5),

  ORDER_CURRENCY: z.string().length(3).default('USD'),
  ORDER_PENDING_EXPIRY_MINUTES: int(30),
  ORDER_EXPIRY_CHECK_INTERVAL_MS: int(60_000),

  RATE_LIMIT_ENABLED: bool(true),
  RATE_LIMIT_AUTH_CAPACITY: int(10),
  RATE_LIMIT_AUTH_REFILL_PER_MINUTE: int(10),

  PAYMENT_PROVIDER: z.enum(['manual', 'stripe']).default('manual'),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_TIMEOUT_MS: int(20_000),
  STRIPE_WEBHOOK_INFLIGHT_LEASE_SECONDS: int(300),

  CATALOG_IMPORT_MAX_FILE_SIZE: dataSize('10MB'),
  CATALOG_IMPORT_MAX_ROWS: int(5000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ── Storefront and operations ──
  STORE_NAME: z.string().default('Ecommerce Collections'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  PRICES_INCLUDE_TAX: bool(false),
  DEFAULT_TAX_RATE: percent('0'),
  LOW_STOCK_THRESHOLD: int(5),
  SHIPPING_STANDARD_FEE: amount('5.99'),
  SHIPPING_STANDARD_DAYS: dayRange('3-5'),
  SHIPPING_EXPRESS_FEE: amount('9.99'),
  SHIPPING_EXPRESS_DAYS: dayRange('1-2'),
  SHIPPING_FREE_THRESHOLD: amount('35.00'),
  // Only the manual provider exists; the name keeps room for a real carrier.
  SHIPPING_PROVIDER: z.enum(['manual']).default('manual'),
  RETURN_WINDOW_DAYS: int(30),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),
  MAIL_PROVIDER: z.enum(['log']).default('log'),
  IMAGE_CHECKS_ENABLED: bool(true),
  IMAGE_CHECK_TIMEOUT_MS: int(5000),
  PASSWORD_RESET_TTL_MINUTES: int(60),
});

/** A shipping method's price and delivery promise. */
export interface ShippingRate {
  /** Two-decimal string, e.g. "5.99": money stays exact (see src/order/pricing.ts). */
  fee: string;
  minDays: number;
  maxDays: number;
}

export interface Config {
  port: number;
  databaseUrl: string;
  jwt: { secret: string; expirationMs: number };
  cors: { allowedOrigins: string[] };
  trustProxy: boolean;
  address: { maxPerUser: number };
  order: { currency: string; pendingExpiryMinutes: number; expiryCheckIntervalMs: number };
  rateLimit: { enabled: boolean; capacity: number; refillPerMinute: number };
  payment: {
    provider: 'manual' | 'stripe';
    stripe: {
      secretKey: string;
      webhookSecret: string;
      /** Public key for Stripe Elements, exposed through GET /api/store/config. */
      publishableKey: string;
      timeoutMs: number;
      inflightLeaseSeconds: number;
    };
  };
  catalogImport: { maxFileSizeBytes: number; maxRows: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  store: { name: string; appBaseUrl: string };
  pricing: {
    pricesIncludeTax: boolean;
    /** Percent as a two-decimal string; applies when a SKU has no tax rate. */
    defaultTaxRate: string;
  };
  inventory: { lowStockThreshold: number };
  shipping: {
    provider: 'manual';
    standard: ShippingRate;
    express: ShippingRate;
    /** Standard shipping is free at/above this subtotal; null = never free. */
    freeThreshold: string | null;
  };
  returns: { windowDays: number };
  mail: { provider: 'log' };
  imageChecks: { enabled: boolean; timeoutMs: number };
  passwordReset: { ttlMinutes: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings count as unset, like Spring's ${VAR:default} — except
  // SHIPPING_FREE_THRESHOLD, where empty (or "none") means "never free".
  const rawThreshold = env.SHIPPING_FREE_THRESHOLD;
  const freeShippingDisabled =
    rawThreshold !== undefined && ['', 'none'].includes(rawThreshold.trim().toLowerCase());
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]) => v !== undefined && v !== '' && !(k === 'SHIPPING_FREE_THRESHOLD' && freeShippingDisabled),
    ),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration — ${problems}`);
  }
  const e = parsed.data;

  const databaseUrl =
    e.DATABASE_URL ??
    `postgresql://${encodeURIComponent(e.DB_USERNAME)}:${encodeURIComponent(e.DB_PASSWORD)}` +
      `@${e.DB_HOST}:${e.DB_PORT}/${encodeURIComponent(e.DB_NAME)}`;

  return {
    port: e.SERVER_PORT,
    databaseUrl,
    jwt: { secret: e.JWT_SECRET, expirationMs: e.JWT_EXPIRATION_MS },
    cors: {
      allowedOrigins: e.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    },
    trustProxy: e.SERVER_FORWARD_HEADERS_STRATEGY !== 'none',
    address: { maxPerUser: e.USER_ADDRESS_MAX_PER_USER },
    order: {
      currency: e.ORDER_CURRENCY.toUpperCase(),
      pendingExpiryMinutes: e.ORDER_PENDING_EXPIRY_MINUTES,
      expiryCheckIntervalMs: e.ORDER_EXPIRY_CHECK_INTERVAL_MS,
    },
    rateLimit: {
      enabled: e.RATE_LIMIT_ENABLED,
      capacity: e.RATE_LIMIT_AUTH_CAPACITY,
      refillPerMinute: e.RATE_LIMIT_AUTH_REFILL_PER_MINUTE,
    },
    payment: {
      provider: e.PAYMENT_PROVIDER,
      stripe: {
        secretKey: e.STRIPE_SECRET_KEY,
        webhookSecret: e.STRIPE_WEBHOOK_SECRET,
        publishableKey: e.STRIPE_PUBLISHABLE_KEY,
        timeoutMs: e.STRIPE_TIMEOUT_MS,
        inflightLeaseSeconds: e.STRIPE_WEBHOOK_INFLIGHT_LEASE_SECONDS,
      },
    },
    catalogImport: {
      maxFileSizeBytes: e.CATALOG_IMPORT_MAX_FILE_SIZE,
      maxRows: e.CATALOG_IMPORT_MAX_ROWS,
    },
    logLevel: e.LOG_LEVEL,
    store: { name: e.STORE_NAME, appBaseUrl: e.APP_BASE_URL.replace(/\/+$/, '') },
    pricing: { pricesIncludeTax: e.PRICES_INCLUDE_TAX, defaultTaxRate: e.DEFAULT_TAX_RATE },
    inventory: { lowStockThreshold: e.LOW_STOCK_THRESHOLD },
    shipping: {
      provider: e.SHIPPING_PROVIDER,
      standard: { fee: e.SHIPPING_STANDARD_FEE, ...e.SHIPPING_STANDARD_DAYS },
      express: { fee: e.SHIPPING_EXPRESS_FEE, ...e.SHIPPING_EXPRESS_DAYS },
      freeThreshold: freeShippingDisabled ? null : e.SHIPPING_FREE_THRESHOLD,
    },
    returns: { windowDays: e.RETURN_WINDOW_DAYS },
    mail: { provider: e.MAIL_PROVIDER },
    imageChecks: { enabled: e.IMAGE_CHECKS_ENABLED, timeoutMs: e.IMAGE_CHECK_TIMEOUT_MS },
    passwordReset: { ttlMinutes: e.PASSWORD_RESET_TTL_MINUTES },
  };
}
