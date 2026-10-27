import type { GuestStay, StayHome } from '~/server/domain/stays'
import { isRecord } from '~/utils/api-clients'
import { STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS, type StayCheckInMethod, type StayCheckoutTask } from './stay-listing'

/** The private fields the listing editor reads from the canonical home response. */
export type StayArrivalGuide = Pick<StayHome, 'product_id' | 'check_in_method' | 'check_in_instructions' | 'wifi_network' | 'wifi_password' | 'directions' | 'house_manual' | 'checkout_instructions'>
export type StayArrivalField = Exclude<keyof StayArrivalGuide, 'product_id'>

export const STAY_ARRIVAL_TEXT_LIMITS = { check_in_instructions: 5000, wifi_network: 100, wifi_password: 100, directions: 5000, house_manual: 5000 } as const
export const STAY_CHECKOUT_DETAILS_LIMIT = 500

/** A home's check-in window as the listing editor summarises it: its start and end, or its start alone when the end is flexible. */
export function stayCheckInWindow(start: string, end: string | null): string {
  return end === null ? `From ${start}` : `${start} – ${end}`
}

export const isStayCheckInMethod = (value: unknown): value is StayCheckInMethod =>
  typeof value === 'string' && Object.hasOwn(STAY_CHECK_IN_METHODS, value)
export const isStayCheckoutTask = (value: unknown): value is StayCheckoutTask =>
  typeof value === 'string' && Object.hasOwn(STAY_CHECKOUT_TASKS, value)

/** Validate the projection we consume, without asserting the rest of StayHome. */
export function isStayArrivalGuide(value: unknown): value is StayArrivalGuide {
  if (!isRecord(value) || typeof value.product_id !== 'string' || !value.product_id) return false
  for (const [key, max] of Object.entries(STAY_ARRIVAL_TEXT_LIMITS)) {
    const text = value[key]
    if (text !== null && (typeof text !== 'string' || !text.trim() || text.length > max)) return false
  }
  if (value.check_in_method !== null && !isStayCheckInMethod(value.check_in_method)) return false
  if (!Array.isArray(value.checkout_instructions)) return false
  const seen = new Set<string>()
  return value.checkout_instructions.every((entry: unknown) => {
    if (!isRecord(entry) || !isStayCheckoutTask(entry.task) || seen.has(entry.task)) return false
    const details = entry.details
    if (details !== null && (typeof details !== 'string' || !details.trim() || details.length > STAY_CHECKOUT_DETAILS_LIMIT)) return false
    if (entry.task === 'additional' && details === null) return false
    seen.add(entry.task)
    return true
  })
}

export function isGuestStay(value: unknown): value is GuestStay {
  if (!isRecord(value) || typeof value.organization_id !== 'string' || !isRecord(value.stay) || typeof value.stay.id !== 'string' || !isRecord(value.home)) return false
  if (value.stay.guest_image_url !== null && typeof value.stay.guest_image_url !== 'string') return false
  const home = value.home
  return typeof home.name === 'string' && (home.location === null || isRecord(home.location))
    && (home.arrival_guide === null || isStayArrivalGuide(home.arrival_guide))
    && [home.house_rules, home.safety].every(lines => Array.isArray(lines) && lines.every(line => typeof line === 'string'))
    && 'cancellation' in value
}
