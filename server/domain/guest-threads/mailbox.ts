import { CONVERSATION_NOTIFICATION_SQL } from '~/server/utils/notification-center'
import type { GuestRequest, ThreadOperationalRecord } from '~/server/domain/requests'
import { queryFirst, type DbClient } from '~/server/db'

/**
 * Where a conversation lives in the inbox: Current or Past, the way Airbnb's
 * does, or Blocked once a member blocked the guest (inbox-parity.md,
 * Revision 2026-11-06).
 *
 * Past is derived, never stored. A thread is Past when a member archived it;
 * or when the reservation, booking or stay it refers to has ENDED and it has
 * nothing unread for the viewer and no guest message after it ended; or, with
 * no occurrence at all (a contact message), after 30 days without a message.
 * A new guest message, or an alert the viewer has not read, brings an ended
 * thread back to Current.
 *
 * This is the one statement of the rule. `pastSql` below says the same thing
 * to the database for the lists, and every surface that shows or changes a
 * thread's mailbox reads one of the two rather than its own dates.
 */
export type GuestThreadMailbox = 'current' | 'past' | 'blocked'

export const QUIET_CONTACT_DAYS = 30

/** What the rule reads beyond the thread and its record. */
export interface MailboxActivity {
  /** An alert on this thread the viewer has not read. */
  unreadForViewer: boolean
  /** When the guest last wrote, or null. */
  lastGuestMessageAt: string | null
  /** When anyone last wrote (a submission counts), or the thread's creation. */
  lastMessageAt: string
}

export interface GuestThreadMailboxState {
  mailbox: GuestThreadMailbox
  manuallyArchived: boolean
  /** Past by the rule alone, whether or not it is archived. */
  pastByRule: boolean
  canArchive: boolean
  canUnarchive: boolean
}

function quietSince(now: string): string {
  return new Date(Date.parse(now) - QUIET_CONTACT_DAYS * 86_400_000).toISOString()
}

export function resolveGuestThreadMailbox(
  thread: Pick<GuestRequest, 'archived_at' | 'blocked_at'>,
  record: Pick<ThreadOperationalRecord, 'ends_at'> | null,
  now: string,
  activity: MailboxActivity,
  audience: 'member' | 'buyer' = 'member',
): GuestThreadMailboxState {
  const manuallyArchived = audience === 'member' && thread.archived_at !== null
  const pastByRule = record !== null
    ? record.ends_at < now && !activity.unreadForViewer && !(activity.lastGuestMessageAt !== null && activity.lastGuestMessageAt > record.ends_at)
    : activity.lastMessageAt < quietSince(now)
  // The guest's own view never shows that the host blocked them.
  const blocked = audience === 'member' && thread.blocked_at !== null
  const mailbox: GuestThreadMailbox = blocked ? 'blocked' : manuallyArchived || pastByRule ? 'past' : 'current'
  return {
    mailbox,
    manuallyArchived,
    pastByRule,
    canArchive: audience === 'member' && mailbox === 'current',
    // Taking the archive flag off a thread the rule keeps in Past would not bring it back, so it is not offered.
    canUnarchive: audience === 'member' && !blocked && manuallyArchived && !pastByRule,
  }
}

/** The activity the rule reads, for one thread and one viewer (null: no viewer's alerts count). */
export async function readMailboxActivity(db: DbClient, threadId: string, viewerUserId: string | null): Promise<MailboxActivity> {
  const row = await queryFirst<{ unread: number; last_guest: string | null; last_any: string | null; created_at: string }>(db, `
    SELECT ${viewerUserId === null ? '0' : UNREAD_FOR_VIEWER_SQL} AS unread,
      (SELECT MAX(e.occurred_at) FROM activity_entries e WHERE e.request_id = gt.id AND e.kind = 'message' AND e.actor_kind = 'guest') AS last_guest,
      (SELECT MAX(e.occurred_at) FROM activity_entries e WHERE e.request_id = gt.id AND e.kind IN ('message', 'submission')) AS last_any,
      gt.created_at
    FROM requests gt WHERE gt.id = ?`, viewerUserId === null ? [threadId] : [viewerUserId, viewerUserId, threadId])
  if (!row) throw new Error(`Conversation ${threadId} has no mailbox activity to read`)
  return { unreadForViewer: row.unread === 1, lastGuestMessageAt: row.last_guest, lastMessageAt: row.last_any ?? row.created_at }
}

/** An alert on the thread `gt` that the viewer (two `?`: the viewer's user id twice) has not read. */
export const UNREAD_FOR_VIEWER_SQL = `EXISTS (
        SELECT 1 FROM activity_entries n
        JOIN activity_entries notification_entry ON notification_entry.id = n.parent_id
        LEFT JOIN activity_entries nr ON nr.parent_id = n.id AND nr.actor_user_id = ? AND nr.kind = 'acknowledgement'
        WHERE notification_entry.request_id = gt.id
          AND (n.target_user_id IS NULL OR n.target_user_id = ?)
          AND nr.id IS NULL AND n.kind = 'notification' AND ${CONVERSATION_NOTIFICATION_SQL}
      )`

/**
 * `resolveGuestThreadMailbox`'s `pastByRule`, said to the database for the
 * thread `gt` joined to its occurrence `op`.
 */
export function pastByRuleSql(now: string, viewerUserId: string): { sql: string; params: string[] } {
  return {
    sql: `((op.ends_at IS NOT NULL AND op.ends_at < ? AND NOT ${UNREAD_FOR_VIEWER_SQL}
        AND NOT EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = gt.id AND e.kind = 'message' AND e.actor_kind = 'guest' AND e.occurred_at > op.ends_at))
      OR (op.ends_at IS NULL AND COALESCE((SELECT MAX(e.occurred_at) FROM activity_entries e WHERE e.request_id = gt.id AND e.kind IN ('message', 'submission')), gt.created_at) < ?))`,
    params: [now, viewerUserId, viewerUserId, quietSince(now)],
  }
}

/** Past: archived, or past by the rule. Blocked threads are filtered apart. */
export function pastSql(now: string, viewerUserId: string): { sql: string; params: string[] } {
  const rule = pastByRuleSql(now, viewerUserId)
  return { sql: `(gt.archived_at IS NOT NULL OR ${rule.sql})`, params: rule.params }
}
