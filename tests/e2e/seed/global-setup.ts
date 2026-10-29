import type { FullConfig } from '@playwright/test'
import { seedE2e } from './seed.ts'

/** Local E2E starts from an empty migrated database; this builds its businesses. */
export default async function globalSetup(config: FullConfig) {
  if (process.env.PLAYWRIGHT_PREVIEW_URL) throw new Error('The E2E seed runs only against the local Worker; deployed checks use playwright.deployed.config.ts')
  const baseURL = config.projects[0]?.use.baseURL
  if (!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('The E2E seed runs only against a local Worker')
  await seedE2e(baseURL)
}
