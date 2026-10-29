import { defineConfig, devices } from '@playwright/test'

// Local runs read the canary credentials from .env, as the main config does;
// CI sets them in the environment and ships no .env.
try {
  process.loadEnvFile()
} catch (error) {
  if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
}

// Read-only checks of real customer and platform content on a deployed
// environment. They run after each staging and production deploy, never in
// pull-request E2E, which runs on local data.
const baseURL = process.env.PLAYWRIGHT_PREVIEW_URL
if (!baseURL) throw new Error('PLAYWRIGHT_PREVIEW_URL must name the deployed environment to check')

export default defineConfig({
  testDir: './tests/deployed',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: Number(process.env.PLAYWRIGHT_WORKERS ?? 2),
  reporter: process.env.CI
    ? [['list'], ['./tests/e2e/progress-reporter.ts'], ['html', { open: 'never' }]]
    : [['list'], ['./tests/e2e/progress-reporter.ts']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    // Customer sites, checked after every staging and production deploy.
    { name: 'tenants', testMatch: 'tenant-*.spec.ts', use: { ...devices['Desktop Chrome'] } },
    // KrabiClaw's own pricing, products and docs are authored on production;
    // staging's copy is not kept current, so production alone checks them.
    { name: 'platform', testMatch: ['pricing-presentation.spec.ts', 'platform-*.spec.ts'], use: { ...devices['Desktop Chrome'] } },
  ],
})
