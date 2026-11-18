import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { searchPublicResources } from '~/server/utils/public-search'

// The dashboard's one search: a member's own business, plus the platform's
// guides and help answers. The tenant is
// the route's, resolved and checked against the member's access the way every
// dashboard read is; it is never a filter the client names on its own.
export default defineHandler(async (event) => {
  const q = typeof getQuery(event).q === 'string' ? String(getQuery(event).q).trim() : ''
  if (!q) return jsonResponse({ error: 'q is required' }, { status: 400 })

  const context = await getDashboardContext(event, {})
  if (!context.organization) return jsonResponse({ error: 'Not found or access denied' }, { status: 404 })
  await assertOrganizationWideAccess(context.db, memberAccessPrincipal(context.organization, { env: context.env }))

  const results = await searchPublicResources(context.db, q, { surface: 'dashboard', organizationId: context.organization.id, limit: 10 })
  return jsonResponse({ query: q, results })
})
import { defineHandler } from 'nitro';
import { getQuery } from 'nitro/h3';
