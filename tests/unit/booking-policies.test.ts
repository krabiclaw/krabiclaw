import test from 'node:test'
import assert from 'node:assert/strict'

import { bookingPolicy, formatBookingPolicySummary, parseBookingPolicy, type BookingPolicy } from '../../server/utils/booking-policy-summary.ts'

// A table that takes a $25 deposit from parties of 6 or more, as a restaurant sets it up.
function tablePolicy(overrides: Partial<BookingPolicy> = {}): BookingPolicy {
  return {
    advance_notice_minutes: null,
    party_size_min: null,
    party_size_max: null,
    minimum_guest_age: null,
    accessibility_contact_required: false,
    payment: { basis: 'per_booking', unit_amount: 2500, currency: 'USD', tax_behavior: 'inclusive', min_party_size: 6 },
    cancellation: null,
    ...overrides,
  }
}

test('a table states the one cancellation rule and its deposit, once per booking', () => {
  const summary = formatBookingPolicySummary(tablePolicy(), 'en', 'table')
  assert.equal(summary.heading, 'Reservation policies')
  assert.deepEqual(summary.items, [
    { id: 'cancellation', text: 'Cancel free up to 24 hours before the start time. After that, payments aren\'t refunded automatically.' },
    { id: 'deposit', text: 'Parties of 6+ guests require a deposit.' },
    { id: 'deposit_amount', text: 'Deposit: $25.00 per reservation.' },
  ])
})

test('a deposit from every party, plus tax, says so', () => {
  const summary = formatBookingPolicySummary(tablePolicy({ payment: { basis: 'per_booking', unit_amount: 1000, currency: 'USD', tax_behavior: 'exclusive', min_party_size: null } }), 'en', 'table')
  assert.deepEqual(summary.items.slice(1), [
    { id: 'deposit', text: 'A deposit is required before confirmation.' },
    { id: 'deposit_amount', text: 'Deposit: $10.00 per reservation, plus applicable tax.' },
  ])
})

test('a seat paid per guest is its price, not a deposit; guest terms are stated for any offering', () => {
  const summary = formatBookingPolicySummary(tablePolicy({ payment: { basis: 'per_guest', unit_amount: 4500, currency: 'USD', tax_behavior: 'inclusive', min_party_size: null }, minimum_guest_age: 18, accessibility_contact_required: true }), 'en', 'experience')
  assert.equal(summary.heading, 'Experience policies')
  assert.deepEqual(summary.items.map(item => item.id), ['cancellation', 'minimum_guest_age', 'accessibility'])
})

test('advance notice longer than a day moves free cancellation for every offering, a table included', () => {
  const consultation = formatBookingPolicySummary(tablePolicy({ advance_notice_minutes: 2880, payment: null }), 'en', 'service')
  assert.equal(consultation.heading, 'Consultation policies')
  assert.deepEqual(consultation.items, [
    { id: 'cancellation', text: 'Cancel free up to 2 days before the start time. After that, payments aren\'t refunded automatically.' },
  ])
  assert.equal(formatBookingPolicySummary(tablePolicy({ advance_notice_minutes: 120, payment: null }), 'en', 'experience').items[0]!.text, 'Cancel free up to 24 hours before the start time. After that, payments aren\'t refunded automatically.')
  assert.equal(formatBookingPolicySummary(tablePolicy({ advance_notice_minutes: 2880 }), 'en', 'table').items[0]!.text, 'Cancel free up to 2 days before the start time. After that, payments aren\'t refunded automatically.')
})

test('the terms frozen on a booking are the offering\'s, at the price it was made at; free and unpaid offerings take no payment', () => {
  const config = { advance_notice_minutes: 120, party_size_min: 1, party_size_max: 12, minimum_guest_age: null, accessibility_contact_required: false,
    online_payment_required: true, payment_basis: 'per_booking' as const, payment_min_party_size: 6 }
  assert.deepEqual(bookingPolicy(config, { unit_amount: 2500, currency: 'USD', tax_behavior: 'inclusive' }), {
    advance_notice_minutes: 120, party_size_min: 1, party_size_max: 12, minimum_guest_age: null, accessibility_contact_required: false,
    payment: { basis: 'per_booking', unit_amount: 2500, currency: 'USD', tax_behavior: 'inclusive', min_party_size: 6 }, cancellation: null,
  })
  assert.equal(bookingPolicy(config, { unit_amount: 0, currency: 'USD', tax_behavior: 'inclusive' }).payment, null)
  assert.equal(bookingPolicy({ ...config, online_payment_required: false }, { unit_amount: 2500, currency: 'USD', tax_behavior: 'inclusive' }).payment, null)
  assert.deepEqual(parseBookingPolicy(JSON.stringify(tablePolicy())), tablePolicy())
  assert.throws(() => parseBookingPolicy(JSON.stringify({ ...tablePolicy(), accessibility_contact_required: 'no' })), /invalid frozen policy/)
  assert.deepEqual(parseBookingPolicy(JSON.stringify(tablePolicy({ payment: null, cancellation: 'moderate' }))).cancellation, 'moderate')
  assert.throws(() => parseBookingPolicy(JSON.stringify({ ...tablePolicy(), cancellation: 'lenient' })), /invalid frozen policy/)
  assert.throws(() => parseBookingPolicy(JSON.stringify({ ...tablePolicy(), payment: { basis: 'per_seat', unit_amount: 1, currency: 'USD', tax_behavior: 'inclusive', min_party_size: null } })), /invalid frozen policy/)
})

test('a table\'s terms read in Thai', () => {
  const summary = formatBookingPolicySummary(tablePolicy(), 'th', 'table')
  assert.equal(summary.heading, 'นโยบายการจอง')
  assert(summary.items.some((item) => item.text.includes('24 ชั่วโมง')))
})

test('a table\'s terms read in Vietnamese', () => {
  const summary = formatBookingPolicySummary(tablePolicy({ payment: { basis: 'per_booking', unit_amount: 2500, currency: 'USD', tax_behavior: 'inclusive', min_party_size: 6 } }), 'vi', 'table')
  assert.equal(summary.heading, 'Chính sách đặt bàn')
  assert.deepEqual(summary.items.slice(0, 2), [
    { id: 'cancellation', text: 'Hủy miễn phí trước giờ bắt đầu ít nhất 24 giờ. Sau thời điểm đó, khoản thanh toán sẽ không được hoàn tự động.' },
    { id: 'deposit', text: 'Nhóm từ 6 khách trở lên cần đặt cọc.' },
  ])
})

test('formatBookingPolicySummary refuses a locale without a platform catalog', () => {
  assert.throws(() => formatBookingPolicySummary(tablePolicy(), 'fr', 'table'), /No platform locale catalog/)
})
