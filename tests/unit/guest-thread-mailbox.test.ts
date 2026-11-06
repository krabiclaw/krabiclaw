import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveGuestThreadMailbox, type MailboxActivity } from '../../server/domain/guest-threads/mailbox.ts'

// inbox-parity.md, Revision 2026-11-06: Past is archived, or an ended
// occurrence with nothing unread and no guest message after it ended, or a
// contact with no message for 30 days.
const NOW = '2026-11-06T12:00:00.000Z'
const open = { archived_at: null, blocked_at: null }
const ended = { ends_at: '2026-11-01T00:00:00.000Z' }
const quiet: MailboxActivity = { unreadForViewer: false, lastGuestMessageAt: '2026-10-30T00:00:00.000Z', lastMessageAt: '2026-10-30T00:00:00.000Z' }

test('an ended occurrence is Past once it is read and the guest has not written since it ended', () => {
  assert.equal(resolveGuestThreadMailbox(open, ended, NOW, quiet).mailbox, 'past')
})

test('an unread alert or a guest message after the end keeps an ended conversation in Current', () => {
  assert.equal(resolveGuestThreadMailbox(open, ended, NOW, { ...quiet, unreadForViewer: true }).mailbox, 'current')
  const wroteAfter = resolveGuestThreadMailbox(open, ended, NOW, { ...quiet, lastGuestMessageAt: '2026-11-03T00:00:00.000Z' })
  assert.deepEqual([wroteAfter.mailbox, wroteAfter.canArchive], ['current', true])
})

test('an occurrence still ahead is Current', () => {
  assert.equal(resolveGuestThreadMailbox(open, { ends_at: '2026-11-09T00:00:00.000Z' }, NOW, quiet).mailbox, 'current')
})

test('a contact with no occurrence is Past after 30 days without a message, and Current before', () => {
  assert.equal(resolveGuestThreadMailbox(open, null, NOW, { ...quiet, lastMessageAt: '2026-10-06T11:59:00.000Z' }).mailbox, 'past')
  assert.equal(resolveGuestThreadMailbox(open, null, NOW, { ...quiet, lastMessageAt: '2026-10-08T00:00:00.000Z' }).mailbox, 'current')
})

test('archived is Past; it can be moved back only where the rule would not keep it Past', () => {
  const archived = { archived_at: '2026-11-05T00:00:00.000Z', blocked_at: null }
  const future = resolveGuestThreadMailbox(archived, { ends_at: '2026-11-09T00:00:00.000Z' }, NOW, quiet)
  assert.deepEqual([future.mailbox, future.canUnarchive, future.canArchive], ['past', true, false])
  assert.equal(resolveGuestThreadMailbox(archived, ended, NOW, quiet).canUnarchive, false)
})

test('a blocked guest is in Blocked whatever the rule says', () => {
  assert.equal(resolveGuestThreadMailbox({ archived_at: null, blocked_at: NOW }, ended, NOW, { ...quiet, unreadForViewer: true }).mailbox, 'blocked')
})
