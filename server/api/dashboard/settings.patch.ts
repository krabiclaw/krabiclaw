// Direct dashboard settings update handler.
// Avoids the generic dashboard proxy hop for this request path.
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { isDemoOrganization } from '~/shared/demo'
import { updateOrganizationSettingsFields } from '~/server/utils/organization-settings'
import type { UpdateOrganizationSettingsRequest } from '~/server/types/organization'
import { defineHandler } from 'nitro'
import {  readBody } from 'nitro/h3';
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'

export default defineHandler(async (event) => {
  const body = await readBody(event) as UpdateOrganizationSettingsRequest

  if (typeof body !== 'object' || body === null || Object.keys(body).length === 0) {
    return jsonResponse(
      { error: 'No update fields provided' }, { status: 400 }, )
  }

  const { env, db, session, organization } = await getDashboardContext(event)

  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))


  try {
    const isPlatformAdmin = await hasPlatformEventPermission(event, env, { platform: ['access'] })
    if (isDemoOrganization(organization) && !isPlatformAdmin) {
      return jsonResponse({ error: 'Demo organization is read-only' }, { status: 403 })
    }

    const result = await updateOrganizationSettingsFields(
      db, env, organization.id, body, session.user.id, )

    return jsonResponse(result.data, { status: result.status })
  } catch (error) {
    console.error('Failed to update organization settings:', error)
    return jsonResponse(
      { error: 'Failed to update organization settings' }, { status: 500 }, )
  }
})
