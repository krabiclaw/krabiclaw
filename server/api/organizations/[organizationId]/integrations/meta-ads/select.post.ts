import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireIntegrationAccount } from '~/server/utils/auth'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { selectMetaAdAccount } from '~/server/utils/meta-ads'

/**
 * Choosing the Meta Ad Account, through a named linked Facebook account.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const body = await readBody<{ account_id?: string; ad_account_id?: string; ad_account_name?: string }>(event)
  const accountId = body?.account_id?.trim()
  const adAccountId = body?.ad_account_id?.trim()
  const adAccountName = body?.ad_account_name?.trim()
  if (!accountId || !adAccountId || !adAccountName) {
    return jsonResponse({ error: 'Choose a Meta account and a Meta Ad Account.' }, { status: 400 })
  }

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: null,
    providerId: 'facebook',
    scopes: INTEGRATION_SCOPES['meta-ads'],
  })

  try {
    await selectMetaAdAccount(env, organization.id, accountId, adAccountId, adAccountName)
    return jsonResponse({ success: true, ad_account_id: adAccountId, ad_account_name: adAccountName })
  } catch (error) {
    rethrowHttpError(error)
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not select that Meta Ad Account.',
    }, { status: 502 })
  }
})
