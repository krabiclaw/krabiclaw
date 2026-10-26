import { defineHandler } from 'nitro'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { pullCalendarChanges, resolveCalendarChannel } from '~/server/utils/google-calendar'

/**
 * Google's push notification for a business calendar. It carries no event
 * data, only "look now": the channel it names is matched to its organization
 * by the token Google echoes back, and the calendar's change list is read and
 * applied before this answers 200. A failure answers 500 so Google retries;
 * the five-minute task reads the same change list either way.
 */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const headers = event.req.headers
  const channelId = headers.get('x-goog-channel-id') ?? ''
  const token = headers.get('x-goog-channel-token') ?? ''
  const state = headers.get('x-goog-resource-state') ?? ''
  if (!channelId || !token) return jsonResponse({ error: 'Not a Google Calendar notification' }, { status: 400 })
  const organizationId = await resolveCalendarChannel(env.DB, channelId, token)
  // An unknown or stopped channel is answered, not retried: Google drops it once its expiry passes.
  if (!organizationId) return jsonResponse({ status: 'ignored', reason: 'unknown_channel' })
  if (state === 'sync') return jsonResponse({ status: 'ignored', reason: 'channel_opened' })
  return jsonResponse(await pullCalendarChanges(env, organizationId))
})
