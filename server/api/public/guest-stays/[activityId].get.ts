import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { readGuestStay } from '~/server/domain/stays'
import { createReplayableReservationCancelToken, hashReservationCancelToken, readBearerToken, TOKEN_TTL_DAYS } from '~/server/utils/reservation-cancel-token'
import { buildBuyerRequestActivityUrl } from '~/server/utils/dashboard-notification-links'

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
  const expected = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', activityId)
  if (await hashReservationCancelToken(token) !== await hashReservationCancelToken(expected.token)) throw new HTTPError({ statusCode: 404, statusMessage: 'Stay not found' })
  const owner = await queryFirst<{ user_id: string | null; created_at: string }>(env.DB, "SELECT user_id, created_at FROM stays WHERE organization_id = ? AND COALESCE(request_id, id) = ? AND owner = 'app'", [organizationId, activityId])
  if (!owner?.user_id) throw new HTTPError({ statusCode: 404, statusMessage: 'Stay not found' })
  // The link lasts as a booking's does, from when the stay was booked.
  if (Date.parse(owner.created_at) + TOKEN_TTL_DAYS * 86_400_000 <= Date.now()) throw new HTTPError({ statusCode: 410, statusMessage: 'This link has expired. Your stay is in your KrabiClaw account once you create one with the email you booked with.' })
  const guest = await readGuestStay(env.DB, owner.user_id, activityId)
  const manageUrl = guest.stay.request_id
    ? await buildBuyerRequestActivityUrl(env, env.DB, { organizationId, threadId: guest.stay.request_id }) : null
  return jsonResponse({ ...guest, manage_url: manageUrl }, { headers: { 'cache-control': 'private, no-store' } })
})
