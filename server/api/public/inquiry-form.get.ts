import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { readPublicInquiryForm } from '~/server/domain/form-questions'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguage, getPersistedSourceLocale } from '~/server/utils/localization'

/** The inquiry form this site asks visitors to fill in, in the language they read the site in. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const requested = getQuery(event).locale
  const locale = requested === undefined ? (await getPersistedSourceLocale(db, organizationId)).locale : assertExactCanonicalLocale(requested)
  const language = await assertPublicOrganizationLanguage(db, organizationId, locale)
  return jsonResponse({ success: true, ...await readPublicInquiryForm(db, organizationId, language.locale) }, { headers: { 'cache-control': 'private, no-store' } })
})
