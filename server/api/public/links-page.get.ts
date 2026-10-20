import { assertExactCanonicalLocale } from '~/server/utils/localization'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getPublicLinksPage } from '~/server/utils/links-page'
import { getQuery } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'organizationId required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database unavailable' }, { status: 503 })

  const query = getQuery(event)
  const locale = query.locale === undefined ? await getSourceLocale(db, organizationId) : assertExactCanonicalLocale(query.locale)
  const linksPage = await getPublicLinksPage(env, db, organizationId, locale)
  if (!linksPage) return jsonResponse({ error: 'Links page not found' }, { status: 404 })

  return jsonResponse({ success: true, ...linksPage })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
