import { jsonResponse } from '~/server/utils/api-response'
import { getNotificationAccess } from '~/server/utils/notification-access'
import { unreadNotifications, unreadTeamConversations } from '~/server/domain/unread'

/** What this scope has not read: its notifications, for the bell, and its conversations, for Messages. */
export default defineHandler(async (event) => {
  const access = await getNotificationAccess(event)
  const principal = { userId: access.userId, platformAdmin: access.platformAdmin, organization: access.organization }
  const [unread, team] = await Promise.all([
    unreadNotifications(access.db, principal),
    access.organization ? unreadTeamConversations(access.db, access.userId, access.organization.id) : Promise.resolve(0),
  ])
  return jsonResponse({ unread_count: unread.notifications, unread_conversations: unread.guestConversations + team })
})
import { defineHandler } from 'nitro';
