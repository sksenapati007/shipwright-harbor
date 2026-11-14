import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// Static site, no backend. Relative base ('./') so it works under GitHub Pages' /shipwright/ path and on any static host path
// (default plan: GitHub Pages of the user's repository).
declare const process: { env: Record<string, string | undefined> };

// The in-memory FakeDevice (?fake, window.__fake) is compiled in only for dev, test and e2e builds: HARBOR_FAKE=1 at
// build time (playwright.config.ts sets it, together with HARBOR_OUT so the result never lands in dist/), `vite dev` and
// vitest. A plain `vite build` / release build has no fake.
export default defineConfig(({ command, mode }) => ({
  define: { __HARBOR_FAKE__: JSON.stringify(command === 'serve' || mode === 'test' || process.env.HARBOR_FAKE === '1') },
  base: './',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // main.tsx registers explicitly
      manifest: false, // public/manifest.webmanifest is the source of truth
      includeAssets: ['manifest.webmanifest', 'icons/*.png', 'fonts/*.woff2'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // HARBOR_OUT redirects the output: the e2e build (with the fake) goes to its own directory, never to dist/.
  build: { outDir: process.env.HARBOR_OUT || 'dist', emptyOutDir: true, target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
}));
