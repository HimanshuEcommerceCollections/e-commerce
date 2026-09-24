import type { Prisma } from '@prisma/client';

/**
 * The envelope every JSON response uses: `{ success, message, data?, timestamp }`.
 * `data` is omitted when null (the Java record had @JsonInclude(NON_NULL));
 * nulls *inside* data are kept, as Jackson kept them.
 */
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data?: T;
  timestamp: string;
}

function envelope<T>(success: boolean, message: string, data: T | null | undefined): ApiResponse<T> {
  const body: ApiResponse<T> = { success, message, timestamp: new Date().toISOString() };
  if (data !== null && data !== undefined) body.data = data;
  return body;
}

export const ok = <T>(data: T, message = 'Success') => envelope(true, message, data);
export const created = <T>(data: T, message = 'Created successfully') => envelope(true, message, data);
export const noContent = (message: string) => envelope<never>(true, message, null);
export const failure = <T = never>(message: string, details?: T) => envelope<T>(false, message, details);

// ── JSON number fidelity ────────────────────────────────────────────────────
// Jackson wrote BigDecimal with its scale ("price": 499.00) and longs exactly.
// JSON.rawJSON (Node ≥ 21) lets us emit the same digits instead of a lossy
// JS number.

declare global {
  interface JSON {
    rawJSON(text: string): unknown;
  }
}

/** A numeric(12,2) money value, serialized with exactly two decimals. */
export function money(value: Prisma.Decimal): unknown {
  return JSON.rawJSON(value.toFixed(2));
}

export function bigint(value: bigint | null | undefined): unknown {
  return value === null || value === undefined ? null : JSON.rawJSON(value.toString());
}
