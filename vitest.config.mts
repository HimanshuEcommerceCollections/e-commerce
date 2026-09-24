import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/support/global-setup.mts'],
    include: ['test/**/*.test.ts'],
    // Files share one database (unique data per test, as the Java suite did);
    // running them one at a time keeps the concurrency tests' timing honest.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
