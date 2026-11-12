import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireIntegrationAccount } from '~/server/utils/auth'
import { selectAnalyticsProperty } from '~/server/utils/google-analytics'
import { readIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { reconcileZarazAnalytics } from '~/server/utils/zaraz-analytics'

/**
 * Choosing the GA4 property, through a named linked Google account. This is
 * the only thing that writes a measurement id: it is resolved from the
 * property's web data stream rather than typed in, and Zaraz is reconciled so
 * the tag the site serves matches what was chosen.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const body = await readBody<{ account_id?: string; property_id?: string; property_name?: string }>(event)
  const accountId = body?.account_id?.trim()
  const propertyId = body?.property_id?.trim()
  const propertyName = body?.property_name?.trim()
  if (!accountId || !propertyId || !propertyName) {
    return jsonResponse({ error: 'Choose a Google account and an Analytics property.' }, { status: 400 })
  }

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const current = await readIntegration(env.DB, organization.id, 'google_analytics')
  if (current) return jsonResponse({ error: 'Disconnect Google Analytics before connecting again.' }, { status: 409 })
  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: null,
    providerId: 'google',
    scopes: INTEGRATION_SCOPES['google-analytics'],
  })

  try {
    const measurementId = await selectAnalyticsProperty(
      env, organization.id, accountId, propertyId, propertyName,
      { revision: null },
    )

    // The property is only in effect once the tracking configuration carries
    // its measurement id, so this failure belongs to the save that asked for
    // it rather than to a log nobody reads.
    const zaraz = await reconcileZarazAnalytics(env, env.DB)

    // `zaraz` says which happened: `reconciled`, or `zaraz_absent` where the
    // environment declares it has no Zaraz zone.
    return jsonResponse({ success: true, measurement_id: measurementId, zaraz: zaraz.status })
  } catch (error) {
    rethrowHttpError(error)
    console.error('google_analytics_select_failed', { organizationId: organization.id, error })
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not select that Analytics property.',
    }, { status: 502 })
  }
})
