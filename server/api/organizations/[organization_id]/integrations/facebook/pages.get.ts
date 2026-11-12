import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireIntegrationAccount } from '~/server/utils/auth'
import { listLinkedFacebookPages } from '~/server/utils/facebook-pages'
import { integrationSummary, readIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'

/**
 * The Facebook leaf: the connected Page, and the Pages a linked Facebook
 * account manages to choose between.
 *
 * Which account is the caller's to say (`account_id`, one of their own linked
 * Facebook accounts); without one, the account the organization already uses.
 * Only names and ids leave here — Page tokens are read again whenever one is
 * needed and never stored.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const connection = await readIntegration(env.DB, organization.id, 'facebook')
  const summary = integrationSummary(connection)
  const accountId = event.url.searchParams.get('account_id') || connection?.account_id || null
  if (!accountId) return jsonResponse({ success: true, account_id: null, connection: summary, choices: [], error: null })

  try {
    await requireIntegrationAccount(env, accountId, {
      userId: session.user.id, currentAccountId: connection?.account_id, providerId: 'facebook', scopes: [],
    })
    const pages = await listLinkedFacebookPages(env, accountId)
    return jsonResponse({
      success: true, account_id: accountId, connection: summary,
      choices: pages.map(page => ({ id: page.id, name: page.name })),
      error: pages.length ? null : 'That Facebook account manages no Pages. Connect the account that manages the business Page.',
    })
  } catch (error) {
    rethrowHttpError(error)
    console.error('facebook_pages_failed', { organizationId: organization.id, error })
    return jsonResponse({
      account_id: accountId, connection: summary, choices: [],
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
})
