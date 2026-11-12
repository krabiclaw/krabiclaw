import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { linkedAccountAccessToken, requireIntegrationAccount } from '~/server/utils/auth'
import { listMetaAdAccounts } from '~/server/utils/meta-ads'
import { integrationSummary, readIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'

/**
 * What the Meta Ads leaf shows: the ad account chosen, the Better Auth account
 * it was chosen through, and the Meta Ad accounts that account can access.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const ads = integrationSummary(await readIntegration(env.DB, organization.id, 'meta_ads'))
  const accountId = event.url.searchParams.get('account_id') || ads?.account_id || null
  if (!accountId) return jsonResponse({ success: true, account_id: null, ads, accounts: [], error: null })

  try {
    await requireIntegrationAccount(env, accountId, {
      userId: session.user.id,
      currentAccountId: ads?.account_id,
      providerId: 'facebook',
      scopes: INTEGRATION_SCOPES['meta-ads'],
    })
    const { accessToken } = await linkedAccountAccessToken(env, accountId)
    const accounts = await listMetaAdAccounts(accessToken)
    return jsonResponse({ success: true, account_id: accountId, ads, accounts, error: null })
  } catch (error) {
    rethrowHttpError(error)
    return jsonResponse({
      account_id: accountId, ads, accounts: [],
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
})
