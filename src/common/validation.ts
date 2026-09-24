import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from './errors';

/**
 * Request-body validation with zod. Field messages reproduce the Jakarta Bean
 * Validation defaults the Java DTOs used ("must not be blank", "size must be
 * between 0 and 255", …) and the 400 body is the same:
 * `{ success: false, message: "Validation failed", data: { field: message } }`.
 */
export class ValidationError extends DomainError {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(400, 'Validation failed');
  }
}

export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.reduce<string>(
      (acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : String(part)),
      '',
    );
    // One message per field; the first wins (as the Java handler's merge did).
    fieldErrors[key || 'body'] ??= issue.message;
  }
  throw new ValidationError(fieldErrors);
}

type Fail = (message: string) => void;

/** A field whose checks run in order and report their own messages. */
function field<T>(check: (value: unknown, fail: Fail) => T) {
  return z.unknown().transform((value, ctx): T => {
    let failed = false;
    const result = check(value, (message) => {
      failed = true;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    });
    return failed ? (z.NEVER as T) : result;
  });
}

const absent = (v: unknown): v is null | undefined => v === null || v === undefined;

interface StringRules {
  max?: number;
  min?: number;
  sizeMessage?: string;
  pattern?: RegExp;
  patternMessage?: string;
  email?: boolean;
  emailMessage?: string;
}

function checkString(value: string, rules: StringRules, fail: Fail): string {
  const min = rules.min ?? 0;
  if (rules.max !== undefined && (value.length > rules.max || value.length < min)) {
    fail(rules.sizeMessage ?? `size must be between ${min} and ${rules.max}`);
  }
  if (rules.pattern && !rules.pattern.test(value)) {
    fail(rules.patternMessage ?? `must match "${rules.pattern.source}"`);
  }
  // Hibernate Validator's @Email: local@domain, no whitespace (an empty string passes).
  if (rules.email && value !== '' && !/^[^\s@]+@[^\s@]+$/.test(value)) {
    fail(rules.emailMessage ?? 'must be a well-formed email address');
  }
  return value;
}

/** @NotBlank (+ optional @Size/@Pattern/@Email). */
export const requiredString = (rules: StringRules & { blankMessage?: string } = {}) =>
  field<string>((v, fail) => {
    if (absent(v) || (typeof v === 'string' && v.trim() === '')) {
      fail(rules.blankMessage ?? 'must not be blank');
      return '';
    }
    if (typeof v !== 'string') {
      fail('must be a string');
      return '';
    }
    return checkString(v, rules, fail);
  });

/** Nullable string (+ optional @Size/@Pattern). */
export const optionalString = (rules: StringRules = {}) =>
  field<string | undefined>((v, fail) => {
    if (absent(v)) return undefined;
    if (typeof v !== 'string') {
      fail('must be a string');
      return undefined;
    }
    return checkString(v, rules, fail);
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string) => UUID_RE.test(v);

export const optionalUuid = () =>
  field<string | undefined>((v, fail) => {
    if (absent(v)) return undefined;
    if (typeof v !== 'string' || !UUID_RE.test(v)) {
      fail('must be a valid UUID');
      return undefined;
    }
    return v.toLowerCase();
  });

/** @NotNull UUID. */
export const requiredUuid = (nullMessage = 'must not be null') =>
  field<string>((v, fail) => {
    if (absent(v)) {
      fail(nullMessage);
      return '';
    }
    if (typeof v !== 'string' || !UUID_RE.test(v)) {
      fail('must be a valid UUID');
      return '';
    }
    return v.toLowerCase();
  });

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function toDecimal(v: unknown): Prisma.Decimal | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Prisma.Decimal(String(v));
  if (typeof v === 'string' && NUMERIC_RE.test(v.trim())) return new Prisma.Decimal(v.trim());
  return null;
}

interface NumberRules {
  required?: boolean;
  positive?: boolean;
  positiveOrZero?: boolean;
  max?: number;
}

function checkNumber(n: Prisma.Decimal, rules: NumberRules, fail: Fail) {
  if (rules.positive && n.lte(0)) fail('must be greater than 0');
  if (rules.positiveOrZero && n.lt(0)) fail('must be greater than or equal to 0');
  if (rules.max !== undefined && n.gt(rules.max)) fail(`must be less than or equal to ${rules.max}`);
}

/** BigDecimal field (money). */
export const decimal = <R extends NumberRules>(rules: R) =>
  field<R['required'] extends true ? Prisma.Decimal : Prisma.Decimal | undefined>((v, fail) => {
    if (absent(v)) {
      if (rules.required) fail('must not be null');
      return undefined as never;
    }
    const n = toDecimal(v);
    if (!n) {
      fail('must be a number');
      return undefined as never;
    }
    checkNumber(n, rules, fail);
    return n as never;
  });

/** Integer / Long field. */
export const integer = <R extends NumberRules>(rules: R) =>
  field<R['required'] extends true ? number : number | undefined>((v, fail) => {
    if (absent(v)) {
      if (rules.required) fail('must not be null');
      return undefined as never;
    }
    const n = toDecimal(v);
    if (!n || !n.isInteger() || n.abs().gt(Number.MAX_SAFE_INTEGER)) {
      fail('must be an integer');
      return undefined as never;
    }
    checkNumber(n, rules, fail);
    return n.toNumber() as never;
  });

/** Primitive boolean: absent or null means false (Jackson's primitive default). */
export const flag = () =>
  field<boolean>((v, fail) => {
    if (absent(v)) return false;
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 'false') return v === 'true';
    fail('must be a boolean');
    return false;
  });

export const oneOf = <T extends string>(values: readonly T[]) =>
  field<T | undefined>((v, fail) => {
    if (absent(v)) return undefined;
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      fail(`must be one of ${values.join(', ')}`);
      return undefined;
    }
    return v as T;
  });

/** Path parameter that must be a UUID; anything else is a 400 (Java answered 500). */
export function pathUuid(value: string | string[] | undefined, name = 'id'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError({ [name]: 'must be a valid UUID' });
  }
  return value.toLowerCase();
}
