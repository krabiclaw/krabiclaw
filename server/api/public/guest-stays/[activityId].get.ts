import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { readGuestStay } from '~/server/domain/stays'

/**
 * The guest's own stay on the business's site: the session that paid for it
 * on this site owns it, as the account owns it on the platform. Another
 * business's stay is not this site's to show.
 */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const activityId = getRouterParam(event, 'activityId')
  if (!organizationId || !activityId) throw new HTTPError({ statusCode: 404, statusMessage: 'Stay not found' })
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, statusMessage: 'Open your stay in the browser you booked it in, or in your account' })
  const guest = await readGuestStay(env.DB, session.user.id, activityId)
  if (guest.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, statusMessage: 'Stay not found' })
  return jsonResponse(guest, { headers: { 'cache-control': 'private, no-store' } })
})
