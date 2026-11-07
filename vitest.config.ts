import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/executor/playwright/**', 'src/**/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 85 },
    },
  },
});
