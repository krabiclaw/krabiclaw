import test from 'node:test'
import assert from 'node:assert/strict'

import { formatBookingPolicySummary, type BookingPolicySummarySource } from '../../server/utils/booking-policy-summary.ts'

function reservationPolicy(overrides: Partial<BookingPolicySummarySource> = {}): BookingPolicySummarySource {
  return {
    policy_type: 'reservation',
    advance_notice_minutes: null,
    deposit_required: true,
    deposit_trigger_party_size: 6,
    minimum_guest_age: null,
    accessibility_contact_required: false,
    ...overrides,
  }
}

test('reservation summaries state the one cancellation rule', () => {
  const summary = formatBookingPolicySummary(reservationPolicy(), 'en')
  assert.equal(summary.heading, 'Reservation policies')
  assert.deepEqual(summary.items, [
    { id: 'cancellation', text: 'Cancel free up to 24 hours before the start time. After that, payments aren\'t refunded automatically.' },
    { id: 'reschedule', text: 'You can reschedule up to 24 hours before the start time.' },
    { id: 'deposit', text: 'Parties of 6+ guests require a deposit.' },
  ])
})

test('experience summaries state the same rule', () => {
  const summary = formatBookingPolicySummary(reservationPolicy({ policy_type: 'experience' }), 'en')
  assert.equal(summary.heading, 'Experience policies')
  assert.deepEqual(summary.items.map(item => item.id), ['cancellation', 'reschedule', 'deposit'])
  assert(summary.items.some(item => item.text.includes('6+')))
})

test('a class or consultation states its advance notice when it is longer than a day; a table keeps 24 hours', () => {
  const consultation = formatBookingPolicySummary(reservationPolicy({ policy_type: 'experience', advance_notice_minutes: 2880, deposit_required: null }), 'en', 'service')
  assert.equal(consultation.heading, 'Consultation policies')
  assert.deepEqual(consultation.items, [
    { id: 'cancellation', text: 'Cancel free up to 2 days before the start time. After that, payments aren\'t refunded automatically.' },
    { id: 'reschedule', text: 'You can reschedule up to 2 days before the start time.' },
  ])
  assert.equal(formatBookingPolicySummary(reservationPolicy({ policy_type: 'experience', advance_notice_minutes: 120, deposit_required: null }), 'en').items[1]!.text, 'You can reschedule up to 24 hours before the start time.')
  assert.equal(formatBookingPolicySummary(reservationPolicy({ advance_notice_minutes: 2880 }), 'en').items[1]!.text, 'You can reschedule up to 24 hours before the start time.')
})

test('renderBookingPolicySummary localizes Thai summaries', () => {
  const summary = formatBookingPolicySummary(reservationPolicy(), 'th')
  assert.equal(summary.heading, 'นโยบายการจอง')
  assert(summary.items.some((item) => item.text.includes('24 ชั่วโมง')))
})

test('renderBookingPolicySummary localizes Vietnamese summaries', () => {
  const summary = formatBookingPolicySummary(reservationPolicy(), 'vi')
  assert.equal(summary.heading, 'Chính sách đặt bàn')
  assert.deepEqual(summary.items, [
    { id: 'cancellation', text: 'Hủy miễn phí trước giờ bắt đầu ít nhất 24 giờ. Sau thời điểm đó, khoản thanh toán sẽ không được hoàn tự động.' },
    { id: 'reschedule', text: 'Bạn có thể đổi lịch trước giờ bắt đầu ít nhất 24 giờ.' },
    { id: 'deposit', text: 'Nhóm từ 6 khách trở lên cần đặt cọc.' },
  ])
})

test('renderBookingPolicySummary refuses a locale without a platform catalog', () => {
  assert.throws(() => formatBookingPolicySummary(reservationPolicy(), 'fr'), /No platform locale catalog/)
})
