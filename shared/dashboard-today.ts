import { z } from 'zod'
import type { AgendaItem } from '~/server/utils/dashboard-agenda'
import type { OpportunityView } from '~/server/domain/opportunities'
import { formatCalendarRange, formatTimestamp, localDateAt } from '~/utils/timezone'
import { STAY_CHANNEL_LABELS } from '~/shared/bookings'
import { getVerticalCopy } from '~/utils/vertical-copy'

/** One of the visits a guest account has booked, as the account's Today lists it. The business's Today is tasks (server/domain/tasks.ts). */
export const todayCardSchema = z.object({
  id: z.string(), to: z.string(), eyebrow: z.string(), headline: z.string(), description: z.string().nullable(),
  imageUrl: z.string().nullable(), imageIcon: z.string(),
  locationId: z.string().nullable(),
  bookingKind: z.enum(['booking', 'stay']),
  stayId: z.string().nullable(),
  productId: z.string().nullable(),
  occurrenceAt: z.iso.datetime({ offset: true }).nullable(), timeZone: z.string(),
})
export type TodayCard = z.infer<typeof todayCardSchema>
export const todayFeedSchema = z.object({ cards: z.array(todayCardSchema), resolvedAt: z.string() })
export type TodayFeedPayload = z.infer<typeof todayFeedSchema>

/** A guest account's visit as a Today card. */
export function agendaToTodayCard(item: AgendaItem, input: { resolvedAt: string }): TodayCard {
  if (item.kind !== 'booking' && item.kind !== 'stay') throw new Error('Today cards require a booking or stay')
  const referenceDay = localDateAt(new Date(input.resolvedAt), item.timeZone)
  const distance = Math.round((Date.parse(`${item.dayKey}T00:00:00Z`) - Date.parse(`${referenceDay}T00:00:00Z`)) / 86_400_000)
  const when = distance <= 0 ? 'today' : distance === 1 ? 'tomorrow' : `in ${distance} days`
  const guests = item.partySize && item.partySize > 0 ? `${item.partySize} ${item.partySize === 1 ? 'guest' : 'guests'}` : ''
  return {
    id: item.id, to: item.to.replace(/^\/dashboard\/account\/activity\//, '/dashboard/account/bookings/'),
    eyebrow: item.stayMoment === 'current' ? 'Currently hosting' : !item.startsAt.includes('T') ? 'Time not set' : formatTimestamp(item.startsAt, 'en', item.timeZone, { hour: 'numeric', minute: '2-digit' }),
    headline: `${item.title} ${when}${guests ? ` for ${guests}` : ''}`,
    description: [...new Set([item.subtitle, item.locationTitle].filter((part): part is string => !!part && part !== item.title))].join(' · ') || null,
    imageUrl: item.resourceImageUrl, imageIcon: item.kind === 'booking' ? 'i-lucide-ticket' : item.kind === 'stay' ? 'i-lucide-house' : 'i-lucide-map-pin',
    locationId: item.locationId, bookingKind: item.kind, stayId: item.stayId, productId: item.productId,
    occurrenceAt: item.stayMoment === 'current' || !item.startsAt.includes('T') ? null : item.startsAt, timeZone: item.timeZone,
  }
}

/** How far ahead the business's Upcoming reads its reservations, and so how far ahead a booked client is offered a welcome. */
export const UPCOMING_RESERVATION_DAYS = 30

/**
 * One booked visit on the business's Today or Upcoming, as Airbnb's
 * reservation card draws it: when, the guest's portrait, their party, what they
 * booked, and the suggestion for it. Every string is formatted here so web and
 * the app compose nothing. It is read from the canonical agenda.
 */
export interface TodayReservation {
  /** The agenda item: `booking:<request>`, `stay:<stay>:<arrival|departure|current>`. */
  id: string
  kind: 'booking' | 'stay'
  /** The booking's own screen. */
  to: string
  requestId: string | null
  stayId: string | null
  productId: string | null
  locationId: string | null
  startsAt: string
  timeZone: string
  /** "3:00 PM" today; "Oct 26 – 29" for a stay; "Thu, Nov 12 · 3:00 PM" for a visit. */
  dateLabel: string
  guestImageUrl: string | null
  /** "Eva’s group of 4 checks in", "Bruno’s group of 3", "Ana’s consultation". */
  headline: string
  /** The home, offering or location booked. */
  resourceName: string | null
  /** "Pending confirmation", "Currently hosting", "Overbooked · Next guests arrive the same day". */
  statusLabel: string | null
  /** Whether the team left its private note on the booking: "1 note". */
  noteLabel: string | null
  /** The opportunity for this booking, shown at the bottom of its card. */
  suggestion: OpportunityView | null
}

/** A business's booking on its Today ("today") or Upcoming ("upcoming"). */
export function agendaToTodayReservation(item: AgendaItem, input: { range: 'today' | 'upcoming'; vertical: string | null; notes: number }): Omit<TodayReservation, 'suggestion'> {
  if (item.kind !== 'booking' && item.kind !== 'stay') throw new Error('Reservation cards require a booking or stay')
  const timed = item.startsAt.includes('T')
  const time = timed ? formatTimestamp(item.startsAt, 'en', item.timeZone, { hour: 'numeric', minute: '2-digit' }) : 'Time not set'
  const checkIn = timed ? localDateAt(new Date(item.startsAt), item.timeZone) : item.startsAt
  const stayRange = () => {
    if (item.checkOutDate === null) throw new Error(`Stay ${item.stayId} has no checkout date`)
    return formatCalendarRange(item.stayMoment === 'current' ? checkIn : item.dayKey, item.checkOutDate, 'en-US')
  }
  const dateLabel = item.kind === 'stay' && (input.range === 'upcoming' || item.stayMoment === 'current') ? stayRange()
    : input.range === 'today' ? time : `${formatTimestamp(item.startsAt, 'en', item.timeZone, { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`
  const party = item.partySize ?? 0
  const guest = item.guestFirstName ?? (item.kind === 'stay' && item.stayChannel ? `Name not provided by ${STAY_CHANNEL_LABELS[item.stayChannel]}` : item.title)
  const group = item.guestFirstName && party > 1 ? `${guest}’s group of ${party}` : item.kind === 'stay' ? guest : `${guest}’s ${getVerticalCopy(input.vertical, 'en').reservationWord}`
  const moment = input.range === 'today' && item.kind === 'stay' ? item.stayMoment : null
  const headline = moment === 'arrival' ? `${group} checks in` : moment === 'departure' || moment === 'turnover' ? `${group} checks out` : group
  const statusLabel = [item.overbooked ? 'Overbooked' : null, item.status === 'pending' ? 'Pending confirmation' : null,
    moment === 'current' ? 'Currently hosting' : null, moment === 'turnover' ? 'Next guests arrive the same day' : null].filter(Boolean).join(' · ') || null
  return {
    id: item.id, kind: item.kind, to: item.to, requestId: item.requestId, stayId: item.stayId, productId: item.productId, locationId: item.locationId,
    startsAt: item.startsAt, timeZone: item.timeZone, dateLabel, guestImageUrl: item.guestImageUrl, headline,
    resourceName: item.resourceTitle, statusLabel, noteLabel: input.notes > 0 ? `${input.notes} ${input.notes === 1 ? 'note' : 'notes'}` : null,
  }
}

/** "You have 2 reservations", "You have 13 upcoming consultations", in the business's own word for a booking. */
export function todayReservationsTitle(count: number, range: 'today' | 'upcoming', vertical: string | null): string | null {
  if (count === 0) return null
  const word = getVerticalCopy(vertical, 'en').reservationWord
  return `You have ${count} ${range === 'upcoming' ? 'upcoming ' : ''}${word}${count === 1 ? '' : 's'}`
}
