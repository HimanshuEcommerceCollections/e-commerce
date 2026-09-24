import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * One real Postgres for the whole run: TEST_DATABASE_URL when set (CI's service
 * container), otherwise an embedded Postgres 16 in a temp directory. Never the
 * database from .env. Migrated from prisma/migrations, so every run also
 * proves the baseline + later migrations apply to an empty database.
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<void>) | undefined;

  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = mkdtempSync(path.join(tmpdir(), 'nexus-test-pg-'));
    const port = await freePort();
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      // UTF-8 regardless of the OS code page (Windows defaults to WIN1252,
      // which rejects the migrations' non-ASCII comments).
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('nexus_test');
    url = `postgresql://postgres:postgres@localhost:${port}/nexus_test`;
    stop = async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    await stop?.();
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }

  project.provide('databaseUrl', url);
  return async () => {
    await stop?.();
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
