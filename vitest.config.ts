import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // hermetic CI: no network, no live provider (plan rev 3, condition 8)
    env: { BUTLER_PROVIDER: 'mock' },
    testTimeout: 20_000,
  },
});
