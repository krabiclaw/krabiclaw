import type { DbClient } from '~/server/db'
import { getPersistedSourceLocale, listOrganizationLocaleRecords } from '~/server/utils/localization'

export type OrganizationLocaleStatus = 'published' | 'disabled'

export async function getSourceLocale(db: DbClient, organizationId: string): Promise<string> {
  const source = await getPersistedSourceLocale(db, organizationId)
  return source.locale
}
export async function listOrganizationLocales(db: DbClient, organizationId: string) {
  return { locales: await listOrganizationLocaleRecords(db, organizationId) }
}
