import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { readGuestStay } from '~/server/domain/stays'
import { readBearerToken } from '~/server/utils/reservation-cancel-token'
import { verifyStayReceiptToken } from '~/server/utils/stay-receipt-token'

/**
 * The guest's own stay on the business's site, opened as a booking's receipt
 * is: by the link its confirmation carries, from any browser. The link names
 * the stay and signs it; the stay is read as its owner reads it.
 */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const activityId = getRouterParam(event, 'activityId')
  if (!organizationId || !activityId) throw new HTTPError({ statusCode: 404, statusMessage: 'Stay not found' })
  const token = readBearerToken(event.req.headers.get('authorization'))
  if (!token) throw new HTTPError({ statusCode: 401, statusMessage: 'Open your stay from the link in your confirmation email' })
  const env = cloudflareEnv(event)
  if (!await verifyStayReceiptToken(env.EMAIL_REPLY_SECRET ?? '', activityId, token)) throw new HTTPError({ statusCode: 404, statusMessage: 'Stay not found' })
  const owner = await queryFirst<{ user_id: string | null }>(env.DB, "SELECT user_id FROM stays WHERE organization_id = ? AND COALESCE(request_id, id) = ? AND owner = 'app'", [organizationId, activityId])
  if (!owner?.user_id) throw new HTTPError({ statusCode: 404, statusMessage: 'Stay not found' })
  return jsonResponse(await readGuestStay(env.DB, owner.user_id, activityId), { headers: { 'cache-control': 'private, no-store' } })
})
