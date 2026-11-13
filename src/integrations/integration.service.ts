import { Prisma, type Integration, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { ValidationError } from '../common/validation';
import { PROVIDERS, PROVIDER_IDS, type ProviderSpec } from './providers';
import type { SecretBox } from './secret-box';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SECRETS = 30;

const secretsMap = (allowNull: boolean) =>
  z
    .record(z.string(), allowNull ? z.string().max(4096).nullable() : z.string().max(4096))
    .optional()
    .superRefine((m, ctx) => {
      for (const k of Object.keys(m ?? {})) {
        if (!SECRET_NAME.test(k)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${k}' must be UPPER_SNAKE_CASE (letters, digits, _)` });
        }
      }
    });

export const IntegrationCreateSchema = z.object({
  provider: z.string({ required_error: 'must not be null' }),
  name: z.string().trim().min(1, 'must not be blank').max(100),
  slug: z.string().trim().max(60).regex(SLUG, 'must be lowercase letters, digits and single hyphens').optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().trim().max(2048).optional().nullable(),
  settings: z.record(z.string(), z.unknown()).optional(),
  secrets: secretsMap(false),
  notes: z.string().max(2000).optional().nullable(),
});

export const IntegrationUpdateSchema = z.object({
  name: z.string().trim().min(1, 'must not be blank').max(100).optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().trim().max(2048).optional().nullable(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** A value replaces the secret, null removes it, an absent name keeps it. */
  secrets: secretsMap(true),
  notes: z.string().max(2000).optional().nullable(),
});

/** Credentials an adapter works with: secrets in clear, settings with defaults applied. */
export interface ResolvedIntegration {
  id: string;
  slug: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

type Tester = (i: ResolvedIntegration) => Promise<ConnectionResult>;

const hint = (v: string) => (v.length >= 12 ? `••••••${v.slice(-4)}` : '••••••');

function checkUrl(v: string | null | undefined, field = 'baseUrl') {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
  } catch {
    throw new ValidationError({ [field]: 'must be a valid http(s) URL' });
  }
  return v.replace(/\/+$/, '');
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'integration';

/** Keeps the provider's known settings, typed, with defaults filled in. */
function cleanSettings(spec: ProviderSpec, input: Record<string, unknown> | undefined, current: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const s of spec.settings) {
    const raw = input && s.key in input ? input[s.key] : current[s.key];
    if (raw === undefined || raw === null || raw === '') {
      if (s.default !== undefined) out[s.key] = s.default;
      continue;
    }
    if (s.type === 'boolean') {
      if (typeof raw !== 'boolean') errors[`settings.${s.key}`] = 'must be true or false';
      else out[s.key] = raw;
    } else if (typeof raw !== 'string') {
      errors[`settings.${s.key}`] = 'must be text';
    } else if (s.type === 'select' && !s.options!.some((o) => o.value === raw)) {
      errors[`settings.${s.key}`] = `must be one of ${s.options!.map((o) => o.value).join(', ')}`;
    } else {
      out[s.key] = raw.trim().slice(0, 500);
    }
  }
  const unknown = Object.keys(input ?? {}).filter((k) => !spec.settings.some((s) => s.key === k));
  if (unknown.length) errors.settings = `unknown settings: ${unknown.join(', ')}`;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/** Admin › Settings › API integrations: vendor connections with sealed secrets. */
export class IntegrationService {
  private readonly testers = new Map<string, Tester>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly box: SecretBox,
    private readonly timeoutMs: number,
  ) {}

  /** A built-in adapter's connection test (CUSTOM uses the generic one). */
  registerTester(provider: string, tester: Tester) {
    this.testers.set(provider, tester);
  }

  providers() {
    return PROVIDER_IDS.map((id) => PROVIDERS[id]);
  }

  private spec(provider: string) {
    const spec = PROVIDERS[provider];
    if (!spec) throw new ValidationError({ provider: `must be one of ${PROVIDER_IDS.join(', ')}` });
    return spec;
  }

  private secretsOf(row: Integration): Record<string, string> {
    try {
      return this.box.open(row.secrets);
    } catch {
      throw new DomainError(
        409,
        `The secrets of '${row.name}' can't be read: INTEGRATIONS_ENCRYPTION_KEY (or JWT_SECRET) changed. Enter them again.`,
      );
    }
  }

  private view(row: Integration) {
    const spec = PROVIDERS[row.provider];
    let secrets: Array<{ name: string; hint: string }> = [];
    let secretsReadable = true;
    try {
      secrets = Object.entries(this.box.open(row.secrets)).map(([name, v]) => ({ name, hint: hint(v) }));
    } catch {
      secretsReadable = false;
    }
    const missing = (spec?.secrets ?? []).filter((s) => s.required && !secrets.some((x) => x.name === s.name)).map((s) => s.name);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      provider: row.provider,
      providerLabel: spec?.label ?? row.provider,
      enabled: row.enabled,
      baseUrl: row.baseUrl,
      settings: row.settings as Record<string, unknown>,
      secrets: secrets.sort((a, b) => a.name.localeCompare(b.name)),
      secretsReadable,
      missingSecrets: missing,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
    };
  }

  private async find(slug: string) {
    const row = await this.prisma.integration.findUnique({ where: { slug } });
    if (!row) throw new DomainError(404, `Integration '${slug}' was not found`);
    return row;
  }

  async list() {
    const rows = await this.prisma.integration.findMany({ orderBy: [{ provider: 'asc' }, { name: 'asc' }] });
    return rows.map((r) => this.view(r));
  }

  /** Sidebar tabs: enabled integrations, no secrets (catalog staff see these too). */
  async nav() {
    const rows = await this.prisma.integration.findMany({
      where: { enabled: true },
      orderBy: { name: 'asc' },
      select: { slug: true, name: true, provider: true },
    });
    return rows.map((r) => ({ ...r, providerLabel: PROVIDERS[r.provider]?.label ?? r.provider }));
  }

  async get(slug: string) {
    return this.view(await this.find(slug));
  }

  async create(input: z.output<typeof IntegrationCreateSchema>, actor: string) {
    const spec = this.spec(input.provider);
    if (spec.single && (await this.prisma.integration.count({ where: { provider: spec.id } }))) {
      throw new DomainError(409, `A ${spec.label} integration already exists; edit it instead`);
    }
    const secrets = this.checkSecrets(spec, (input.secrets ?? {}) as Record<string, string>);
    const baseUrl = checkUrl(input.baseUrl ?? spec.defaultBaseUrl);
    if (spec.baseUrlRequired && !baseUrl) throw new ValidationError({ baseUrl: 'must not be blank' });
    const slug = input.slug ?? (spec.single ? spec.id.toLowerCase() : slugify(input.name));
    if (await this.prisma.integration.findUnique({ where: { slug } })) {
      throw new ValidationError({ slug: `'${slug}' is already used by another integration` });
    }
    const row = await this.prisma.integration.create({
      data: {
        slug,
        name: input.name,
        provider: spec.id,
        enabled: input.enabled ?? true,
        baseUrl,
        settings: cleanSettings(spec, input.settings) as Prisma.InputJsonValue,
        secrets: Object.keys(secrets).length ? this.box.seal(secrets) : null,
        notes: input.notes?.trim() || null,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    return this.view(row);
  }

  async update(slug: string, input: z.output<typeof IntegrationUpdateSchema>, actor: string) {
    const row = await this.find(slug);
    const spec = this.spec(row.provider);
    let sealed: string | null | undefined;
    if (input.secrets && Object.keys(input.secrets).length) {
      // Unreadable old secrets (key changed) are dropped: the admin is re-entering them.
      let current: Record<string, string> = {};
      try {
        current = this.box.open(row.secrets);
      } catch {
        current = {};
      }
      for (const [k, v] of Object.entries(input.secrets)) {
        if (v === null || v === '') delete current[k];
        else current[k] = v;
      }
      const checked = this.checkSecrets(spec, current);
      sealed = Object.keys(checked).length ? this.box.seal(checked) : null;
    }
    let baseUrl: string | null | undefined;
    if (input.baseUrl !== undefined) {
      baseUrl = checkUrl(input.baseUrl);
      if (spec.baseUrlRequired && !baseUrl) throw new ValidationError({ baseUrl: 'must not be blank' });
    }
    const updated = await this.prisma.integration.update({
      where: { id: row.id },
      data: {
        name: input.name,
        enabled: input.enabled,
        baseUrl,
        settings:
          input.settings === undefined
            ? undefined
            : (cleanSettings(spec, input.settings, row.settings as Record<string, unknown>) as Prisma.InputJsonValue),
        secrets: sealed,
        notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
        updatedBy: actor,
      },
    });
    return this.view(updated);
  }

  async remove(slug: string) {
    const row = await this.find(slug);
    await this.prisma.integration.delete({ where: { id: row.id } });
    return { slug };
  }

  private checkSecrets(spec: ProviderSpec, secrets: Record<string, string>) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets)) {
      const t = v.trim();
      if (!t) continue;
      if (!spec.freeformSecrets && !spec.secrets.some((s) => s.name === k)) {
        throw new ValidationError({ secrets: `${spec.label} takes only ${spec.secrets.map((s) => s.name).join(', ')}` });
      }
      out[k] = t;
    }
    if (Object.keys(out).length > MAX_SECRETS) throw new ValidationError({ secrets: `at most ${MAX_SECRETS} secrets` });
    return out;
  }

  private resolveRow(row: Integration): ResolvedIntegration {
    const spec = this.spec(row.provider);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      provider: row.provider,
      baseUrl: row.baseUrl,
      settings: cleanSettings(spec, {}, row.settings as Record<string, unknown>),
      secrets: this.secretsOf(row),
    };
  }

  /** For adapters: the enabled integration of a provider, secrets in clear; null when absent. */
  async resolve(provider: string): Promise<ResolvedIntegration | null> {
    const row = await this.prisma.integration.findFirst({ where: { provider, enabled: true }, orderBy: { createdAt: 'asc' } });
    return row ? this.resolveRow(row) : null;
  }

  async test(slug: string): Promise<ConnectionResult> {
    const resolved = this.resolveRow(await this.find(slug));
    const tester = this.testers.get(resolved.provider);
    try {
      return tester ? await tester(resolved) : await this.genericTest(resolved);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  /** CUSTOM: GET base URL + test path, with the configured credential. */
  private async genericTest(i: ResolvedIntegration): Promise<ConnectionResult> {
    if (!i.baseUrl) return { ok: false, message: 'Set a base URL to test the connection' };
    const s = i.settings as { authType?: string; authSecret?: string; authName?: string; testPath?: string };
    const url = new URL(`${i.baseUrl}${s.testPath ? (s.testPath.startsWith('/') ? s.testPath : `/${s.testPath}`) : ''}`);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const secret = s.authSecret ? i.secrets[s.authSecret] : undefined;
    const auth = s.authType ?? 'none';
    if (auth !== 'none' && auth !== 'basic' && !secret) {
      return { ok: false, message: `Secret '${s.authSecret ?? ''}' is not set` };
    }
    if (auth === 'bearer') headers.Authorization = `Bearer ${secret}`;
    if (auth === 'header') {
      if (!s.authName) return { ok: false, message: 'Set the header name' };
      headers[s.authName] = secret!;
    }
    if (auth === 'query') {
      if (!s.authName) return { ok: false, message: 'Set the query parameter name' };
      url.searchParams.set(s.authName, secret!);
    }
    if (auth === 'basic') {
      const user = i.secrets.USERNAME ?? '';
      const pass = i.secrets.PASSWORD ?? '';
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return { ok: false, message: timedOut ? 'The API did not answer in time' : `Could not reach ${url.host}` };
    }
    const ms = Date.now() - started;
    return {
      ok: res.ok,
      message: res.ok ? `Connected: HTTP ${res.status} in ${ms} ms` : `The API answered HTTP ${res.status} ${res.statusText}`.trim(),
      detail: { status: res.status, ms, url: `${url.origin}${url.pathname}` },
    };
  }
}
