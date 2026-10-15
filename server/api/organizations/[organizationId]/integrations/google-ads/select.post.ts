import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireIntegrationAccount } from '~/server/utils/auth'
import { readIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { selectGoogleAdsCustomer } from '~/server/utils/google-ads'

/**
 * Choosing the Google Ads customer, through a named linked Google account.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const body = await readBody<{ account_id?: string; customer_id?: string; customer_name?: string }>(event)
  const accountId = body?.account_id?.trim()
  const customerId = body?.customer_id?.trim()
  const customerName = body?.customer_name?.trim()
  if (!accountId || !customerId || !customerName) {
    return jsonResponse({ error: 'Choose a Google account and a Google Ads account.' }, { status: 400 })
  }

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  if (!await hasOrganizationEntitlement(env, organization.id, 'marketing')) {
    return jsonResponse({ error: 'Google Ads requires the Business plan.' }, { status: 403 })
  }
  const current = await readIntegration(env.DB, organization.id, 'google_ads')
  if (current) return jsonResponse({ error: 'Disconnect Google Ads before connecting again.' }, { status: 409 })
  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: null,
    providerId: 'google',
    scopes: INTEGRATION_SCOPES['google-ads'],
  })

  try {
    await selectGoogleAdsCustomer(env, organization.id, accountId, customerId, customerName, { revision: null })
    return jsonResponse({ success: true, customer_id: customerId, customer_name: customerName })
  } catch (error) {
    rethrowHttpError(error)
    console.error('google_ads_select_failed', { organizationId: organization.id, error })
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not select that Google Ads account.',
    }, { status: 502 })
  }
})
