import { REQUEST_CURRENT_BUYER_SQL } from '~/server/domain/requests'
import { listThreadEntries, isBuyerVisibleThreadEntry } from '~/server/domain/guest-threads/entries'
import { d1JsonStringSet, execute, queryFirst, type DbClient } from '~/server/db'

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
    'n.parent_id IN (SELECT id FROM activity_entries WHERE request_id = ?)',
    [threadId],
  )
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
   AND ${REQUEST_CURRENT_BUYER_SQL}
   AND NOT EXISTS(SELECT 1 FROM activity_entries ack WHERE ack.kind='acknowledgement' AND ack.parent_id=e.id AND ack.actor_user_id=?)
  ON CONFLICT(dedupe_key) DO NOTHING`,[crypto.randomUUID(),userId,`buyer-read:${userId}:${threadId}:`,now,now,threadId,userId,d1JsonStringSet(visible),userId])
 return Number(result.meta.changes??0)
}
