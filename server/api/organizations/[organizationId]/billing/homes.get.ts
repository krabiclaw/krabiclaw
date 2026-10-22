import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { homesQuote, parseHomesAdding } from '~/server/utils/billing'
import { requireOrganizationAccess } from '~/server/utils/location-access'

// What adding homes costs on this organization's plan, before they are added:
// the dashboard's home pages and the iOS import review ask here, and the
// answer is the same rule the write then applies.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const adding = parseHomesAdding(getQuery(event).adding)
  const { env, db } = await requireOrganizationAccess(event, organizationId)
  return jsonResponse(await homesQuote(env, db, organizationId, adding))
})
