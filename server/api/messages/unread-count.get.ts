import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { messageSession } from '~/server/utils/conversation-request'
import { loadOrganizationConversationUnread } from '~/server/utils/dashboard-guest-threads'
import { countUnreadAsGuest } from '~/server/domain/guest-threads/repository'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  const { organization_id: organizationId } = getQuery(event)
  if (organizationId !== undefined) {
    if (typeof organizationId !== 'string' || !organizationId.trim()) throw new HTTPError({ statusCode: 400, message: 'Invalid workspace', data: { code: 'INVALID_ORGANIZATION', field: 'organization_id' } })
    const unread = await loadOrganizationConversationUnread(event, organizationId)
    return jsonResponse(finalizeRequestMetrics(event, 'messages-unread-count', { unread }))
  }
  const { db, user } = await messageSession(event)
  return jsonResponse(finalizeRequestMetrics(event, 'messages-unread-count', { count: await countUnreadAsGuest(db, user.id) }))
})
