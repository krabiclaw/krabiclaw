import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { conversationIdParam, messageSession } from '~/server/utils/conversation-request'
import { parseTranscriptWindow } from '~/server/domain/conversations'
import { loadConversationPage } from '~/server/domain/conversation-history'
import { finalizeRequestMetrics, markTranscriptHandlerEntry, timeTranscriptPhase } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  markTranscriptHandlerEntry(event)
  const { db, user } = await timeTranscriptPhase(event, 'message_session', () => messageSession(event))
  const page = await timeTranscriptPhase(event, 'transcript', () =>
    loadConversationPage(db, { conversationId: conversationIdParam(event), userId: user.id }, parseTranscriptWindow(event.url.searchParams)),
  )
  return jsonResponse(finalizeRequestMetrics(event, 'conversation-page', page), { headers: { 'cache-control': 'private, no-store' } })
})
