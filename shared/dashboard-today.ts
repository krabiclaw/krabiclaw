import { z } from 'zod'
import type { AgendaItem } from '~/server/utils/dashboard-agenda'
import { formatTimestamp, localDateAt } from '~/utils/timezone'
import type { TaskPerson } from '~/server/domain/tasks'

/** One of the visits a guest account has booked, as the account's Today lists it. The business's Today is `TodayItem`. */
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
    id: item.id, to: item.to,
    eyebrow: item.stay_moment === 'current' ? 'Currently hosting' : !item.starts_at.includes('T') ? 'Time not set' : formatTimestamp(item.starts_at, 'en', item.timezone, { hour: 'numeric', minute: '2-digit' }),
    headline: `${item.title} ${when}${guests ? ` for ${guests}` : ''}`,
    description: [...new Set([item.subtitle, item.location_title].filter((part): part is string => !!part && part !== item.title))].join(' · ') || null,
    image_url: item.resource_image_url, image_icon: item.kind === 'booking' ? 'i-lucide-ticket' : 'i-lucide-house',
  }
}

/** How far ahead the business's Upcoming reads its reservations, and so how far ahead a booked client is offered a welcome. */
export const UPCOMING_RESERVATION_DAYS = 30

/** Who and how many, as a card names them: "Eva’s group of 4", "Ana", "a group of 2". */
export function guestGroup(name: string | null, party: number): string {
  const first = name?.trim().split(/\s+/)[0] || null
  if (!first) return party === 1 ? 'a guest' : `a group of ${party}`
  return party > 1 ? `${first}’s group of ${party}` : first
}

/**
 * One card on the business's Today or Upcoming, in Airbnb's order: when, once;
 * the picture of what was booked; one sentence with who and how many; where,
 * with the money for an owner or admin; then the two-line action. The card
 * opens the conversation about that booking or job. Every string is formatted
 * on the server; web and the app draw it as it comes.
 */
export interface TodayItem {
  /** `booking:<id>`, `arrival:<id>`, `departure:<id>`, `class:<session>`, `task:<id>`. */
  id: string
  /** "3:00 PM" today; "Oct 26 – 29" for a stay on Upcoming; "Thu, Nov 20 · 10:30 AM" for a visit on Upcoming; none for setup or an undated task. */
  when: string | null
  /** The home's or offering's own picture; a table's location. */
  image_url: string | null
  /** The small round tile drawn instead when there is no picture. */
  icon: string
  /** "Eva’s group of 4 checks in", "Pottery wheel class for 6", "Clean up after Parity’s group of 2". */
  headline: string
  /** "Ao Nang Pool Villa · $1,240 paid", "Family law · Online · free". */
  line: string | null
  /** "Share info about your place" / "Help Eva get ready". */
  action: { title: string; detail: string }
  /** The conversation about it, its record when the viewer has no seat in one, or the editor that finishes a setup step; none for a task someone added. */
  to: string | null
  /** The welcome the conversation opens with, for the owner to review and send. */
  draft: string | null
  /** A task someone added closes from its card: POST `{}` to this path. */
  done: { path: string } | null
  claim?: { path: string; version: number; label: string }
}

/** GET /api/dashboard/today: one list for the person looking, in the order the day happens. */
export interface BusinessToday {
  /** "You have 2 reservations and 1 request"; "Nothing needs you today". */
  title: string
  cards: TodayItem[]
  /** Who an owner or admin can give a task to; empty for a member. */
  assignees: TaskPerson[]
  claim_options?: { roles: Array<{ value: string; label: string }>; listings: Array<{ listing_id: string; label: string }> }
  resolved_at: string
}
