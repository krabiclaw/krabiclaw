import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { buildNotificationVisibilityFilter, type NotificationVisibilityPrincipal } from '~/server/utils/notification-access'
import { hasPlatformUserPermission } from '~/server/utils/platform-admin-users'
import type { CloudflareEnv } from '~/server/utils/auth'

/**
 * What a person has not read in one scope: the notifications they can see, and
 * the guest conversations those notifications belong to. A guest conversation
 * is unread exactly while it has a notification its reader has not read, so it
 * is counted through them rather than again on its own.
 */
export async function unreadNotifications(db: DbClient, principal: NotificationVisibilityPrincipal): Promise<{ notifications: number; guestConversations: number }> {
  const filter = buildNotificationVisibilityFilter(principal)
  const row = await queryFirst<{ notifications: number; conversations: number }>(db, `
    SELECT COUNT(*) AS notifications, COUNT(DISTINCT r.id) AS conversations
    FROM activity_entries n
    LEFT JOIN activity_entries source ON source.id = n.parent_id
    LEFT JOIN requests r ON r.id = source.request_id AND r.kind IN ('contact', 'reservation', 'booking', 'stay')
    LEFT JOIN (SELECT parent_id, MAX(occurred_at) AS read_at FROM activity_entries WHERE kind = 'acknowledgement' AND actor_user_id = ? GROUP BY parent_id) nr ON nr.parent_id = n.id
    WHERE ${filter.whereSql} AND nr.read_at IS NULL
  `, [principal.userId, ...filter.whereParams])
  if (!row) throw new Error('Unread notifications could not be counted')
  return { notifications: Number(row.notifications), guestConversations: Number(row.conversations) }
}

/**
 * Team conversations with a message from someone else since this person last
 * read them. Team messages keep their own read state on the seat and raise no
 * notification, so they are counted here. Null counts every workspace.
 */
export async function unreadTeamConversations(db: DbClient, userId: string, organizationId: string | null): Promise<number> {
  const row = await queryFirst<{ count: number }>(db, `
    SELECT COUNT(*) AS count
    FROM team_thread_members s
    JOIN member m ON m.id = s.member_id AND m."organizationId" = s.organization_id AND m."userId" = ?
    WHERE ${organizationId ? 's.organization_id = ? AND ' : ''}EXISTS (
      SELECT 1 FROM team_messages tm
      WHERE tm.organization_id = s.organization_id AND tm.thread_id = s.thread_id AND tm.sender_user_id IS NOT ?
        AND (s.last_read_at IS NULL OR tm.created_at > s.last_read_at)
    )
  `, organizationId ? [userId, organizationId, userId] : [userId, userId])
  if (!row) throw new Error('Unread team conversations could not be counted')
  return Number(row.count)
}

/**
 * The app icon's number: everything a person has not read in every workspace
 * they belong to, and their own account's notifications.
 */
export async function unreadBadge(env: CloudflareEnv, db: DbClient, userId: string): Promise<number> {
  const [memberships, platformAdmin] = await Promise.all([
    queryAll<{ organizationId: string; role: string }>(db, 'SELECT "organizationId", role FROM member WHERE "userId" = ?', [userId]),
    // A platform administrator's own scope also lists the platform's notifications, as their bell does.
    hasPlatformUserPermission(env, userId, { platform: ['access'] }),
  ])
  const scopes = [null, ...memberships.map(membership => ({ id: membership.organizationId, role: membership.role }))]
  const [notifications, team] = await Promise.all([
    Promise.all(scopes.map(organization => unreadNotifications(db, { userId, platformAdmin: organization === null && platformAdmin, organization }))),
    unreadTeamConversations(db, userId, null),
  ])
  return notifications.reduce((sum, scope) => sum + scope.notifications, 0) + team
}
