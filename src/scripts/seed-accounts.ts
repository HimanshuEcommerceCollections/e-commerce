import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../config';

/**
 * Staff and test logins from the environment, so a deployed database gets its
 * accounts without passwords in the repo:
 *
 *   SEED_ADMIN_EMAIL    / SEED_ADMIN_PASSWORD      ROLE_ADMIN
 *   SEED_CATALOG_EMAIL  / SEED_CATALOG_PASSWORD    ROLE_CATALOG
 *   SEED_CUSTOMER_EMAIL / SEED_CUSTOMER_PASSWORD   ROLE_CUSTOMER
 *
 * An account without both variables is skipped. Idempotent: upserts by email
 * and resets the password, so the environment stays the source of truth.
 *
 *   npm run seed:accounts
 *
 * The Docker image runs it on every start; with no SEED_* variables it does nothing.
 */

export interface SeedAccount {
  email: string;
  password: string;
  fullName: string;
  role: string;
  phoneNumber?: string;
}

const KINDS = {
  ADMIN: { role: 'ROLE_ADMIN', fullName: 'Store Admin' },
  CATALOG: { role: 'ROLE_CATALOG', fullName: 'Catalog Team' },
  CUSTOMER: { role: 'ROLE_CUSTOMER', fullName: 'Test Customer' },
} as const;

export type AccountKind = keyof typeof KINDS;

/** The account configured by SEED_<KIND>_EMAIL / _PASSWORD, or null when either is unset. */
export function envAccount(kind: AccountKind, env: NodeJS.ProcessEnv = process.env): SeedAccount | null {
  const email = env[`SEED_${kind}_EMAIL`]?.trim().toLowerCase();
  const password = env[`SEED_${kind}_PASSWORD`];
  return email && password ? { email, password, ...KINDS[kind] } : null;
}

export async function upsertUser(prisma: PrismaClient, a: SeedAccount) {
  const password = await bcrypt.hash(a.password, 10);
  return prisma.user.upsert({
    where: { email: a.email },
    update: { password, fullName: a.fullName, role: a.role, enabled: true, accountNonLocked: true, deleted: false },
    create: { email: a.email, password, fullName: a.fullName, role: a.role, phoneNumber: a.phoneNumber ?? null },
  });
}

async function main() {
  const accounts = (Object.keys(KINDS) as AccountKind[])
    .map((kind) => envAccount(kind))
    .filter((a): a is SeedAccount => a !== null);
  if (accounts.length === 0) {
    console.log('seed:accounts: no SEED_*_EMAIL / SEED_*_PASSWORD set; nothing to do');
    return;
  }
  const { databaseUrl } = loadConfig({ JWT_SECRET: 'x'.repeat(32), ...process.env });
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    for (const a of accounts) {
      await upsertUser(prisma, a);
      console.log(`seed:accounts: ${a.email} (${a.role})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
}
