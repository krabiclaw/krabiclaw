import { listThreadEntries, isBuyerVisibleThreadEntry } from '~/server/domain/guest-threads/entries'
import { d1JsonStringSet, execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { CONVERSATION_NOTIFICATION_SQL, SCHEDULE_NOTIFICATION_SQL } from '~/server/utils/notification-center'
import { buildNotificationVisibilityFilter } from '~/server/utils/notification-access'
import { publishNotificationInvalidation } from '~/server/cloudflare/guest-inbox-events'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { HTTPError } from 'nitro'

interface NotificationVisibility {
  userId: string
  whereSql: string
  whereParams: unknown[]
}

// A member acknowledges a notification once. Counting only new acknowledgements
// is what lets a caller publish "read" only when something became read: a
// thread read re-acknowledging everything published on every read, and the app,
// which reloads on that event, read the thread again in a loop.
async function acknowledgeVisibleNotifications(
  db: DbClient,
  visibility: NotificationVisibility,
  selectionSql: string,
  selectionParams: unknown[],
): Promise<number> {
  const command = crypto.randomUUID()
  const now = new Date().toISOString()
  const result = await execute(db, `
    INSERT INTO activity_entries (id, kind, scope_kind, organization_id, location_id, parent_id, actor_kind, actor_user_id, dedupe_key, occurred_at, created_at)
    SELECT ? || ':' || n.id, 'acknowledgement', n.scope_kind, n.organization_id, n.location_id, n.id, 'member', ?, ? || ':' || n.id, ?, ?
    FROM activity_entries n WHERE n.kind = 'notification' AND ${selectionSql} AND ${visibility.whereSql}
      AND NOT EXISTS (SELECT 1 FROM activity_entries ack WHERE ack.kind = 'acknowledgement' AND ack.parent_id = n.id AND ack.actor_user_id = ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `, [command, visibility.userId, `ack:${command}`, now, now, ...selectionParams, ...visibility.whereParams, visibility.userId])
  return Number(result?.meta?.changes ?? 0)
}

/** `null` when the caller cannot see the notification; otherwise whether this call newly read it. */
export async function acknowledgeNotification(
  db: DbClient,
  visibility: NotificationVisibility,
  notificationId: string,
): Promise<{ newlyRead: boolean } | null> {
  if (await acknowledgeVisibleNotifications(db, visibility, 'n.id = ?', [notificationId]) > 0) return { newlyRead: true }
  const visible = await queryFirst<{ id: string }>(db,
    `SELECT n.id FROM activity_entries n WHERE n.kind = 'notification' AND n.id = ? AND ${visibility.whereSql}`,
    [notificationId, ...visibility.whereParams])
  return visible ? { newlyRead: false } : null
}

export async function acknowledgeAllNotifications(
  db: DbClient,
  visibility: NotificationVisibility,
): Promise<number> {
  return await acknowledgeVisibleNotifications(db, visibility, '1 = 1', [])
}

export async function acknowledgeThreadNotifications(
  db: DbClient,
  visibility: NotificationVisibility,
  threadId: string,
): Promise<number> {
  return await acknowledgeVisibleNotifications(
    db,
    visibility,
    `${CONVERSATION_NOTIFICATION_SQL} AND n.parent_id IN (SELECT id FROM activity_entries WHERE request_id = ?)`,
    [threadId],
  )
}

/**
 * Mark a conversation unread for this member: their acknowledgement of its
 * newest alert is withdrawn, which is exactly what the unread dot reads. Opening
 * the conversation or marking it read acknowledges the alert again.
 * `false` when the conversation has no alert this member can see: nothing in it
 * was ever unread for them, so there is nothing to make unread again.
 */
export async function unacknowledgeThreadNotifications(
  db: DbClient,
  visibility: NotificationVisibility,
  threadId: string,
): Promise<boolean> {
  const newest = await queryFirst<{ id: string }>(db, `
    SELECT n.id FROM activity_entries n
     WHERE n.kind = 'notification' AND ${CONVERSATION_NOTIFICATION_SQL}
       AND n.parent_id IN (SELECT id FROM activity_entries WHERE request_id = ?) AND ${visibility.whereSql}
     ORDER BY n.created_at DESC, n.id DESC LIMIT 1`, [threadId, ...visibility.whereParams])
  if (!newest) return false
  await execute(db, "DELETE FROM activity_entries WHERE kind = 'acknowledgement' AND parent_id = ? AND actor_user_id = ?", [newest.id, visibility.userId])
  return true
}

/**
 * Mark one conversation read or unread for the member, from the Messages list
 * (a swipe, a row's menu) or MCP, without opening it. The caller has checked the
 * member may see the conversation. Their other apps and tabs re-read their
 * counts and list on `notification.read`, the reader-only event every client
 * already answers that way.
 */
export async function setConversationRead(
  principal: MemberAccessPrincipal,
  db: DbClient,
  thread: { id: string; organization_id: string; location_id: string | null },
  read: boolean,
): Promise<{ unread: boolean }> {
  const visibility = {
    userId: principal.userId,
    ...buildNotificationVisibilityFilter({ userId: principal.userId, platformAdmin: false, organization: { id: principal.organizationId, role: principal.role } }),
  }
  const changed = read
    ? await acknowledgeThreadNotifications(db, visibility, thread.id) > 0
    : await unacknowledgeThreadNotifications(db, visibility, thread.id)
  if (!read && !changed) {
    throw new HTTPError({ statusCode: 409, message: 'Nothing in this conversation has alerted you, so it cannot be marked unread', data: { code: 'NO_CONVERSATION_ALERT', field: 'threadId' } })
  }
  if (changed) {
    await publishNotificationInvalidation(principal.env, { type: 'notification.read', organizationId: thread.organization_id, locationId: thread.location_id, targetUserId: principal.userId })
  }
  return { unread: !read }
}

/** Snapshot before loading the detail so later changes cannot be cleared by this visit. */
export async function unreadScheduleNotificationIds(
  db: DbClient,
  visibility: NotificationVisibility,
  kind: 'stay' | 'reservation' | 'booking',
  id: string,
): Promise<string[]> {
  const recordMatch = kind === 'stay'
    ? `(json_extract(n.payload_json, '$.stay_id') = ?
        OR EXISTS (SELECT 1 FROM stays s JOIN activity_entries source ON source.request_id = s.request_id
          WHERE s.id = ? AND s.organization_id = n.organization_id AND source.id = n.parent_id)
        OR substr(json_extract(n.payload_json, '$.deep_link'), -length(?)) = ?)`
    : `EXISTS (SELECT 1 FROM requests r WHERE r.id = json_extract(n.payload_json, '$.thread_id')
          AND r.organization_id = n.organization_id AND r.id = ? AND r.kind = ?)`
  const stayPath = `/bookings/stay/${encodeURIComponent(id)}`
  const params = kind === 'stay' ? [id, id, stayPath, stayPath] : [id, kind]
  const rows = await queryAll<{ id: string }>(db, `
    SELECT n.id FROM activity_entries n
    WHERE ${visibility.whereSql} AND ${SCHEDULE_NOTIFICATION_SQL} AND ${recordMatch}
      AND NOT EXISTS (SELECT 1 FROM activity_entries ack
        WHERE ack.kind = 'acknowledgement' AND ack.parent_id = n.id AND ack.actor_user_id = ?)
  `, [...visibility.whereParams, ...params, visibility.userId])
  return rows.map(row => row.id)
}

/** Opening a task reads the alerts that sent its people to it. */
export async function acknowledgeTaskNotifications(db: DbClient, userId: string, organizationId: string, taskId: string): Promise<number> {
  return await acknowledgeVisibleNotifications(db, { userId, whereSql: 'n.organization_id = ? AND n.target_user_id = ?', whereParams: [organizationId, userId] },
    "n.event_name IN ('task_assigned', 'task_starting') AND json_extract(n.payload_json, '$.deep_link') LIKE ?", [`%?task=${encodeURIComponent(taskId)}`])
}

/** Explicit buyer read receipt on existing public conversation facts, scoped to the current owner. */
export async function acknowledgeBuyerThreadEntries(db:DbClient,userId:string,threadId:string,entryIds:string[]):Promise<number> {
 const visible=(await listThreadEntries(db,threadId)).filter(isBuyerVisibleThreadEntry).filter(entry=>entryIds.includes(entry.id)).map(entry=>entry.id)
 if(!visible.length)return 0
 const now=new Date().toISOString()
 const result=await execute(db,`INSERT INTO activity_entries (id,kind,scope_kind,request_id,parent_id,actor_kind,actor_user_id,dedupe_key,occurred_at,created_at)
  SELECT ? || ':' || e.id, 'acknowledgement','request',e.request_id,e.id,'guest',?,? || e.id,?,?
  FROM activity_entries e JOIN requests r ON r.id=e.request_id
  WHERE e.request_id=? AND r.user_id=? AND e.id IN (SELECT value FROM json_each(?))
   AND NOT EXISTS(SELECT 1 FROM activity_entries ack WHERE ack.kind='acknowledgement' AND ack.parent_id=e.id AND ack.actor_user_id=?)
  ON CONFLICT(dedupe_key) DO NOTHING`,[crypto.randomUUID(),userId,`buyer-read:${userId}:${threadId}:`,now,now,threadId,userId,d1JsonStringSet(visible),userId])
 return Number(result.meta.changes??0)
}
