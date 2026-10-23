import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Single source of truth for the version shown in the UI (Settings → About):
// read it from this package.json at build time instead of hardcoding a string.
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * Which shared chunk a third-party module belongs to.
 *
 * Rules match the package's OWN directory, never a substring of the path. pnpm
 * nests a package's dependencies inside its virtual-store folder
 * (`.pnpm/recharts@2.15/node_modules/react-is/…`), so a loose
 * `id.includes('recharts')` also claimed libraries that recharts merely depends
 * on — which is how the 470 kB charting bundle ended up on the critical path of
 * routes that draw no charts.
 */
function pickChunk(id: string): string | undefined {
  // Style imports must NOT decide JS chunking. `main.tsx` imports each Mantine
  // package's global stylesheet (the documented setup, and the only way to keep
  // their cascade order). Assigning `@mantine/charts/styles.css` to the charts
  // chunk gave the entry a static edge into it, so every route downloaded the
  // 470 kB charting bundle — and the same for schedule/dates — purely for CSS.
  // Leaving stylesheets unassigned keeps them as plain CSS assets.
  if (/\.(css|scss|sass|less)(\?|$)/.test(id)) return undefined;

  const pkg = (...names: string[]): boolean =>
    names.some((name) => id.includes(`node_modules/${name}/`));

  // React first: it is the one dependency every other group shares, so without
  // a rule of its own it gets absorbed into whichever chunk reaches it first.
  if (pkg('react', 'react-dom', 'scheduler')) return 'react-vendor';
  if (
    pkg(
      '@mantine/core',
      '@mantine/hooks',
      '@mantine/modals',
      '@mantine/notifications',
      '@mantine/spotlight',
    )
  ) {
    return 'mantine-core';
  }
  // dayjs stays OUT of this group: it is used app-wide (timestamps on nearly
  // every page), so bundling it with the date-picker package would drag the
  // picker onto the critical path the same way the charts CSS did.
  if (pkg('@mantine/dates')) return 'mantine-dates';
  // Charts are deliberately NOT forced into a named chunk. The three chart
  // components are dynamically imported (Dashboard, Insights, Performance), so
  // leaving the library unassigned lets the bundler put it in those lazy chunks
  // — a named chunk instead becomes a shared node that every route links to,
  // which is what kept 470 kB on the critical path.
  if (pkg('@mantine/charts', 'recharts')) return undefined;
  if (pkg('@mantine/schedule')) return 'mantine-schedule';
  if (pkg('@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search')) return 'xterm';
  if (pkg('@tanstack/react-query', '@tanstack/react-router')) return 'query';
  if (pkg('cron-parser', 'luxon', 'cronstrue')) return undefined;
  // Remaining third-party code shares one vendor chunk instead of being folded
  // into a feature chunk it has nothing to do with.
  if (id.includes('node_modules')) return 'vendor';
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
      '@hub/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id): string | undefined {
          const group = pickChunk(id);
          // `CHUNK_DEBUG=1 pnpm build` dumps the module→chunk map to
          // `.cache/chunk-ids.txt`. Bundle-splitting bugs are invisible in the
          // size table (a shared library hides inside a feature chunk); this
          // makes them greppable.
          if (process.env.CHUNK_DEBUG) {
            appendFileSync(
              path.resolve(__dirname, '../../.cache/chunk-ids.txt'),
              `${group ?? '(auto)'}\t${id}\n`,
            );
          }
          return group;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5174',
      '/ws': {
        target: 'ws://127.0.0.1:5174',
        ws: true,
      },
    },
  },
});
