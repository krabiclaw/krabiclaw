import test from 'node:test'
import assert from 'node:assert/strict'

import { formatBookingPolicySummary, type BookingPolicySummarySource } from '../../server/utils/booking-policy-summary.ts'

function reservationPolicy(overrides: Partial<BookingPolicySummarySource> = {}): BookingPolicySummarySource {
  return {
    policy_type: 'reservation',
    advance_notice_minutes: null,
    free_cancellation_until_minutes: 120,
    reschedule_allowed: true,
    reschedule_cutoff_minutes: 120,
    deposit_required: true,
    deposit_trigger_party_size: 6,
    minimum_guest_age: null,
    accessibility_contact_required: false,
    additional_notes_html: null,
    ...overrides,
  }
}

test('reservation summaries keep cancellation terms and authored notes', () => {
  const summary = formatBookingPolicySummary(reservationPolicy({ additional_notes_html: '<p>Call for dietary requests.</p>' }), 'en')
  assert.equal(summary.heading, 'Reservation policies')
  assert.deepEqual(summary.items, [
    { id: 'cancellation', text: 'Cancel free up to 2 hours before your booking.' },
    { id: 'reschedule', text: 'You can reschedule up to 2 hours before the start time.' },
    { id: 'deposit', text: 'Parties of 6+ guests require a deposit.' },
  ])
  assert.equal(summary.additional_notes_html, '<p>Call for dietary requests.</p>')
})

test('experience summaries retain their own terms', () => {
  const summary = formatBookingPolicySummary(reservationPolicy({ policy_type: 'experience' }), 'en')
  assert.equal(summary.heading, 'Experience policies')
  assert.deepEqual(summary.items.map(item => item.id), ['cancellation', 'reschedule', 'deposit'])
  assert(summary.items.some(item => item.text.includes('6+')))
})

test('renderBookingPolicySummary localizes Thai summaries', () => {
  const summary = formatBookingPolicySummary(reservationPolicy(), 'th')
  assert.equal(summary.heading, 'นโยบายการจอง')
  assert(summary.items.some((item) => item.text.includes('2 ชั่วโมง')))
})

test('renderBookingPolicySummary localizes Vietnamese summaries', () => {
  const summary = formatBookingPolicySummary(reservationPolicy(), 'vi')
  assert.equal(summary.heading, 'Chính sách đặt bàn')
  assert.deepEqual(summary.items, [
    { id: 'cancellation', text: 'Hủy miễn phí trước giờ đặt tối đa 2 giờ.' },
    { id: 'reschedule', text: 'Bạn có thể đổi lịch trước giờ bắt đầu tối đa 2 giờ.' },
    { id: 'deposit', text: 'Nhóm từ 6 khách trở lên cần đặt cọc.' },
  ])
})

test('renderBookingPolicySummary refuses a locale without a platform catalog', () => {
  assert.throws(() => formatBookingPolicySummary(reservationPolicy(), 'fr'), /No platform locale catalog/)
})
