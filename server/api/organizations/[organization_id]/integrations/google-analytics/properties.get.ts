import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { linkedAccountAccessToken, requireIntegrationAccount } from '~/server/utils/auth'
import { listGa4Properties } from '~/server/utils/google-analytics'
import { integrationSummary, readIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'

/**
 * What the Analytics leaf shows: the property chosen, the Better Auth account
 * it was chosen through, and the properties an account can read.
 *
 * Which account is the caller's to say (`account_id`, one of their own linked
 * Google accounts); without one, the account the organization already uses.
 * Search Console is not mentioned here — the two products may share a linked
 * account, not a screen.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const analytics = integrationSummary(await readIntegration(env.DB, organization.id, 'google_analytics'))
  const accountId = event.url.searchParams.get('account_id') || analytics?.account_id || null
  if (!accountId) return jsonResponse({ success: true, account_id: null, analytics, properties: [], error: null })

  try {
    await requireIntegrationAccount(env, accountId, {
      userId: session.user.id,
      currentAccountId: analytics?.account_id,
      providerId: 'google',
      scopes: INTEGRATION_SCOPES['google-analytics'],
    })
    const properties = await listGa4Properties((await linkedAccountAccessToken(env, accountId)).accessToken)
    return jsonResponse({ success: true, account_id: accountId, analytics, properties, error: null })
  } catch (error) {
    rethrowHttpError(error)
    // The leaf still shows what is connected; the reason the properties could
    // not be read is what it shows in place of the list.
    console.error('google_analytics_properties_failed', { organizationId: organization.id, error })
    return jsonResponse({
      account_id: accountId, analytics, properties: [],
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
})
