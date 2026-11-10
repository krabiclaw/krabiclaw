import type { BookingPolicy } from '../../../server/utils/booking-policy-summary.ts'

/**
 * The terms frozen on a booking of an offering that sets no limits and takes
 * no online payment, for claims a test makes through the capacity operation
 * itself rather than through a booking flow that reads them from the product.
 */
export const OPEN_TERMS: BookingPolicy = { advance_notice_minutes: null, party_size_min: null, party_size_max: null, minimum_guest_age: null, accessibility_contact_required: false, payment: null }
export const OPEN_TERMS_JSON = JSON.stringify(OPEN_TERMS)
