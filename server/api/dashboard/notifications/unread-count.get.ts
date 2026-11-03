import { jsonResponse } from '~/server/utils/api-response'
import { getNotificationAccess } from '~/server/utils/notification-access'
import { unreadBuyerConversations, unreadNotifications, unreadTeamConversations } from '~/server/domain/unread'

/** What this scope has not read: its notifications, for the bell, and its conversations, for Messages. */
export default defineHandler(async (event) => {
  const access = await getNotificationAccess(event)
  const principal = { userId: access.userId, platformAdmin: access.platformAdmin, organization: access.organization }
  const [unread, team] = await Promise.all([
    unreadNotifications(access.db, principal),
    // A workspace's Messages lists its team; the person's own account lists their conversations as a guest.
    access.organization ? unreadTeamConversations(access.db, access.userId, access.organization.id) : unreadBuyerConversations(access.db, access.userId),
  ])
  return jsonResponse({ unread_count: unread.notifications, unread_conversations: unread.guestConversations + team })
})
import { defineHandler } from 'nitro';
