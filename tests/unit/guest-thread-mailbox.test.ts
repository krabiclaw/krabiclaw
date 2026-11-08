import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveGuestThreadMailbox, type MailboxActivity } from '../../server/domain/guest-threads/mailbox.ts'

// Past is archived, or quiet for 30 days: no message for 30 days and any
// stay, booking or reservation ended at least 30 days ago. Airbnb keeps an
// ended, read trip in the main list the same way.
const NOW = '2026-11-06T12:00:00.000Z'
const open = { archived_at: null, blocked_at: null }
const ended = { ends_at: '2026-11-01T00:00:00.000Z' }
const quiet: MailboxActivity = { lastMessageAt: '2026-09-01T00:00:00.000Z' }

test('an ended, read booking stays in Current until it has been quiet for 30 days', () => {
  assert.equal(resolveGuestThreadMailbox(open, ended, NOW, quiet).mailbox, 'current')
  assert.equal(resolveGuestThreadMailbox(open, { ends_at: '2026-10-07T12:00:00.000Z' }, NOW, quiet).mailbox, 'current')
  assert.deepEqual(resolveGuestThreadMailbox(open, { ends_at: '2026-10-06T11:59:00.000Z' }, NOW, quiet), {
    mailbox: 'past', manuallyArchived: false, pastByRule: true, canArchive: false, canUnarchive: false,
  })
})

test('a message in the last 30 days keeps a long-ended booking in Current', () => {
  assert.equal(resolveGuestThreadMailbox(open, { ends_at: '2026-08-01T00:00:00.000Z' }, NOW, { lastMessageAt: '2026-10-20T00:00:00.000Z' }).mailbox, 'current')
})

test('a future booking with no recent message is Current', () => {
  assert.equal(resolveGuestThreadMailbox(open, { ends_at: '2026-12-09T00:00:00.000Z' }, NOW, quiet).mailbox, 'current')
})

test('a contact with no occurrence is Past after 30 days without a message, and Current before', () => {
  assert.equal(resolveGuestThreadMailbox(open, null, NOW, { lastMessageAt: '2026-10-06T11:59:00.000Z' }).mailbox, 'past')
  assert.equal(resolveGuestThreadMailbox(open, null, NOW, { lastMessageAt: '2026-10-08T00:00:00.000Z' }).mailbox, 'current')
})

test('archived is Past; it can be moved back only where the rule would not keep it Past', () => {
  const archived = { archived_at: '2026-11-05T00:00:00.000Z', blocked_at: null }
  const recent = resolveGuestThreadMailbox(archived, ended, NOW, quiet)
  assert.deepEqual([recent.mailbox, recent.canUnarchive, recent.canArchive], ['past', true, false])
  assert.equal(resolveGuestThreadMailbox(archived, { ends_at: '2026-09-01T00:00:00.000Z' }, NOW, quiet).canUnarchive, false)
})

test('a blocked guest is in Blocked whatever the rule says; the guest never sees it', () => {
  const blocked = { archived_at: null, blocked_at: NOW }
  assert.equal(resolveGuestThreadMailbox(blocked, ended, NOW, quiet).mailbox, 'blocked')
  assert.equal(resolveGuestThreadMailbox(blocked, { ends_at: '2026-11-09T00:00:00.000Z' }, NOW, quiet, 'buyer').mailbox, 'current')
})
