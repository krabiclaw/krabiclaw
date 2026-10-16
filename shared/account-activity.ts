import { isValidTimezone, isValidInstant } from '../utils/timezone'
import { isCurrencyCode } from './currencies'

export type AccountActivityKind = 'booking' | 'reservation' | 'stay' | 'order' | 'payment'
export interface AccountActivityItem {
  kind: AccountActivityKind
  /** Visits use their request ID, or their actual operational ID when no request survives. */
  id: string
  requestId: string | null
  operationalId: string | null
  paymentId: string | null
  organizationId: string
  organizationName: string | null
  organizationSlug: string | null
  title: string
  status: string
  startsAt: string | null
  endsAt: string | null
  timeZone: string | null
  createdAt: string
  imageUrl: string | null
  locationTitle: string | null
  partySize: number | null
}
export interface AccountActivityResponse { activities: AccountActivityItem[] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nullableString = (value: unknown) => value === null || typeof value === 'string'
export function isAccountActivityKind(value: unknown): value is AccountActivityKind {
  return value === 'booking' || value === 'reservation' || value === 'stay' || value === 'order' || value === 'payment'
}
export function isAccountActivityItem(value: unknown): value is AccountActivityItem {
  return record(value) && isAccountActivityKind(value.kind) && typeof value.id === 'string'
    && typeof value.organizationId === 'string' && typeof value.title === 'string' && !!value.title.trim()
    && typeof value.status === 'string' && isValidInstant(value.createdAt)
    && ['requestId', 'operationalId', 'paymentId', 'organizationName', 'organizationSlug', 'startsAt', 'endsAt', 'timeZone', 'imageUrl', 'locationTitle'].every(key => nullableString(value[key]))
    && (value.partySize === null || (typeof value.partySize === 'number' && Number.isSafeInteger(value.partySize) && value.partySize > 0))
    && ((value.startsAt === null && value.endsAt === null && value.timeZone === null) || (isValidInstant(value.startsAt) && isValidInstant(value.endsAt) && Date.parse(value.endsAt) > Date.parse(value.startsAt) && typeof value.timeZone === 'string' && isValidTimezone(value.timeZone)))
    && (value.kind === 'payment' ? value.operationalId === null && value.paymentId === value.id : value.kind === 'order' ? value.requestId === null && value.operationalId === null && value.paymentId === value.id && value.startsAt === null && value.endsAt === null && value.timeZone === null : value.id === (value.requestId ?? value.operationalId) && typeof value.operationalId === 'string' && typeof value.startsAt === 'string' && typeof value.endsAt === 'string' && typeof value.timeZone === 'string')
}
export function isAccountActivityResponse(value: unknown): value is AccountActivityResponse {
  return record(value) && Array.isArray(value.activities) && value.activities.every(isAccountActivityItem)
}
/** One line of Airbnb's "Your payments": money the account paid, or money that came back. */

export function isAccountActivityPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/dashboard\/account\/activity\/(booking|reservation|stay|order|payment)\/[^/?#]+$/u.test(value)
}
export interface BuyerPaymentEntry {
  id: string
  kind: 'paid' | 'refunded'
  occurredAt: string
  title: string
  organizationName: string | null
  /** Positive for a payment, negative for a refund, in minor units. */
  amount: number
  currency: string
  /** The record this line belongs to, as an Activity path. */
  to: string
  imageUrl: string | null
  /** The visit this paid for, when it still exists. */
  visitStartsAt: string | null
  visitEndsAt: string | null
  timeZone: string | null
}
export function isBuyerPaymentEntry(value: unknown): value is BuyerPaymentEntry {
  return record(value) && typeof value.id === 'string' && (value.kind === 'paid' || value.kind === 'refunded') && isValidInstant(value.occurredAt)
    && nullableString(value.imageUrl) && nullableString(value.visitStartsAt) && nullableString(value.visitEndsAt) && nullableString(value.timeZone)
    && typeof value.title === 'string' && !!value.title.trim() && nullableString(value.organizationName)
    && typeof value.amount === 'number' && Number.isSafeInteger(value.amount) && (value.kind === 'paid' ? value.amount > 0 : value.amount < 0)
    && isCurrencyCode(value.currency) && isAccountActivityPath(value.to)
}
