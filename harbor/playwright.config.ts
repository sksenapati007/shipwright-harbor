import { defineConfig, devices } from '@playwright/test';

// The e2e bundle contains FakeDevice. It is built into its own directory and served from there, so a release build
// (npm run build -> dist/) can never contain it, whatever ran before.
const OUT = 'node_modules/.e2e-dist';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4173', serviceWorkers: 'allow' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `HARBOR_FAKE=1 HARBOR_OUT=${OUT} npm run build && npx vite preview --outDir ${OUT} --port 4173 --strictPort`,
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
