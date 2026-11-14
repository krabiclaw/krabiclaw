import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireIntegrationAccount } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { listLinkedFacebookPages } from '~/server/utils/facebook-pages'
import { readIntegration, storeIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'

/**
 * The tenant's answer to "which Page". This is the only thing that writes a
 * Facebook connection, so a Page is connected because somebody chose it, and
 * through the linked Facebook account they named.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const body = await readBody<{ revision?: string; account_id?: string; page_id?: string }>(event)
  const accountId = body?.account_id?.trim()
  const pageId = body?.page_id?.trim()
  if (!accountId || !pageId) return jsonResponse({ error: 'Choose a Facebook account and Page.' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  if (!await hasOrganizationEntitlement(env, organization.id, 'managed_service')) {
    return jsonResponse({ error: 'Facebook requires the Growth plan.' }, { status: 403 })
  }

  const current = await readIntegration(env.DB, organization.id, 'facebook')
  if ((current?.revision ?? null) !== (body?.revision ?? null)) return jsonResponse({ error: 'Facebook changed. Reload the connection before saving.' }, { status: 409 })
  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: null, providerId: 'facebook', scopes: [],
  })

  const page = (await listLinkedFacebookPages(env, accountId)).find(candidate => candidate.id === pageId)
  if (!page) return jsonResponse({ error: 'That Facebook account does not manage that Page.' }, { status: 400 })

  await storeIntegration(env.DB, organization.id, 'facebook', {
    account_id: accountId, target_id: page.id, target_name: page.name,
  }, { revision: current?.revision ?? null })

  return jsonResponse({ success: true, page_id: page.id, page_name: page.name })
})
