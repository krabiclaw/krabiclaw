import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { linkedAccountAccessToken, requireIntegrationAccount } from '~/server/utils/auth'
import { listGoogleAdsAccounts } from '~/server/utils/google-ads'
import { integrationSummary, readIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'

/**
 * What the Google Ads leaf shows: the customer chosen, the Better Auth account
 * it was chosen through, and the Google Ads accounts that account can access.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const ads = integrationSummary(await readIntegration(env.DB, organization.id, 'google_ads'))
  const accountId = event.url.searchParams.get('account_id') || ads?.account_id || null
  if (!accountId) return jsonResponse({ success: true, account_id: null, ads, accounts: [], error: null })

  try {
    await requireIntegrationAccount(env, accountId, {
      userId: session.user.id,
      currentAccountId: ads?.account_id,
      providerId: 'google',
      scopes: INTEGRATION_SCOPES['google-ads'],
    })
    const { accessToken } = await linkedAccountAccessToken(env, accountId)
    const accounts = await listGoogleAdsAccounts(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN)
    const notEnabled = accounts.filter(account => account.notEnabled).map(account => account.customerId)
    if (notEnabled.length) console.info('google_ads_accounts_not_enabled', { organizationId: organization.id, accountId, customerIds: notEnabled })
    return jsonResponse({ success: true, account_id: accountId, ads, accounts, error: null })
  } catch (error) {
    rethrowHttpError(error)
    console.error('google_ads_accounts_failed', { organizationId: organization.id, error })
    return jsonResponse({
      account_id: accountId, ads, accounts: [],
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
})
