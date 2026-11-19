import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { readGuestUnreadCount, readWorkspaceUnreadCounts } from '~/server/domain/guest-threads/repository'
import { jsonResponse } from '~/server/utils/api-response'
import { messageSession } from '~/server/utils/conversation-request'

export default defineHandler(async event => {
  const { organization_id: organizationId } = getQuery(event)
  if (organizationId !== undefined && (typeof organizationId !== 'string' || !organizationId.trim())) {
    throw new HTTPError({ statusCode: 400, message: 'Invalid workspace', data: { code: 'INVALID_ORGANIZATION', field: 'organization_id' } })
  }
  const { db, user } = await messageSession(event)
  return organizationId === undefined
    ? jsonResponse({ count: await readGuestUnreadCount(db, user.id) })
    : jsonResponse({ unread: await readWorkspaceUnreadCounts(db, organizationId, user.id) })
})
