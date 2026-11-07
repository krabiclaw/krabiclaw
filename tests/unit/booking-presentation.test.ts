import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveBookingPresentation } from '../../utils/booking-presentation.ts'
import { threadRecordTitle, threadFilterLabel } from '../../lib/components/workspace/messages/guest-thread-client.ts'

test('resolveBookingPresentation maps service vertical to Consultation', () => {
  const serviceBooking = resolveBookingPresentation('booking', 'service')
  assert.equal(serviceBooking.label, 'Consultation')
  assert.equal(serviceBooking.labelPlural, 'Consultations')
  assert.equal(serviceBooking.noun, 'consultation')
  assert.equal(serviceBooking.counterpartyLabel, 'Client')
  assert.equal(serviceBooking.counterpartyNoun, 'client')
  assert.equal(serviceBooking.partyLabel, 'Clients')
  assert.equal(serviceBooking.formatCount(1), '1 client')
  assert.equal(serviceBooking.formatCount(2), '2 clients')

  const serviceReservation = resolveBookingPresentation('reservation', 'service')
  assert.equal(serviceReservation.label, 'Consultation')
  assert.equal(serviceReservation.counterpartyLabel, 'Client')

  const restaurantReservation = resolveBookingPresentation('reservation', 'restaurant')
  assert.equal(restaurantReservation.label, 'Reservation')
  assert.equal(restaurantReservation.labelPlural, 'Reservations')
  assert.equal(restaurantReservation.counterpartyLabel, 'Guest')
  assert.equal(restaurantReservation.partyLabel, 'Party size')
  assert.equal(restaurantReservation.formatCount(1), '1 guest')
  assert.equal(restaurantReservation.formatCount(2), '2 guests')
  assert.equal(restaurantReservation.formatCount(4, true), '4+ guests')
  assert.equal(restaurantReservation.formatCount('4+'), '4+ guests')

  const experienceBooking = resolveBookingPresentation('booking', 'experience')
  assert.equal(experienceBooking.label, 'Booking')
  assert.equal(experienceBooking.counterpartyLabel, 'Guest')
  assert.equal(experienceBooking.partyLabel, 'Guests')
  assert.equal(experienceBooking.formatCount(1), '1 guest')
  assert.equal(experienceBooking.formatCount(2), '2 guests')
})

test('threadRecordTitle and threadFilterLabel present legal service bookings as Consultation', () => {
  assert.equal(threadRecordTitle('booking', 'service'), 'Consultation')
  assert.equal(threadFilterLabel('booking', 'service'), 'Consultations')

  assert.equal(threadRecordTitle('booking', 'experience'), 'Experience')
  assert.equal(threadFilterLabel('booking', 'experience'), 'Experiences')

  assert.equal(threadRecordTitle('reservation', 'restaurant'), 'Reservation')
  assert.equal(threadFilterLabel('reservation', 'restaurant'), 'Reservations')

  assert.equal(threadRecordTitle('contact', 'service'), 'Message')
  assert.equal(threadFilterLabel('contact', 'service'), 'Direct messages')

  assert.equal(threadRecordTitle('stay', 'lodging'), 'Stay')
  assert.equal(threadFilterLabel('stay', 'lodging'), 'Stays')
})
