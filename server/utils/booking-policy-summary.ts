import { platformLocale } from '~/shared/platform-locales'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount } from '~/shared/prices'

export type BookingPolicySummaryType = 'reservation' | 'experience'

export interface BookingPolicySummarySource {
  policy_type: BookingPolicySummaryType
  advance_notice_minutes: number | null
  free_cancellation_until_minutes: number | null
  reschedule_allowed: boolean | null
  reschedule_cutoff_minutes: number | null
  deposit_required: boolean | null
  deposit_amount?: number | null
  deposit_currency?: string | null
  deposit_tax_behavior?: 'inclusive' | 'exclusive' | null
  deposit_trigger_party_size: number | null
  minimum_guest_age: number | null
  accessibility_contact_required: boolean | null
  additional_notes_html: string | null
}

export interface FormattedBookingPolicySummaryItem {
  id: string
  text: string
}

export interface FormattedBookingPolicySummary {
  heading: string
  items: FormattedBookingPolicySummaryItem[]
  additional_notes_html: string | null
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

function formatMinutes(minutes: number, locale: string) {
  const unit = minutes % 1440 === 0 ? 'day' : minutes % 60 === 0 ? 'hour' : 'minute'
  const count = unit === 'day' ? minutes / 1440 : unit === 'hour' ? minutes / 60 : minutes
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(count)
}

export function formatBookingPolicySummary(
  policy: BookingPolicySummarySource,
  locale: string,
  productKind?: string | null,
): FormattedBookingPolicySummary {
  const t = policyMessages(locale)
  const experience = policy.policy_type === 'experience'
  const items: FormattedBookingPolicySummaryItem[] = []

  if (policy.free_cancellation_until_minutes !== null) {
    const duration = formatMinutes(policy.free_cancellation_until_minutes, locale)
    items.push({ id: 'cancellation', text: t(policy.free_cancellation_until_minutes === 0 ? 'cancellation_until_start' : experience ? 'experience_cancellation' : 'reservation_cancellation', { duration }) })
  }
  if (policy.reschedule_allowed !== null) {
    const key = !policy.reschedule_allowed ? 'reschedule_disallowed' : policy.reschedule_cutoff_minutes === null ? 'reschedule_allowed' : policy.reschedule_cutoff_minutes === 0 ? 'reschedule_until_start' : 'reschedule'
    items.push({ id: 'reschedule', text: t(key, policy.reschedule_cutoff_minutes === null ? {} : { duration: formatMinutes(policy.reschedule_cutoff_minutes,locale) }) })
  }
  if (policy.deposit_required) {
    items.push({
      id: 'deposit',
      text: policy.deposit_trigger_party_size
        ? t('deposit_party', { count: policy.deposit_trigger_party_size })
        : t('deposit', {}),
    })
    if (policy.deposit_amount != null && isCurrencyCode(policy.deposit_currency)) {
      items.push({ id: 'deposit_amount', text: t(policy.deposit_tax_behavior === 'exclusive' ? 'deposit_amount_exclusive' : 'deposit_amount', { amount: formatMinorAmount(policy.deposit_amount, policy.deposit_currency, locale) }) })
    }
  }
  if (policy.minimum_guest_age) {
    items.push({ id: 'minimum_guest_age', text: t('minimum_guest_age', { age: policy.minimum_guest_age }) })
  }
  if (policy.accessibility_contact_required) {
    items.push({ id: 'accessibility', text: t('accessibility', {}) })
  }

  return {
    heading: t(experience ? productKind === 'service' ? 'consultation_heading' : 'experience_heading' : 'reservation_heading', {}),
    items,
    additional_notes_html: policy.additional_notes_html,
  }
}
