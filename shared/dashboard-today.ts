import { z } from 'zod'
import type { AgendaItem } from '~/server/utils/dashboard-agenda'
import type { OpportunityView } from '~/server/domain/opportunities'
import { formatCalendarRange, formatTimestamp, localDateAt } from '~/utils/timezone'
import { STAY_CHANNEL_LABELS } from '~/shared/bookings'
import { getVerticalCopy } from '~/utils/vertical-copy'

/** One of the visits a guest account has booked, as the account's Today lists it. The business's Today is tasks (server/domain/tasks.ts). */
export const todayCardSchema = z.object({
  id: z.string(), to: z.string(), eyebrow: z.string(), headline: z.string(), description: z.string().nullable(),
  image_url: z.string().nullable(), image_icon: z.string(),
})
export type TodayCard = z.infer<typeof todayCardSchema>
export const todayFeedSchema = z.object({ cards: z.array(todayCardSchema), resolved_at: z.string() })
export type TodayFeedPayload = z.infer<typeof todayFeedSchema>

/** A guest account's visit as a Today card. */
export function agendaToTodayCard(item: AgendaItem, input: { resolved_at: string }): TodayCard {
  if (item.kind !== 'booking' && item.kind !== 'stay') throw new Error('Today cards require a booking or stay')
  const referenceDay = localDateAt(new Date(input.resolved_at), item.timezone)
  const distance = Math.round((Date.parse(`${item.day_key}T00:00:00Z`) - Date.parse(`${referenceDay}T00:00:00Z`)) / 86_400_000)
  const when = distance <= 0 ? 'today' : distance === 1 ? 'tomorrow' : `in ${distance} days`
  const guests = item.party_size && item.party_size > 0 ? `${item.party_size} ${item.party_size === 1 ? 'guest' : 'guests'}` : ''
  return {
    id: item.id, to: item.to.replace(/^\/dashboard\/account\/activity\//, '/dashboard/account/bookings/'),
    eyebrow: item.stay_moment === 'current' ? 'Currently hosting' : !item.starts_at.includes('T') ? 'Time not set' : formatTimestamp(item.starts_at, 'en', item.timezone, { hour: 'numeric', minute: '2-digit' }),
    headline: `${item.title} ${when}${guests ? ` for ${guests}` : ''}`,
    description: [...new Set([item.subtitle, item.location_title].filter((part): part is string => !!part && part !== item.title))].join(' · ') || null,
    image_url: item.resource_image_url, image_icon: item.kind === 'booking' ? 'i-lucide-ticket' : 'i-lucide-house',
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
  conversation_id: string | null
  booking_id: string | null
  product_id: string | null
  location_id: string | null
  starts_at: string
  timezone: string
  /** "3:00 PM" today; "Oct 26 – 29" for a stay; "Thu, Nov 12 · 3:00 PM" for a visit. */
  date_label: string
  guest_image_url: string | null
  /** "Eva’s group of 4 checks in", "Bruno’s group of 3", "Ana’s consultation". */
  headline: string
  /** The home, offering or location booked. */
  name: string | null
  /** "Pending confirmation", "Currently hosting", "Overbooked · Next guests arrive the same day". */
  status_label: string | null
  /** Whether the team left its private note on the booking: "1 note". */
  note_label: string | null
  /** The opportunity for this booking, shown at the bottom of its card. */
  suggestion: OpportunityView | null
}

/** A business's booking on its Today ("today") or Upcoming ("upcoming"). */
export function agendaToTodayReservation(item: AgendaItem, input: { range: 'today' | 'upcoming'; vertical: string | null; notes: number }): Omit<TodayReservation, 'suggestion'> {
  if (item.kind !== 'booking' && item.kind !== 'stay') throw new Error('Reservation cards require a booking or stay')
  const timed = item.starts_at.includes('T')
  const time = timed ? formatTimestamp(item.starts_at, 'en', item.timezone, { hour: 'numeric', minute: '2-digit' }) : 'Time not set'
  const checkIn = timed ? localDateAt(new Date(item.starts_at), item.timezone) : item.starts_at
  const stayRange = () => {
    if (item.check_out_date === null) throw new Error(`Stay ${item.booking_id} has no checkout date`)
    return formatCalendarRange(item.stay_moment === 'current' ? checkIn : item.day_key, item.check_out_date, 'en-US')
  }
  const date_label = item.kind === 'stay' && (input.range === 'upcoming' || item.stay_moment === 'current') ? stayRange()
    : input.range === 'today' ? time : `${formatTimestamp(item.starts_at, 'en', item.timezone, { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`
  const party = item.party_size ?? 0
  const guest = item.guest_first_name ?? (item.kind === 'stay' && item.stay_channel ? `Name not provided by ${STAY_CHANNEL_LABELS[item.stay_channel]}` : item.title)
  const group = item.guest_first_name && party > 1 ? `${guest}’s group of ${party}` : item.kind === 'stay' ? guest : `${guest}’s ${getVerticalCopy(input.vertical, 'en').reservationWord}`
  const moment = input.range === 'today' && item.kind === 'stay' ? item.stay_moment : null
  const headline = moment === 'arrival' ? `${group} checks in` : moment === 'departure' || moment === 'turnover' ? `${group} checks out` : group
  const status_label = [item.overbooked ? 'Overbooked' : null, item.status === 'pending' ? 'Pending confirmation' : null,
    moment === 'current' ? 'Currently hosting' : null, moment === 'turnover' ? 'Next guests arrive the same day' : null].filter(Boolean).join(' · ') || null
  return {
    id: item.id, kind: item.kind, to: item.to, conversation_id: item.conversation_id, booking_id: item.booking_id, product_id: item.product_id, location_id: item.location_id,
    starts_at: item.starts_at, timezone: item.timezone, date_label, guest_image_url: item.guest_image_url, headline,
    name: item.name, status_label, note_label: input.notes > 0 ? `${input.notes} ${input.notes === 1 ? 'note' : 'notes'}` : null,
  }
}

/** "You have 2 reservations", "You have 13 upcoming consultations", in the business's own word for a booking. */
export function todayReservationsTitle(count: number, range: 'today' | 'upcoming', vertical: string | null): string | null {
  if (count === 0) return null
  const word = getVerticalCopy(vertical, 'en').reservationWord
  return `You have ${count} ${range === 'upcoming' ? 'upcoming ' : ''}${word}${count === 1 ? '' : 's'}`
}
