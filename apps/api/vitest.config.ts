import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // NestJS опирается на декораторы и emitDecoratorMetadata — esbuild их не эмитит, swc умеет.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.{spec,test}.ts'],
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], include: ['src/**'] },
  },
});
