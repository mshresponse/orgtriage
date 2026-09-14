import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// package.json declares "type": "module", so this config is ESM and has no
// __dirname. Node 20.11+ provides import.meta.dirname.
const here = import.meta.dirname;

/**
 * Build pass 1 — extension pages and the MV3 service worker.
 *
 * The service worker is declared `"type": "module"` in the manifest, so ESM
 * output with shared chunks is fine here. The content script cannot use ESM and
 * is therefore built separately (see vite.content.config.ts) as a single IIFE.
 */
export default defineConfig({
  root: resolve(here, 'src'),
  publicDir: resolve(here, 'public'),
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
      // Lightning Flow Scanner is built for a CLI and imports node:path for a
      // filename it never reads from disk. Three functions stand in for it —
      // see src/shims/path.ts — rather than pulling a polyfill into the worker.
      path: resolve(here, 'src/shims/path.ts'),
      fs: resolve(here, 'src/shims/fs.ts'),
    },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    // Source maps are for local debugging only. `npm run zip` strips them, so
    // the uploaded package carries neither the maps nor a `sourceMappingURL`
    // pointing at a file the reviewer cannot see.
    sourcemap: true,
    // No remote code, no eval: MV3 forbids both. Keep the bundle self-contained.
    minify: 'esbuild',
    rollupOptions: {
      input: {
        panel: resolve(here, 'src/panel.html'),
        options: resolve(here, 'src/options.html'),
        report: resolve(here, 'src/report.html'),
        background: resolve(here, 'src/background/index.ts'),
      },
      output: {
        // Stable, predictable names so manifest.json can reference them.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  define: {
    // Compiled into every bundle so the panel can tell when Chrome is still
    // running an older service worker (see `meta.build`).
    __ORGTRIAGE_BUILD__: JSON.stringify(process.env.npm_package_version ?? 'dev'),
    // Lit dev-mode warnings are noisy inside an extension page.
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
});
