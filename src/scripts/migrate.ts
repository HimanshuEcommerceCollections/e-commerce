import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../config';

/**
 * Brings the database up to date with prisma/migrations, and adopts a database
 * the Java server built:
 *  - fresh database → `prisma migrate deploy` runs 0_init (Flyway V1–V10) and on;
 *  - Flyway-managed database at V10 → 0_init is marked applied (the schema is
 *    already there), then the rest deploy;
 *  - Flyway-managed database below V10 → refuse: let the Java server (or
 *    Flyway) finish its migrations first.
 * Safe to run on every start.
 */
const BASELINE = '0_init';
const FLYWAY_BASELINE_VERSION = 10;

async function main() {
  const { databaseUrl } = loadConfig({ JWT_SECRET: 'x'.repeat(32), ...process.env });
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const [{ prisma_table, flyway_table }] = await prisma.$queryRaw<{ prisma_table: string | null; flyway_table: string | null }[]>`
      SELECT to_regclass('public._prisma_migrations')::text AS prisma_table,
             to_regclass('public.flyway_schema_history')::text AS flyway_table`;

    if (!prisma_table && flyway_table) {
      const [{ version }] = await prisma.$queryRaw<{ version: number | null }[]>`
        SELECT max(version::int) AS version FROM flyway_schema_history WHERE success AND version ~ '^[0-9]+$'`;
      if (version !== FLYWAY_BASELINE_VERSION) {
        throw new Error(
          `This database is managed by Flyway at V${version ?? '?'}; bring it to V${FLYWAY_BASELINE_VERSION} ` +
            'with the Java server before switching to the TypeScript server.',
        );
      }
      console.log(`Flyway V${version} schema found — marking ${BASELINE} as applied`);
      prismaCli(databaseUrl, ['migrate', 'resolve', '--applied', BASELINE]);
    }
  } finally {
    await prisma.$disconnect();
  }
  prismaCli(databaseUrl, ['migrate', 'deploy']);
}

function prismaCli(databaseUrl: string, args: string[]) {
  const cli = require.resolve('prisma/build/index.js');
  const schema = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');
  const result = spawnSync(process.execPath, [cli, ...args, '--schema', schema], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) throw new Error(`prisma ${args.join(' ')} failed (exit ${result.status})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
