import { getSourceLocale } from '~/server/utils/organization-locales'
import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import {
  assertExactCanonicalLocale,
  assertOrganizationLanguageEntitlement,
  canonicalizeLocale,
} from '~/server/utils/localization'

export interface OrganizationLocaleState {
  requestedLocale: string
  sourceLocale: string
  effectiveLocale: string
  isSourceLocale: boolean
  platformMessages: Record<string, string> | null
}
export function normalizeLocale(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return canonicalizeLocale(value)
  } catch {
    return null
  }
}

export async function resolveOrganizationLocale(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  requestedLocale: unknown,
): Promise<OrganizationLocaleState> {
  const sourceLocale = await getSourceLocale(db, organizationId)
  const requested = requestedLocale === undefined || requestedLocale === null || requestedLocale === ''
    ? sourceLocale
    : assertExactCanonicalLocale(requestedLocale)
  const entitlement = await assertOrganizationLanguageEntitlement(env, db, organizationId, requested)
  return {
    requestedLocale: requested,
    sourceLocale,
    effectiveLocale: requested,
    isSourceLocale: entitlement.source,
    platformMessages: entitlement.platform_messages,
  }
}
