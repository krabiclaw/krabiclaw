import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveBookingPresentation } from '../../utils/booking-presentation.ts'
import { threadRecordTitle, threadFilterLabel } from '../../lib/components/workspace/messages/guest-thread-client.ts'
import { agendaToTodayCard } from '../../shared/dashboard-today.ts'
import type { AgendaItem } from '../../server/utils/dashboard-agenda.ts'

test('resolveBookingPresentation maps service vertical to Consultation', () => {
  const serviceBooking = resolveBookingPresentation('booking', 'service')
  assert.equal(serviceBooking.label, 'Consultation')
  assert.equal(serviceBooking.labelPlural, 'Consultations')
  assert.equal(serviceBooking.noun, 'consultation')

  const serviceReservation = resolveBookingPresentation('reservation', 'service')
  assert.equal(serviceReservation.label, 'Consultation')

  const restaurantReservation = resolveBookingPresentation('reservation', 'restaurant')
  assert.equal(restaurantReservation.label, 'Reservation')
  assert.equal(restaurantReservation.labelPlural, 'Reservations')

  const experienceBooking = resolveBookingPresentation('booking', 'experience')
  assert.equal(experienceBooking.label, 'Booking')
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

test('agendaToTodayCard presents consultation with calendar-clock icon', () => {
  const item: AgendaItem = {
    id: 'booking-1',
    to: '/dashboard/test-org/bookings/booking-1',
    startsAt: '2026-10-18T14:00:00.000Z',
    endsAt: '2026-10-18T15:00:00.000Z',
    dayKey: '2026-10-18',
    timeZone: 'America/New_York',
    kind: 'booking',
    title: 'Sarah Jenkins',
    subtitle: 'Estate Planning',
    locationId: 'loc-1',
    locationTitle: 'Main Office',
    assignedMemberId: 'mem-1',
    resourceTitle: 'Estate Planning Consultation',
    resourceImageUrl: null,
    guestImageUrl: null,
    partySize: 1,
    status: 'confirmed',
    stayId: null,
    productId: 'consultation-1',
    stayChannel: null,
    stayMoment: null,
  }

  const card = agendaToTodayCard(item, {
    resolvedAt: '2026-10-18T09:00:00.000Z',
    vertical: 'service',
  })

  assert.equal(card.imageIcon, 'i-lucide-user')
  assert.equal(card.badgeIcon, 'i-lucide-calendar-clock')
  assert.match(card.headline, /Consultation with Sarah today/)
  assert.equal(card.productId, 'consultation-1')
})
