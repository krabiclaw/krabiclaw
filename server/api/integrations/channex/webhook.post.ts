import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { CHANNEX_WEBHOOK_CALLER, validateInternalRequest } from '~/server/utils/internal-secret'
import { applyBookingRevision } from '~/server/integrations/channex/booking-revisions'
import { CHANNEX_WEBHOOK_EVENTS } from '~/server/integrations/channex/webhooks'
import { mirrorChannexMessageEvent } from '~/server/domain/guest-threads/channel-messages'

/**
 * Channex's account webhook. A booking event's revision is landed and
 * acknowledged before this answers 200; anything short of that answers an
 * error, so Channex retries and the revision feed covers it. Messaging events
 * pull the current provider conversation and await its canonical ledger write.
 */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const validation = await validateInternalRequest(event, env, CHANNEX_WEBHOOK_CALLER)
  if (!validation.ok) return jsonResponse({ error: validation.error }, { status: validation.status })
  const body = await readBody<{ event?: unknown; payload?: { revision_id?: unknown } }>(event)
  // The events registered for this webhook (CHANNEX_WEBHOOK_EVENTS); anything else is ignored.
  if (!CHANNEX_WEBHOOK_EVENTS.some(name => name === body?.event)) return jsonResponse({ status: 'ignored', reason: 'unsupported_event' })
  if (body?.event !== 'booking') return jsonResponse(await mirrorChannexMessageEvent(env.DB, env, body))
  const revisionId = body.payload?.revision_id
  if (typeof revisionId !== 'string' || !revisionId) return jsonResponse({ error: 'A booking event needs payload.revision_id', code: 'VALIDATION_ERROR', field: 'payload.revision_id' }, { status: 400 })
  return jsonResponse(await applyBookingRevision(env.DB, env, revisionId))
})
