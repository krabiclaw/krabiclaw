import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireTenantPageWriteAccess } from '~/server/utils/tenant-pages-api'
import { createTenantPage } from '~/server/utils/content/pages'
import type { TenantPageEditorInput } from '~/server/utils/content/pages'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { env, db, userId } = await requireTenantPageWriteAccess(event, organizationId)
  const body = await readRequiredBody<TenantPageEditorInput>(event)
  return jsonResponse(await createTenantPage(db, {
    organizationId, userId, data: body, env, }), { status: 201 })
})
import { defineHandler } from 'nitro';
import { getRouterParam  } from 'nitro/h3';
