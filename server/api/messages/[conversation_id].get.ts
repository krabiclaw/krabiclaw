import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { conversationIdParam, messageSession } from '~/server/utils/conversation-request'
import { parseTranscriptWindow } from '~/server/domain/conversations'
import { loadConversationPage } from '~/server/domain/conversation-history'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  const { db, user } = await messageSession(event)
  const page = await loadConversationPage(db, { conversationId: conversationIdParam(event), userId: user.id }, parseTranscriptWindow(event.url.searchParams))
  return jsonResponse(finalizeRequestMetrics(event, 'conversation-page', page), { headers: { 'cache-control': 'private, no-store' } })
})
