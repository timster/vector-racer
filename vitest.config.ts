import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{packages,tools}/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          include: ['apps/server/test/**/*.test.ts'],
          globalSetup: ['apps/server/test/global-setup.ts'],
          // Each test file gets its own database cloned from a migrated template.
          testTimeout: 20000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
