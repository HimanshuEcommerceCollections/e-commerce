import { Prisma, PrismaClient } from '@prisma/client';

export type { Prisma };

/** A client or an interactive-transaction client — repositories accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

/**
 * Transaction options. Checkout calls the payment provider while holding the
 * stock-decrement row locks (as the Java server did), so its budget is wider
 * than Prisma's 5 s default.
 */
export const TX = {
  default: { maxWait: 10_000, timeout: 15_000 },
  checkout: { maxWait: 10_000, timeout: 45_000 },
  catalogImport: { maxWait: 10_000, timeout: 120_000 },
} as const;
