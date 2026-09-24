import type { Prisma } from '@prisma/client';

/** ISO-4217 currencies without a minor unit (Stripe's "zero-decimal" set). */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * Three-decimal currencies are deliberately unsupported: treating them as
 * two-decimal would charge a tenth of the price, and the webhook amount check
 * (same conversion) would confirm it.
 */
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/**
 * Major units → integer minor units (dollars → cents), exactly: a fractional
 * cent throws rather than being rounded away. Shared by charge creation and
 * webhook amount validation so both always agree.
 */
export function toMinorUnits(amount: Prisma.Decimal, currency: string): bigint {
  const upper = currency.toUpperCase();
  if (THREE_DECIMAL.has(upper)) {
    throw new Error(`Three-decimal currency ${upper} is not supported`);
  }
  const scaled = ZERO_DECIMAL.has(upper) ? amount : amount.mul(100);
  if (!scaled.isInteger()) {
    throw new Error(`Amount ${amount.toString()} ${upper} has a fractional minor unit`);
  }
  return BigInt(scaled.toFixed(0));
}
