import { readFileSync } from 'node:fs'
import type { SeedTenantKey } from '../../../config/development-auth-fixtures.ts'

/** Each seeded business's subdomain; tests address its public site with it. */
export const SEED_SUBDOMAINS: Record<SeedTenantKey, string> = { restaurant: 'demo', experience: 'clayhouse', legal: 'harbor-legal' }

/** Written by the seed in Playwright's global setup; read by specs in their workers. */
export const SEED_MANIFEST_PATH = new URL(`../.seed/manifest-${process.env.PLAYWRIGHT_PORT ?? 3000}.json`, import.meta.url)

export interface SeedTenant {
  key: SeedTenantKey
  organizationId: string
  name: string
  slug: string
  subdomain: string
  vertical: string
  currency: string
  timezone: string
  /** Better Auth membership id by user id. */
  memberIds: Record<string, string>
  locations: Record<string, { id: string; slug: string; title: string; timezone: string }>
  products: Record<string, { id: string; slug: string; name: string; kind: string }>
  media: Record<string, { id: string; public_url: string }>
  collections: Record<string, { id: string; name: string; location_id: string | null }>
  categories: Record<string, { id: string; name: string }>
  /** When a seeded booking's session ended; the seed waits for it before tests run. */
  endedSessionEndsAt?: string
}

export interface SeedManifest {
  baseURL: string
  adminUserId: string
  /** KrabiClaw's own organization, which runs the platform template. */
  platformOrganizationId: string
  tenants: Record<SeedTenantKey, SeedTenant>
}

let cached: SeedManifest | null = null

/** The seeded businesses. A spec that runs before the seed fails here, by name. */
export function seed(): SeedManifest {
  if (!cached) {
    try {
      cached = JSON.parse(readFileSync(SEED_MANIFEST_PATH, 'utf8')) as SeedManifest
    } catch (error) {
      throw new Error("The E2E seed manifest is missing; Playwright's global setup writes it", { cause: error })
    }
  }
  return cached
}

export function seededTenant(key: SeedTenantKey): SeedTenant {
  const tenant = seed().tenants[key]
  if (!tenant) throw new Error(`The E2E seed has no ${key} tenant`)
  return tenant
}
