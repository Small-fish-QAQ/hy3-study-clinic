import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // SQLite file setup/teardown can be slightly slower on Windows CI.
    testTimeout: 15000,
  },
});
