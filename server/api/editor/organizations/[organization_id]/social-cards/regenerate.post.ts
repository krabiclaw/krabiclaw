import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { regenerateOrganizationSocialCards } from '~/server/utils/social-card'
import { summarizeSocialCardRefreshResults } from '~/utils/social-card-refresh'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { env, db, session } = await requireOrganizationAccess(event, organizationId)
  const { after } = await readStrictBody<{ after?: string | null }>(event, { after: 'nullable-string' })
  const { results, next_cursor } = await regenerateOrganizationSocialCards({ db, env, organizationId, actorId: session.user.id, after })
  return jsonResponse({ results, next_cursor, summary: summarizeSocialCardRefreshResults(results) })
})
