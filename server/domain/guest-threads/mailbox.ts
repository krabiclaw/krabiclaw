import type { GuestRequest, ThreadOperationalRecord } from '~/server/domain/requests'

/**
 * Where a conversation lives in the inbox: Current or Past, the way Airbnb's
 * does, or Blocked once a member blocked the guest.
 *
 * Past is derived, never stored. A thread is Past when a member archived it or
 * when the reservation or session it refers to has ENDED — not started: a
 * table booked 19:00–21:00 stays Current for the whole evening. A thread with
 * no occurrence (a direct message) is Current until someone archives it.
 *
 * This is the one statement of the rule. The list query's SQL predicate in
 * `repository.ts` says the same thing to the database, and every surface that
 * shows or changes a thread's mailbox reads this rather than its own dates.
 */
export type GuestThreadMailbox = 'current' | 'past' | 'blocked'

export interface GuestThreadMailboxState {
  mailbox: GuestThreadMailbox
  manuallyArchived: boolean
  occurrenceEnded: boolean
  canArchive: boolean
  canUnarchive: boolean
}

export function resolveGuestThreadMailbox(
  thread: Pick<GuestRequest, 'archived_at' | 'blocked_at'>,
  record: Pick<ThreadOperationalRecord, 'ends_at'> | null,
  now: string,
  audience: 'member'|'buyer' = 'member',
): GuestThreadMailboxState {
  const manuallyArchived = audience==='member' && thread.archived_at !== null
  const occurrenceEnded = record !== null && record.ends_at < now
  // The guest's own view never shows that the host blocked them.
  const blocked = audience==='member' && thread.blocked_at !== null
  const mailbox: GuestThreadMailbox = blocked ? 'blocked' : manuallyArchived || occurrenceEnded ? 'past' : 'current'
  return {
    mailbox,
    manuallyArchived,
    occurrenceEnded,
    canArchive: audience==='member' && mailbox === 'current',
    // An ended occurrence is Past by the clock; taking the archive flag off
    // would not bring it back, so it is not offered.
    canUnarchive: audience==='member' && !blocked && manuallyArchived && !occurrenceEnded,
  }
}
