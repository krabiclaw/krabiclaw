import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireIntegrationAccount } from '~/server/utils/auth'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { selectGoogleAdsCustomer } from '~/server/utils/google-ads'

/**
 * Choosing the Google Ads customer, through a named linked Google account.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const body = await readBody<{ account_id?: string; customer_id?: string; customer_name?: string; service?: string; revision?: string | null }>(event)
  const accountId = body?.account_id?.trim()
  const customerId = body?.customer_id?.trim()
  const customerName = body?.customer_name?.trim()
  if (!accountId || !customerId || !customerName) {
    return jsonResponse({ error: 'Choose a Google account and a Google Ads account.' }, { status: 400 })
  }

  const managedAds = body?.service === 'managed-ads'
  if (managedAds && body?.revision === undefined) {
    return jsonResponse({ error: 'Reload the Google Ads account before selecting it.', code: 'GOOGLE_ADS_REVISION_REQUIRED' }, { status: 400 })
  }
  if (body?.revision !== undefined && body.revision !== null && typeof body.revision !== 'string') {
    return jsonResponse({ error: 'Invalid account revision' }, { status: 400 })
  }
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: null,
    providerId: 'google',
    scopes: INTEGRATION_SCOPES['google-ads'],
  })

  try {
    await selectGoogleAdsCustomer(env, organization.id, accountId, customerId, customerName, managedAds,
      body?.revision === undefined ? undefined : { revision: body.revision })
    return jsonResponse({ success: true, customer_id: customerId, customer_name: customerName })
  } catch (error) {
    rethrowHttpError(error)
    console.error('google_ads_select_failed', { organizationId: organization.id, error })
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not select that Google Ads account.',
    }, { status: 502 })
  }
})
