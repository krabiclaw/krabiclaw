import { platformLocale } from '~/shared/platform-locales'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, type Price } from '~/shared/prices'
import { freeCancellationNoticeMinutes, noticeDuration } from '~/shared/availability-settings'
import { isRecord } from '~/server/utils/type-guards'
import type { PaymentBasis, ProductBookingConfigRecord } from '~/server/utils/availability'

/**
 * The terms a guest agreed to when booking: frozen on `bookings.policy_json`
 * when the booking is made, so a later change to the offering's settings never
 * rewrites what this guest was told.
 */
export interface BookingPolicy {
  advance_notice_minutes: number | null
  party_size_min: number | null
  party_size_max: number | null
  minimum_guest_age: number | null
  accessibility_contact_required: boolean
  /** The online payment the offering takes, or null when it takes none. */
  payment: {
    basis: PaymentBasis
    unit_amount: number
    currency: string
    tax_behavior: Price['tax_behavior']
    /** The smallest party that pays; null is every party. */
    min_party_size: number | null
  } | null
}

/** The offering's terms as they stand now, at the price this booking is made at. */
export function bookingPolicy(config: Pick<ProductBookingConfigRecord, 'advance_notice_minutes' | 'party_size_min' | 'party_size_max' | 'minimum_guest_age' | 'accessibility_contact_required' | 'online_payment_required' | 'payment_basis' | 'payment_min_party_size'>, price: Pick<Price, 'unit_amount' | 'currency' | 'tax_behavior'> | null): BookingPolicy {
  return {
    advance_notice_minutes: config.advance_notice_minutes,
    party_size_min: config.party_size_min,
    party_size_max: config.party_size_max,
    minimum_guest_age: config.minimum_guest_age,
    accessibility_contact_required: config.accessibility_contact_required,
    payment: config.online_payment_required && price && price.unit_amount > 0
      ? { basis: config.payment_basis, unit_amount: price.unit_amount, currency: price.currency, tax_behavior: price.tax_behavior, min_party_size: config.payment_min_party_size }
      : null,
  }
}

const nullableCount = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0)

/** A stored policy, read back; anything else is a corrupt row, never a default. */
export function parseBookingPolicy(json: string): BookingPolicy {
  const value: unknown = JSON.parse(json)
  const payment = isRecord(value) ? value.payment : undefined
  if (!isRecord(value) || !nullableCount(value.advance_notice_minutes) || !nullableCount(value.party_size_min) || !nullableCount(value.party_size_max)
    || !nullableCount(value.minimum_guest_age) || typeof value.accessibility_contact_required !== 'boolean'
    || !(payment === null || (isRecord(payment) && (payment.basis === 'per_guest' || payment.basis === 'per_booking') && Number.isSafeInteger(payment.unit_amount)
      && isCurrencyCode(payment.currency) && (payment.tax_behavior === 'inclusive' || payment.tax_behavior === 'exclusive' || payment.tax_behavior === 'unspecified') && nullableCount(payment.min_party_size)))) {
    throw new Error('A booking has an invalid frozen policy')
  }
  return value as unknown as BookingPolicy
}

export interface FormattedBookingPolicySummaryItem {
  id: string
  text: string
}

export interface FormattedBookingPolicySummary {
  heading: string
  items: FormattedBookingPolicySummaryItem[]
}

// The guest's own language comes from its platform catalog; a locale without
// one has no sentences to render and fails rather than answering in English.
function policyMessages(locale: string) {
  const catalog = platformLocale(locale)
  if (!catalog) throw new Error(`No platform locale catalog for booking policy locale "${locale}"`)
  const messages = catalog.messages
  return (key: string, values: Record<string, string | number>) => {
    const message = messages[`booking_policy.${key}`]
    if (!message) throw new Error(`Platform locale ${locale} is missing booking_policy.${key}`)
    return message.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => String(values[name]))
  }
}

/** What a guest reads before and after booking, in their language and the offering's own words. */
export function formatBookingPolicySummary(policy: BookingPolicy, locale: string, productKind: string): FormattedBookingPolicySummary {
  const t = policyMessages(locale)
  const window = noticeDuration(freeCancellationNoticeMinutes(policy.advance_notice_minutes), locale)
  const items: FormattedBookingPolicySummaryItem[] = [
    { id: 'cancellation', text: t('cancellation', { window }) },
  ]
  // A payment taken for the booking as a whole is a deposit; a seat's price is the price shown beside it.
  if (policy.payment?.basis === 'per_booking') {
    items.push({
      id: 'deposit',
      text: policy.payment.min_party_size ? t('deposit_party', { count: policy.payment.min_party_size }) : t('deposit', {}),
    })
    if (isCurrencyCode(policy.payment.currency)) {
      items.push({ id: 'deposit_amount', text: t(policy.payment.tax_behavior === 'exclusive' ? 'deposit_amount_exclusive' : 'deposit_amount', { amount: formatMinorAmount(policy.payment.unit_amount, policy.payment.currency, locale) }) })
    }
  }
  if (policy.minimum_guest_age) {
    items.push({ id: 'minimum_guest_age', text: t('minimum_guest_age', { age: policy.minimum_guest_age }) })
  }
  if (policy.accessibility_contact_required) {
    items.push({ id: 'accessibility', text: t('accessibility', {}) })
  }

  return {
    heading: t(productKind === 'table' ? 'reservation_heading' : productKind === 'service' ? 'consultation_heading' : 'experience_heading', {}),
    items,
  }
}
