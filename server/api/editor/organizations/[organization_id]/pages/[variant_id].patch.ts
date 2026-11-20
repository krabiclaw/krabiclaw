import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { readTenantPageUpdate } from '~/server/utils/tenant-pages-api'
import { updateTenantPage } from '~/server/utils/content/pages'
import type { TenantPageEditorInput } from '~/server/utils/content/pages'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const variantId = getRouterParam(event, 'variant_id')
  if (!organizationId || !variantId) return jsonResponse({ error: 'Organization and page IDs are required' }, { status: 400 })
  const { env, db, userId, snapshot } = await readTenantPageUpdate(event, organizationId, variantId)
  const payload = await updateTenantPage(db, variantId, {
    userId, scope: { organizationId }, data: await readRequiredBody<TenantPageEditorInput>(event), env, snapshot, })
  return jsonResponse(payload)
})
import { defineHandler } from 'nitro';
import { getRouterParam  } from 'nitro/h3';
