import { z } from 'zod'
import type { AgendaItem } from '~/server/utils/dashboard-agenda'
import { formatTimestamp, localDateAt } from '~/utils/timezone'

/** One of the visits a guest account has booked, as the account's Today lists it. The business's Today is tasks (server/domain/tasks.ts). */
export const todayCardSchema = z.object({
  id: z.string(), to: z.string(), eyebrow: z.string(), headline: z.string(), description: z.string().nullable(),
  imageUrl: z.string().nullable(), imageIcon: z.string(),
  locationId: z.string().nullable(),
  bookingKind: z.enum(['reservation', 'booking', 'stay']),
  stayId: z.string().nullable(),
  productId: z.string().nullable(),
  occurrenceAt: z.iso.datetime({ offset: true }).nullable(), timeZone: z.string(),
})
export type TodayCard = z.infer<typeof todayCardSchema>
export const todayFeedSchema = z.object({ cards: z.array(todayCardSchema), resolvedAt: z.string() })
export type TodayFeedPayload = z.infer<typeof todayFeedSchema>

/** A guest account's visit as a Today card. */
export function agendaToTodayCard(item: AgendaItem, input: { resolvedAt: string }): TodayCard {
  if (item.kind !== 'reservation' && item.kind !== 'booking' && item.kind !== 'stay') throw new Error('Today cards require a booking, reservation or stay')
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
