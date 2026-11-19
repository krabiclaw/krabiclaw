import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarEvent } from '../../server/utils/google-calendar.ts'
import { composeBuyerActivityUrl, composeOwnerThreadInboxUrl } from '../../server/utils/dashboard-notification-links.ts'

test('a table booking projects as a reservation, preserving canonical UTC instants and timezone without guest invitations', () => {
  for (const origin of ['http://localhost:3113', 'https://staging.blawby.com']) {
    assert.equal(composeBuyerActivityUrl({ NUXT_PUBLIC_PLATFORM_DOMAIN: origin }, 'booking', 'thread'), `${origin}/dashboard/account/messages/thread/reservation`)
    assert.equal(composeOwnerThreadInboxUrl({ NUXT_PUBLIC_PLATFORM_DOMAIN: origin }, { orgSlug: 'org', locationSlug: null }, 'thread'), `${origin}/dashboard/org/messages/thread`)
  }
  const event = calendarEvent({ booking_id: 'table-booking', product_kind: 'table', request_id: 'thread', buyer_user_id: 'buyer', status: 'confirmed', starts_at: '2099-01-01T12:00:00.000Z', ends_at: '2099-01-01T13:00:00.000Z', timezone: 'Asia/Bangkok', guest_name: 'Guest', member_name: null, is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, 'https://app.example/dashboard/account/messages/thread/reservation')
  assert.equal(event.summary, 'Reservation — Guest')
  assert.deepEqual(event.start, { dateTime: '2099-01-01T12:00:00.000Z', timeZone: 'Asia/Bangkok' })
  assert.equal('attendees' in event, false)
  assert.equal(event.description, 'Status: confirmed\nManage reservation: https://app.example/dashboard/account/messages/thread/reservation')
  const booking = calendarEvent({ booking_id: 'booking', product_kind: 'experience', request_id: 'thread', buyer_user_id: 'buyer', status: 'confirmed', starts_at: '2099-01-01T12:00:00.000Z', ends_at: '2099-01-01T13:00:00.000Z', timezone: 'Asia/Bangkok', guest_name: 'Guest', member_name: 'Sam Rivera', is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, null)
  assert.equal(booking.description, 'Status: confirmed\nTeam member: Sam Rivera')
  assert.throws(() => calendarEvent({ booking_id: 'booking', product_kind: 'experience', request_id: null, buyer_user_id: null, status: 'pending', starts_at: 'invalid', ends_at: 'invalid', timezone: 'Asia/Bangkok', guest_name: null, member_name: null, is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, 'https://app.example'))
})

test('a stay projects at its check-in and checkout times, and as whole days where its home has no time', () => {
  const timed = calendarEvent({ booking_id: 'stay', product_kind: 'stay', request_id: 'thread', buyer_user_id: null, status: 'confirmed', starts_at: '2099-01-01T08:00:00.000Z', ends_at: '2099-01-04T04:00:00.000Z', timezone: 'Asia/Bangkok', guest_name: 'Guest', member_name: null, is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, null)
  assert.equal(timed.summary, 'Stay — Guest')
  assert.deepEqual([timed.start, timed.end], [{ dateTime: '2099-01-01T08:00:00.000Z', timeZone: 'Asia/Bangkok' }, { dateTime: '2099-01-04T04:00:00.000Z', timeZone: 'Asia/Bangkok' }])
  // Checkout has no time: the event runs over the stay's days, the checkout day being Google's exclusive end.
  const days = calendarEvent({ booking_id: 'stay', product_kind: 'stay', request_id: 'thread', buyer_user_id: null, status: 'confirmed', starts_at: '2099-01-01T08:00:00.000Z', ends_at: '2099-01-04', timezone: 'Asia/Bangkok', guest_name: 'Guest', member_name: null, is_consultation: 0, guest_email: null, member_email: null, assigned_member_id: null, revision: 'committed' }, null)
  assert.deepEqual([days.start, days.end], [{ date: '2099-01-01' }, { date: '2099-01-04' }])
})
