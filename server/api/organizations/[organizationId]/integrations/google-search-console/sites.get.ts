import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { linkedAccountAccessToken, requireIntegrationAccount } from '~/server/utils/auth'
import { listSearchConsoleSites } from '~/server/utils/google-search-console'
import { integrationSummary, readIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { organizationPublicUrl } from '~/server/utils/domains'

/**
 * What the Search Console leaf shows: the property chosen, the Better Auth
 * account it was connected through, the properties an account already owns,
 * and this site's own public URL — the one KrabiClaw can verify
 * automatically, which is offered even when the account does not own it yet.
 *
 * Which account is the caller's to say (`account_id`); without one, the
 * account the organization already uses.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)
  const searchConsole = integrationSummary(await readIntegration(env.DB, organization.id, 'google_search_console'))
  const siteUrl = await organizationPublicUrl(env, db, organization.id)
  const accountId = event.url.searchParams.get('account_id') || searchConsole?.account_id || null
  if (!accountId) {
    return jsonResponse({ success: true, account_id: null, searchConsole, siteUrl, properties: [], error: null })
  }

  try {
    await requireIntegrationAccount(env, accountId, {
      userId: session.user.id,
      currentAccountId: searchConsole?.account_id,
      providerId: 'google',
      scopes: INTEGRATION_SCOPES['google-search-console'],
    })
    const properties = await listSearchConsoleSites((await linkedAccountAccessToken(env, accountId)).accessToken)
    return jsonResponse({ success: true, account_id: accountId, searchConsole, siteUrl, properties, error: null })
  } catch (error) {
    rethrowHttpError(error)
    console.error('google_search_console_sites_failed', { organizationId: organization.id, error })
    return jsonResponse({
      account_id: accountId, searchConsole, siteUrl, properties: [],
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
})
