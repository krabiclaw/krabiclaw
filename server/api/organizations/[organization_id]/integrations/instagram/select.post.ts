import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { linkedAccountAccessToken, requireIntegrationAccount } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { getInstagramAccount } from '~/server/utils/instagram'
import { readIntegration, storeIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'

/**
 * Connects the organization to a linked Instagram account the caller names.
 * Linking the account is Better Auth's; choosing it for this website is this
 * route, so an account is connected because somebody chose it here.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const body = await readBody<{ revision?: string; account_id?: string }>(event)
  const accountId = body?.account_id?.trim()
  if (!accountId) return jsonResponse({ error: 'Choose an Instagram account.' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  if (!await hasOrganizationEntitlement(env, organization.id, 'managed_service')) {
    return jsonResponse({ error: 'Instagram requires the Growth plan.' }, { status: 403 })
  }

  const current = await readIntegration(env.DB, organization.id, 'instagram')
  if ((current?.revision ?? null) !== (body?.revision ?? null)) return jsonResponse({ error: 'Instagram changed. Reload the connection before saving.' }, { status: 409 })
  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: null, providerId: 'instagram', scopes: [],
  })

  const account = await getInstagramAccount((await linkedAccountAccessToken(env, accountId)).accessToken)
  await storeIntegration(env.DB, organization.id, 'instagram', {
    account_id: accountId, target_id: account.id, target_name: account.username,
  }, { revision: current?.revision ?? null })

  return jsonResponse({ success: true, username: account.username })
})
