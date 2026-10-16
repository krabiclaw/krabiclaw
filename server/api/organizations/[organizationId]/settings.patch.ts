// PATCH update site settings
import { jsonResponse } from '~/server/utils/api-response'
import { isDemoOrganization } from '~/shared/demo'
import { updateOrganizationSettingsFields } from '~/server/utils/organization-settings'
import type { UpdateOrganizationSettingsRequest } from '~/server/types/organization'
import { defineHandler } from 'nitro'
import {  getRouterParam, readBody } from 'nitro/h3';
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const body = await readBody(event) as UpdateOrganizationSettingsRequest
  if (!organizationId) {
    return jsonResponse({ 
      error: 'Organization ID is required' 
    }, { status: 400 })
  }

  if (Object.keys(body).length === 0) {
    return jsonResponse({ 
      error: 'No update fields provided' 
    }, { status: 400 })
  }

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)


  try {
    // Demo org is read-only for everyone except platform admins
    const isPlatformAdmin = await hasPlatformEventPermission(event, env, { platform: ['access'] })
    if (isDemoOrganization(organization) && !isPlatformAdmin) {
      return jsonResponse({ error: 'Demo organization is read-only' }, { status: 403 })
    }

    const result = await updateOrganizationSettingsFields(
      db, env, organization.id, body, session.user.id
    )

    return jsonResponse(result.data, { status: result.status })
    
  } catch (error) {
    console.error('Failed to update organization settings:', error)
    return jsonResponse({ 
      error: 'Failed to update organization settings' 
    }, { status: 500 })
  }
})
