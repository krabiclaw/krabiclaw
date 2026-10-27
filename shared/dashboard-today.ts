import { z } from 'zod'
import type { AgendaItem, AgendaLocation } from '~/server/utils/dashboard-agenda'
import { formatTimestamp, localDateAt } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { STAY_CHANNELS } from '~/shared/bookings'

export const todayCardSchema = z.object({
  id: z.string(), to: z.string(), eyebrow: z.string(), headline: z.string(), description: z.string().nullable(),
  imageUrl: z.string().nullable(), imageFit: z.enum(['cover', 'contain']), imageIcon: z.string(), badgeImageUrl: z.string().nullable(), badgeIcon: z.string().nullable(),
  locationId: z.string().nullable(), assignedMemberId: z.string().nullable(),
  bookingKind: z.enum(['reservation', 'booking', 'stay']).nullable(),
  stayId: z.string().nullable(),
  productId: z.string().nullable(),
  stayChannel: z.enum(STAY_CHANNELS).nullable(),
  occurrenceAt: z.iso.datetime({ offset: true }).nullable(), timeZone: z.string().nullable(),
  priority: z.enum(['attention', 'schedule', 'opportunity']),
})
export type TodayCard = z.infer<typeof todayCardSchema>
export const todayFeedSchema = z.object({
  cards: z.array(todayCardSchema), availableKinds: z.array(z.enum(['reservation', 'booking', 'stay'])),
  locations: z.array(z.object({ id: z.string(), organizationId: z.string(), title: z.string(), imageUrl: z.string().nullable() })),
  resolvedAt: z.string(),
})
export interface TodayFeedPayload {
  cards: TodayCard[]
  availableKinds: Array<'reservation' | 'booking' | 'stay'>
  locations: AgendaLocation[]
  resolvedAt: string
}

/** One projection for business and personal Today, including future agenda windows. */
export function agendaToTodayCard(item: AgendaItem, input: { resolvedAt: string; personal?: boolean; vertical?: string | null; assigned?: boolean }): TodayCard {
  if (item.kind !== 'reservation' && item.kind !== 'booking' && item.kind !== 'stay') throw new Error('Today cards require a booking, reservation or stay')
  const referenceDay = localDateAt(new Date(input.resolvedAt), item.timeZone)
  const distance = Math.round((Date.parse(`${item.dayKey}T00:00:00Z`) - Date.parse(`${referenceDay}T00:00:00Z`)) / 86_400_000)
  const when = distance <= 0 ? 'today' : distance === 1 ? 'tomorrow' : `in ${distance} days`
  const guests = item.partySize && item.partySize > 0 ? `${item.partySize} ${item.partySize === 1 ? 'guest' : 'guests'}` : ''
  const overbooked = item.kind === 'stay' && item.title.startsWith('Overbooked · ')
  const guestTitle = overbooked ? item.title.slice('Overbooked · '.length) : item.title
  const firstName = guestTitle.trim().split(/\s+/)[0] || guestTitle
  const stayGuest = `${overbooked ? 'Overbooked · ' : ''}${guestTitle.startsWith('Name not provided by ') ? guestTitle : firstName}`
  const resourceIcon = item.kind === 'booking'
    ? (input.vertical === 'service' ? 'i-lucide-calendar-clock' : 'i-lucide-ticket')
    : item.kind === 'stay' ? 'i-lucide-house' : 'i-lucide-map-pin'
  const presentation = input.personal || item.kind === 'stay' ? null : resolveBookingPresentation(item.kind, input.vertical)
  const headline = input.personal ? `${item.title} ${when}${guests ? ` for ${guests}` : ''}`
    : item.kind === 'stay' ? `${stayGuest} ${item.stayMoment === 'current' ? 'is staying' : `${item.stayMoment === 'departure' || item.stayMoment === 'turnover' ? 'leaves' : 'arrives'} ${when}`}${guests ? ` with ${guests}` : ''}`
    : input.assigned || presentation?.noun === 'consultation' ? `${presentation!.label} with ${firstName} ${when}`
      : `${firstName} arrives ${when}${guests ? ` · ${guests}` : ''}`
  return {
    id: item.id, to: input.personal ? item.to.replace(/^\/dashboard\/account\/activity\//, '/dashboard/account/bookings/') : item.to,
    eyebrow: item.stayMoment === 'current' ? 'Currently hosting' : formatTimestamp(item.startsAt, 'en', item.timeZone, { hour: 'numeric', minute: '2-digit' }), headline,
    description: input.personal ? [...new Set([item.subtitle, item.locationTitle].filter((part): part is string => !!part && part !== item.title))].join(' · ')
      : [...new Set([item.resourceTitle, item.kind === 'booking' && item.locationId === null ? 'Online' : item.locationTitle, item.stayMoment === 'turnover' ? 'Next guests arrive the same day' : null].filter((part): part is string => !!part))].join(' · '),
    imageUrl: input.personal ? item.resourceImageUrl : item.guestImageUrl, imageFit: 'cover', imageIcon: input.personal ? resourceIcon : 'i-lucide-user',
    badgeImageUrl: input.personal ? null : item.resourceImageUrl, badgeIcon: input.personal ? null : resourceIcon,
    locationId: item.locationId, assignedMemberId: item.assignedMemberId, bookingKind: item.kind, stayId: item.stayId, productId: item.productId, stayChannel: item.stayChannel,
    occurrenceAt: item.stayMoment === 'current' ? null : item.startsAt, timeZone: item.timeZone, priority: 'schedule',
  }
}
