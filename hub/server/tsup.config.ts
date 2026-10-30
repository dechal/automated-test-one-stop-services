import { defineConfig } from 'tsup';

export default defineConfig({
  // Build only runtime sources — never test files. tsup expands these globs via
  // tinyglobby, so negation patterns drop `*.test.ts`, `*.spec.ts`, and anything
  // under a `__tests__/` folder from `dist` (otherwise @fastify/autoload would
  // try to register a compiled test as a route plugin and crash at startup).
  entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.spec.ts', '!src/**/__tests__/**'],
  outDir: 'dist',
  format: 'esm',
  target: 'node26',
  bundle: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
});
