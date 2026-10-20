// GET site settings
import { cloudflareEnv, jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'
import { loadSettingsPayload } from '~/server/utils/organization-settings'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')

  if (!organizationId) {
    return jsonResponse({
      error: 'Organization ID is required'
    }, { status: 400 })
  }

  const env = cloudflareEnv(event)
  const db = env.DB

  if (!db) {
    return jsonResponse({
      error: 'Database not available'
    }, { status: 500 })
  }

  const session = await getAuthSession(event, env)

  if (!session?.user?.id) {
    return jsonResponse({
      error: 'Authentication required'
    }, { status: 401 })
  }

  try {
    const organizationAccess = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
    if (!organizationAccess) {
      return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })
    }

    await assertOrganizationWideAccess(db, memberAccessPrincipal(organizationAccess.membership, { env, event }))

    const settings = await loadSettingsPayload(db, env, organizationAccess.id)
    return jsonResponse({ success: true, settings })

  } catch (error) {
    rethrowHttpError(error)
    console.error('Failed to get organization settings:', error)
    return jsonResponse({
      error: 'Failed to get organization settings'
    }, { status: 500 })
  }
})
