import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarEvent, listWritableCalendars } from '../../server/utils/google-calendar.ts'
import { composeBuyerActivityUrl, composeOwnerThreadInboxUrl } from '../../server/utils/dashboard-notification-links.ts'

test('calendar selection paginates and only offers writer calendars with the narrow calendar-list boundary', async (t) => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))
    requests.push(url.href)
    assert.equal(url.pathname, '/calendar/v3/users/me/calendarList')
    assert.equal(url.searchParams.get('minAccessRole'), 'writer')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer linked-token')
    return Response.json(url.searchParams.has('pageToken')
      ? { items: [{ id: 'shared', summary: 'Shared calendar', accessRole: 'writer' }] }
      : { items: [{ id: 'mine', summary: 'Owned calendar', accessRole: 'owner' }, { id: 'readonly', summary: 'Read only', accessRole: 'reader' }], nextPageToken: 'next page' })
  })
  assert.deepEqual((await listWritableCalendars('linked-token')).map(item => item.id), ['mine', 'shared'])
  assert.equal(requests.length, 2)
})

test('reservation projection preserves canonical UTC instants and timezone without guest invitations', () => {
  for (const origin of ['http://localhost:3113', 'https://staging.krabiclaw.com']) {
    assert.equal(composeBuyerActivityUrl({ NUXT_PUBLIC_PLATFORM_DOMAIN: origin }, 'reservation', 'thread'), `${origin}/dashboard/account/activity/reservation/thread`)
    assert.equal(composeOwnerThreadInboxUrl({ NUXT_PUBLIC_PLATFORM_DOMAIN: origin }, { orgSlug: 'org', locationSlug: null }, 'thread'), `${origin}/dashboard/org/messages/thread`)
  }
  const event = calendarEvent({ booking_kind: 'reservation', operational_id: 'reservation', request_id: 'thread', buyer_user_id: 'buyer', status: 'confirmed', starts_at: '2099-01-01T12:00:00.000Z', ends_at: '2099-01-01T13:00:00.000Z', timezone: 'Asia/Bangkok', guest_name: 'Guest', member_name: null, is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, 'https://app.example/dashboard/account/activity/reservation/thread')
  assert.equal(event.summary, 'Reservation — Guest')
  assert.deepEqual(event.start, { dateTime: '2099-01-01T12:00:00.000Z', timeZone: 'Asia/Bangkok' })
  assert.equal('attendees' in event, false)
  assert.equal(event.description, 'Status: confirmed\nManage reservation: https://app.example/dashboard/account/activity/reservation/thread')
  const booking = calendarEvent({ booking_kind: 'booking', operational_id: 'booking', request_id: 'thread', buyer_user_id: 'buyer', status: 'confirmed', starts_at: '2099-01-01T12:00:00.000Z', ends_at: '2099-01-01T13:00:00.000Z', timezone: 'Asia/Bangkok', guest_name: 'Guest', member_name: 'Sam Rivera', is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, null)
  assert.equal(booking.description, 'Status: confirmed\nTeam member: Sam Rivera')
  assert.throws(() => calendarEvent({ booking_kind: 'booking', operational_id: 'booking', request_id: null, buyer_user_id: null, status: 'pending', starts_at: 'invalid', ends_at: 'invalid', timezone: 'Asia/Bangkok', guest_name: null, member_name: null, is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, 'https://app.example'))
})
