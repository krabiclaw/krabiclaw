import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveBookingPresentation } from '../../utils/booking-presentation.ts'
import { threadFilterLabel } from '../../lib/components/workspace/messages/guest-thread-client.ts'

test('resolveBookingPresentation maps service vertical to Consultation and a table to Reservation', () => {
  const serviceBooking = resolveBookingPresentation('service', 'service')
  assert.equal(serviceBooking.label, 'Consultation')
  assert.equal(serviceBooking.labelPlural, 'Consultations')
  assert.equal(serviceBooking.noun, 'consultation')
  assert.equal(serviceBooking.counterpartyLabel, 'Client')
  assert.equal(serviceBooking.counterpartyNoun, 'client')
  assert.equal(serviceBooking.partyLabel, 'Clients')
  assert.equal(serviceBooking.formatCount(1), '1 client')
  assert.equal(serviceBooking.formatCount(2), '2 clients')

  const serviceReservation = resolveBookingPresentation('table', 'service')
  assert.equal(serviceReservation.label, 'Consultation')
  assert.equal(serviceReservation.counterpartyLabel, 'Client')

  const restaurantReservation = resolveBookingPresentation('table', 'restaurant')
  assert.equal(restaurantReservation.label, 'Reservation')
  assert.equal(restaurantReservation.labelPlural, 'Reservations')
  assert.equal(restaurantReservation.counterpartyLabel, 'Guest')
  assert.equal(restaurantReservation.partyLabel, 'Party size')
  assert.equal(restaurantReservation.formatCount(1), '1 guest')
  assert.equal(restaurantReservation.formatCount(2), '2 guests')
  assert.equal(restaurantReservation.formatCount(4, true), '4+ guests')
  assert.equal(restaurantReservation.formatCount('4+'), '4+ guests')

  const experienceBooking = resolveBookingPresentation('experience', 'experience')
  assert.equal(experienceBooking.label, 'Booking')
  assert.equal(experienceBooking.counterpartyLabel, 'Guest')
  assert.equal(experienceBooking.partyLabel, 'Guests')
  assert.equal(experienceBooking.formatCount(1), '1 guest')
  assert.equal(experienceBooking.formatCount(2), '2 guests')

  // A restaurant that also runs a class: the table is a reservation, the class a booking.
  assert.equal(resolveBookingPresentation('experience', 'restaurant').label, 'Booking')
  assert.equal(resolveBookingPresentation('table', 'restaurant').label, 'Reservation')
})

test('threadFilterLabel names a booking filter in the vertical\'s one word for every booking', () => {
  assert.equal(threadFilterLabel('booking', 'service'), 'Consultations')
  // A booking may be a class or a table, so its filter uses the word true of both.
  assert.equal(threadFilterLabel('booking', 'experience'), 'Bookings')
  assert.equal(threadFilterLabel('booking', 'restaurant'), 'Bookings')
  assert.equal(threadFilterLabel('contact', 'service'), 'Direct messages')
  assert.equal(threadFilterLabel('stay', 'lodging'), 'Stays')
})
