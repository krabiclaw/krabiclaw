import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { conversationRequest } from '~/server/utils/conversation-request'
import { parseTranscriptWindow } from '~/server/domain/conversations'
import { loadConversationPage, loadEarlierConversationEntries } from '~/server/domain/conversation-history'
import { conversationMemberPrincipal } from '~/server/utils/member-access'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  const { db, env, conversation, user, role, readThrough, membership } = await conversationRequest(event)
  const principal = membership ? conversationMemberPrincipal(membership, { env, event }) : null
  const viewer = { conversation, userId: user.id, role, principal, readThrough }
  const window = parseTranscriptWindow(event.url.searchParams)
  const page = window.before === null ? await loadConversationPage(db, viewer, window) : await loadEarlierConversationEntries(db, viewer, window)
  return jsonResponse(finalizeRequestMetrics(event, 'conversation-page', page), { headers: { 'cache-control': 'private, no-store' } })
})
