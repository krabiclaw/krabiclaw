import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { advanceOrganizationSocialCardRefresh, regenerateOrganizationSocialCards } from '~/server/utils/social-card'
import { summarizeSocialCardRefreshResults } from '~/utils/social-card-refresh'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { env, db, session } = await requireOrganizationAccess(event, organizationId)
  const { after, refresh_id } = await readStrictBody<{ after?: string | null; refresh_id?: string }>(event, { after: 'nullable-string', refresh_id: 'string' })
  if (refresh_id !== undefined && (!refresh_id || after !== undefined)) {
    return jsonResponse({ error: 'Supply either a refresh ID or a cursor' }, { status: 400 })
  }
  const context = { db, env, organizationId, actorId: session.user.id }
  if (refresh_id) {
    const batch = await advanceOrganizationSocialCardRefresh({ ...context, id: refresh_id, retryFailed: true })
    if (batch.refresh?.id !== refresh_id) {
      return jsonResponse({ error: 'This social-card refresh was superseded by a newer rename' }, { status: 409 })
    }
    return jsonResponse({ ...batch, summary: summarizeSocialCardRefreshResults(batch.results) })
  }
  const batch = await regenerateOrganizationSocialCards({ ...context, after })
  return jsonResponse({ ...batch, summary: summarizeSocialCardRefreshResults(batch.results) })
})
