import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { scheduleGuestReply } from '~/server/domain/scheduled-guest-messages'
import { messageText } from '~/server/domain/guest-message-schedule'
import { parseSuggestionUse, recordSuggestionAccepted, suggestedDraft } from '~/server/domain/suggested-reply'

/** Put the caller's own reply in the outbox for this conversation: { body, due_at, suggestion? }. A scheduled draft is a used draft, metered when it is scheduled. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const threadId = messageText(getRouterParam(event, 'conversation_id'), 'conversation_id', 200)
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const body = await readBody<{ body?: unknown; due_at?: unknown; suggestion?: unknown } | null>(event)
  const use = parseSuggestionUse(body?.suggestion)
  const draft = use ? await suggestedDraft(db, { organizationId, threadId, suggestion: use }) : null
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  const message = await scheduleGuestReply(db, principal, threadId, { body: body?.body, due_at: body?.due_at })
  if (draft) await recordSuggestionAccepted(db, { organizationId, threadId, userId: principal.userId, body: message.body, draft })
  return jsonResponse({ message }, { status: 201 })
})
