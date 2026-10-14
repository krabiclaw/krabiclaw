import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { listOrganizationLocales } from '~/server/utils/organization-locales'

interface PublicLocale {
  code: string
  display_name: string | null
  is_source: boolean
  status: 'published' | 'disabled'
}

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const { locales } = await listOrganizationLocales(db, organizationId)
  const publicLocales: PublicLocale[] = locales
    .filter(locale => locale.is_source || locale.status === 'published')
    .map(locale => ({
      code: locale.locale, display_name: locale.label, is_source: locale.is_source, status: locale.status, }))

  return jsonResponse({
    success: true, locales: publicLocales, })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
