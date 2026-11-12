import { isValidTimezone, isValidInstant, isValidCalendarDate } from '../utils/timezone'
import { isCurrencyCode } from './currencies'

export type AccountActivityKind = 'booking' | 'stay' | 'order' | 'payment'
export interface AccountActivityItem {
  kind: AccountActivityKind
  /** Visits use their request ID, or their actual operational ID when no request survives. */
  id: string
  conversation_id: string | null
  booking_id: string | null
  payment_id: string | null
  organization_id: string
  organization_name: string | null
  organization_slug: string | null
  title: string
  status: string
  starts_at: string | null
  ends_at: string | null
  timezone: string | null
  created_at: string
  image_url: string | null
  location_title: string | null
  party_size: number | null
}
export interface AccountActivityResponse { activities: AccountActivityItem[] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nullableString = (value: unknown) => value === null || typeof value === 'string'
export function isAccountActivityKind(value: unknown): value is AccountActivityKind {
  return value === 'booking' || value === 'stay' || value === 'order' || value === 'payment'
}
/** One account detail route for every owned visit and purchase. */
export function accountActivityPath(kind: AccountActivityKind, id: string): string {
  if (!isAccountActivityKind(kind) || !id) throw new Error('A valid account activity kind and ID are required')
  return `/dashboard/account/activity/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`
}

export function isAccountActivityItem(value: unknown): value is AccountActivityItem {
  return record(value) && isAccountActivityKind(value.kind) && typeof value.id === 'string'
    && typeof value.organization_id === 'string' && typeof value.title === 'string' && !!value.title.trim()
    && typeof value.status === 'string' && isValidInstant(value.created_at)
    && ['conversation_id', 'booking_id', 'payment_id', 'organization_name', 'organization_slug', 'starts_at', 'ends_at', 'timezone', 'image_url', 'location_title'].every(key => nullableString(value[key]))
    && (value.party_size === null || (typeof value.party_size === 'number' && Number.isSafeInteger(value.party_size) && value.party_size > 0))
    && ((value.starts_at === null && value.ends_at === null && value.timezone === null) || ((isValidInstant(value.starts_at) || (value.kind === 'stay' && isValidCalendarDate(value.starts_at))) && (isValidInstant(value.ends_at) || (value.kind === 'stay' && isValidCalendarDate(value.ends_at))) && typeof value.starts_at === 'string' && typeof value.ends_at === 'string' && (isValidInstant(value.starts_at) && isValidInstant(value.ends_at) ? Date.parse(value.ends_at) > Date.parse(value.starts_at) : value.ends_at.slice(0, 10) > value.starts_at.slice(0, 10)) && typeof value.timezone === 'string' && isValidTimezone(value.timezone)))
    && (value.kind === 'payment' ? value.booking_id === null && value.payment_id === value.id : value.kind === 'order' ? value.conversation_id === null && value.booking_id === null && value.payment_id === value.id && value.starts_at === null && value.ends_at === null && value.timezone === null : value.id === (value.conversation_id ?? value.booking_id) && typeof value.booking_id === 'string' && typeof value.starts_at === 'string' && typeof value.ends_at === 'string' && typeof value.timezone === 'string')
}
export function isAccountActivityResponse(value: unknown): value is AccountActivityResponse {
  return record(value) && Array.isArray(value.activities) && value.activities.every(isAccountActivityItem)
}
/** One line of Airbnb's "Your payments": money the account paid, or money that came back. */

export function isAccountActivityPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/dashboard\/account\/activity\/(booking|stay|order|payment)\/[^/?#]+$/u.test(value)
}
export interface BuyerPaymentEntry {
  id: string
  kind: 'paid' | 'refunded'
  created_at: string
  title: string
  organization_name: string | null
  /** Positive for a payment, negative for a refund, in minor units. */
  amount: number
  currency: string
  /** The record this line belongs to, as an Activity path. */
  to: string
  image_url: string | null
  /** The visit this paid for, when it still exists. */
  starts_at: string | null
  ends_at: string | null
  timezone: string | null
}
export function isBuyerPaymentEntry(value: unknown): value is BuyerPaymentEntry {
  return record(value) && typeof value.id === 'string' && (value.kind === 'paid' || value.kind === 'refunded') && isValidInstant(value.created_at)
    && nullableString(value.image_url) && nullableString(value.starts_at) && nullableString(value.ends_at) && nullableString(value.timezone)
    && typeof value.title === 'string' && !!value.title.trim() && nullableString(value.organization_name)
    && typeof value.amount === 'number' && Number.isSafeInteger(value.amount) && (value.kind === 'paid' ? value.amount > 0 : value.amount < 0)
    && isCurrencyCode(value.currency) && isAccountActivityPath(value.to)
}
