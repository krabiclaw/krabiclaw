import { bookingEndsInstant, type GuestRequest, type ThreadOperationalRecord } from '~/server/domain/requests'

/**
 * Where a conversation lives in the inbox: Current or Past, the way Airbnb's
 * does, or Blocked once a member blocked the guest (inbox-parity.md,
 * Revision 2026-11-06).
 *
 * Past is derived, never stored. A conversation is Past for a member when they
 * archived it (archive is each person's own, D2; a new message from someone
 * else brings it back), or when it has been quiet for 30 days: nothing has
 * been written for 30 days and
 * the booking or stay it refers to (if any) ended at least 30
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
  /** When anything was last written in it, or its creation (conversations.last_message_at). */
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
  thread: Pick<GuestRequest, 'blocked_at'> & { /** When the viewer archived it. */ archived_at: string | null },
  record: Pick<ThreadOperationalRecord, 'ends_at'> | null,
  now: string,
  activity: MailboxActivity,
  audience: 'member' | 'buyer' = 'member',
): GuestThreadMailboxState {
  const manuallyArchived = audience === 'member' && thread.archived_at !== null
  const ended = record === null ? null : bookingEndsInstant(record.ends_at)
  const quietFrom = ended !== null && ended > activity.lastMessageAt ? ended : activity.lastMessageAt
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

/**
 * `resolveGuestThreadMailbox`'s `pastByRule`, said to the database for the
 * thread `gt` joined to its occurrence `op`.
 */
export function pastByRuleSql(now: string): { sql: string; params: string[] } {
  return {
    sql: `(MAX(gt.last_message_at, COALESCE(op.ends_at, '')) < ?)`,
    params: [quietSince(now)],
  }
}

/** Past: archived by the viewer (their participant row `me`), or past by the rule. Blocked conversations are filtered apart. */
export function pastSql(now: string): { sql: string; params: string[] } {
  const rule = pastByRuleSql(now)
  return { sql: `(me.archived_at IS NOT NULL OR ${rule.sql})`, params: rule.params }
}
