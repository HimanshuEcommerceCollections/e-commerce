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
});

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
    stripe: { secretKey: string; webhookSecret: string; timeoutMs: number; inflightLeaseSeconds: number };
  };
  catalogImport: { maxFileSizeBytes: number; maxRows: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings count as unset, like Spring's ${VAR:default}.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
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
        timeoutMs: e.STRIPE_TIMEOUT_MS,
        inflightLeaseSeconds: e.STRIPE_WEBHOOK_INFLIGHT_LEASE_SECONDS,
      },
    },
    catalogImport: {
      maxFileSizeBytes: e.CATALOG_IMPORT_MAX_FILE_SIZE,
      maxRows: e.CATALOG_IMPORT_MAX_ROWS,
    },
    logLevel: e.LOG_LEVEL,
  };
}
