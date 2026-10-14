import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Starts one Postgres container (Testcontainers) for the whole run.
    globalSetup: ['test/helpers/globalSetup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
