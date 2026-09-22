import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

import { testDatabaseUrl } from './test/global-setup.js';

export default defineConfig({
  plugins: [tsconfigPaths(), swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Окружение e2e: отдельная БД и отдельный индекс Valkey, чтобы не задеть dev-данные.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      AUTO_MIGRATE: 'false',
      TRUST_PROXY: '1',
      DATABASE_URL: testDatabaseUrl(),
      VALKEY_URL: 'redis://127.0.0.1:6379/14',
      PASSWORD_LEAK_CHECK: 'false',
    },
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
