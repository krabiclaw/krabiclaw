import { testBaseUrl } from '../e2e/test-env'
import { environmentTenantAliasHostname } from '../../server/utils/tenant-hosts'

// The real customer sites the deployed checks read. Staging serves each at its
// environment alias (<slug>-staging.krabiclaw.com); production at its own domain.
export const POTTERY_HOUSE_CANONICAL_URL = 'https://www.potteryhousekrabi.com'
export const KIKUZUKI_CANONICAL_URL = 'https://www.kikuzuki-thailand.com'
export const NCLS_CANONICAL_URL = 'https://www.northcarolinalegalservices.org'

function deployedSite(slug: string, canonical: string): string {
  const base = new URL(testBaseUrl())
  const alias = environmentTenantAliasHostname(base.hostname, slug)
  if (alias) {
    base.hostname = alias
    return base.toString().replace(/\/$/, '')
  }
  return canonical
}

export const potteryHouseBaseURL = deployedSite('pottery-house', POTTERY_HOUSE_CANONICAL_URL)
export const blawbyBaseURL = deployedSite('ncls', NCLS_CANONICAL_URL)
export const kikuzukiBaseURL = deployedSite('kikuzuki-krabi-thailand', KIKUZUKI_CANONICAL_URL)
// A deployed site is addressed by its own host; no tenant header is sent.
export const potteryHouseExtraHeaders: Record<string, string> = {}
export const blawbyExtraHeaders: Record<string, string> = {}
export const kikuzukiExtraHeaders: Record<string, string> = {}
