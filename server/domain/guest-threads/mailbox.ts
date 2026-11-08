import type { GuestRequest, ThreadOperationalRecord } from '~/server/domain/requests'
import { queryFirst, type DbClient } from '~/server/db'

/**
 * Where a conversation lives in the inbox: Current or Past, the way Airbnb's
 * does, or Blocked once a member blocked the guest (inbox-parity.md,
 * Revision 2026-11-06).
 *
 * Past is derived, never stored. A thread is Past when a member archived it,
 * or when it has been quiet for 30 days: nobody has written for 30 days and
 * the reservation, booking or stay it refers to (if any) ended at least 30
 * days ago. Airbnb keeps an ended, read trip in the main list the same way;
 * a new message brings a thread back to Current.
 *
 * This is the one statement of the rule. `pastSql` below says the same thing
 * to the database for the lists, and every surface that shows or changes a
 * thread's mailbox reads one of the two rather than its own dates.
 */
export type GuestThreadMailbox = 'current' | 'past' | 'blocked'

export const QUIET_DAYS = 30

/** What the rule reads beyond the thread and its record. */
export interface MailboxActivity {
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
  return new Date(Date.parse(now) - QUIET_DAYS * 86_400_000).toISOString()
}

export function resolveGuestThreadMailbox(
  thread: Pick<GuestRequest, 'archived_at' | 'blocked_at'>,
  record: Pick<ThreadOperationalRecord, 'ends_at'> | null,
  now: string,
  activity: MailboxActivity,
  audience: 'member' | 'buyer' = 'member',
): GuestThreadMailboxState {
  const manuallyArchived = audience === 'member' && thread.archived_at !== null
  const quietFrom = record !== null && record.ends_at > activity.lastMessageAt ? record.ends_at : activity.lastMessageAt
  const pastByRule = quietFrom < quietSince(now)
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

/** The activity the rule reads, for one thread. */
export async function readMailboxActivity(db: DbClient, threadId: string): Promise<MailboxActivity> {
  const row = await queryFirst<{ last_any: string | null; created_at: string }>(db, `
    SELECT (SELECT MAX(e.occurred_at) FROM activity_entries e WHERE e.request_id = gt.id AND e.kind IN ('message', 'submission')) AS last_any, gt.created_at
    FROM requests gt WHERE gt.id = ?`, [threadId])
  if (!row) throw new Error(`Conversation ${threadId} has no mailbox activity to read`)
  return { lastMessageAt: row.last_any ?? row.created_at }
}

/**
 * `resolveGuestThreadMailbox`'s `pastByRule`, said to the database for the
 * thread `gt` joined to its occurrence `op`.
 */
export function pastByRuleSql(now: string): { sql: string; params: string[] } {
  return {
    sql: `(MAX(COALESCE((SELECT MAX(e.occurred_at) FROM activity_entries e WHERE e.request_id = gt.id AND e.kind IN ('message', 'submission')), gt.created_at), COALESCE(op.ends_at, '')) < ?)`,
    params: [quietSince(now)],
  }
}

/** Past: archived, or past by the rule. Blocked threads are filtered apart. */
export function pastSql(now: string): { sql: string; params: string[] } {
  const rule = pastByRuleSql(now)
  return { sql: `(gt.archived_at IS NOT NULL OR ${rule.sql})`, params: rule.params }
}
