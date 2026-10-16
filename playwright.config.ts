import { Buffer } from 'node:buffer'
import { defineConfig, devices } from '@playwright/test'

// A local run gets its secrets the way every other local command does. CI sets
// them in the real environment and ships no .env, where this is a no-op — but
// only a missing file is expected. An unreadable or malformed one is a broken
// setup and has to say so rather than silently running without its secrets.
try {
  process.loadEnvFile()
} catch (error) {
  if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
}

const liveGooglePlaces = process.env.E2E_GOOGLE_PLACES === 'true'
if (!liveGooglePlaces) process.env.GOOGLE_PLACES_API_KEY = ''
else if (!process.env.GOOGLE_PLACES_API_KEY?.trim()) throw new Error('E2E_GOOGLE_PLACES requires GOOGLE_PLACES_API_KEY')

const previewUrl = process.env.PLAYWRIGHT_PREVIEW_URL
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = previewUrl || `http://localhost:${port}`
const localPrepared = process.env.PLAYWRIGHT_LOCAL_PREPARED === 'true'
const captureServerLogs = process.env.PLAYWRIGHT_SERVER_LOGS === 'true' || !!process.env.CI
const localDevRouteSecret = previewUrl ? '' : 'local-playwright-dev-route-secret'

if (!previewUrl) {
  process.env.E2E_DEV_ROUTE_SECRET = localDevRouteSecret
  // The provider-ingress spec signs Resend webhooks with this and the local
  // Worker, which inherits this process's environment, verifies them with it.
  // The deployed secrets never leave Cloudflare.
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from('local-playwright-resend-webhook').toString('base64')}`
  // The SDK cannot be built without a key even to verify a signature. The
  // local Worker delivers log-only, so a run with no key of its own gets one
  // that is never used to send.
  process.env.RESEND_API_KEY ||= 're_local_playwright_log_only'
  // The provider-ingress spec builds a signed reply address with this and the
  // local Worker verifies it; neither reads the deployed secret.
  process.env.EMAIL_REPLY_SECRET = 'local-playwright-email-reply-secret'
}

const localWorkerEnvironment = [
  // Wrangler reads .env natively. Include the runner's environment so CI secrets
  // and the local overrides below reach Worker bindings without a second list.
  'CLOUDFLARE_INCLUDE_PROCESS_ENV=true',
  'EMAIL_DELIVERY_MODE=log_only',
  'WHATSAPP_DELIVERY_MODE=log_only',
  'ZARAZ_ANALYTICS=absent',
  `EMAIL_REPLY_SECRET=${process.env.EMAIL_REPLY_SECRET}`,
  `BETTER_AUTH_URL=http://localhost:${port}`,
  `NUXT_PUBLIC_PLATFORM_DOMAIN=http://localhost:${port}`,
  `NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN=http://localhost:${port}`,
  'NUXT_PUBLIC_APP_NAME=KrabiClaw',
  `NUXT_PUBLIC_SITE_URL=http://localhost:${port}`,
  `NUXT_PUBLIC_HELP_URL=http://localhost:${port}/help`,
].join(' ')

const localWorkerCommand = [
  localWorkerEnvironment,
  'corepack yarn wrangler dev .output/server/index.mjs --env e2e',
  '--assets .output/public',
  `--port ${port}`,
  '--var E2E_ALLOW_DEV_ROUTES:true',
  `--var E2E_DEV_ROUTE_SECRET:${localDevRouteSecret}`,
  ...(!liveGooglePlaces ? ['--var GOOGLE_PLACES_API_KEY:'] : []),
].join(' ')

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './scripts/provision-development-auth.ts',
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Remote D1 write suites can opt back down with PLAYWRIGHT_WORKERS=1. Two
  // workers keeps the read-heavy smoke/path-gated suites quick without placing
  // unbounded pressure on the shared preview and staging databases.
  workers: process.env.PLAYWRIGHT_WORKERS
    ? Number(process.env.PLAYWRIGHT_WORKERS)
    : process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['./tests/e2e/progress-reporter.ts'], ['html', { open: 'never' }]]
    : [['list'], ['./tests/e2e/progress-reporter.ts']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  // Remote suites target an already-deployed Worker. Local suites prepare the
  // local D1 fixtures, build the production Worker, and run it in workerd.
  webServer: previewUrl ? undefined : {
    command: localPrepared
      ? localWorkerCommand
      : `${localWorkerEnvironment} corepack yarn e2e:local:prepare && ${localWorkerCommand}`,
    // Not `/`. On the platform host that is a tenant page, and a `db:pull:local`
    // snapshot carries no page documents for the platform site, so `/` answers
    // 404 and the suite never starts — which is how a test broken by #1001 sat
    // failing while only the @smoke subset ran in CI. /api/health needs no
    // content and no session, and pings D1, so readiness means the Worker and
    // its binding are both up.
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: localPrepared ? 180_000 : 600_000,
    stdout: captureServerLogs ? 'pipe' : 'ignore',
    stderr: captureServerLogs ? 'pipe' : 'ignore'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-mobile-layout', use: { ...devices['Desktop Safari'], viewport: { width: 390, height: 844 } }, testMatch: '**/dashboard-layout.spec.ts', grep: /mobile scroll/ },
  ]
})
