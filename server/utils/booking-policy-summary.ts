import { platformLocale } from '~/shared/platform-locales'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount } from '~/shared/prices'
import { freeCancellationNoticeMinutes, noticeDuration } from '~/shared/availability-settings'

export type BookingPolicySummaryType = 'reservation' | 'experience'

export interface BookingPolicySummarySource {
  policy_type: BookingPolicySummaryType
  advance_notice_minutes: number | null
  deposit_required: boolean | null
  deposit_amount?: number | null
  deposit_currency?: string | null
  deposit_tax_behavior?: 'inclusive' | 'exclusive' | null
  deposit_trigger_party_size: number | null
  minimum_guest_age: number | null
  accessibility_contact_required: boolean | null
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

export function formatBookingPolicySummary(
  policy: BookingPolicySummarySource,
  locale: string,
  productKind?: string | null,
): FormattedBookingPolicySummary {
  const t = policyMessages(locale)
  const experience = policy.policy_type === 'experience'
  // A class's or consultation's advance notice also closes its free cancellation; a table's notice governs booking only.
  const window = noticeDuration(freeCancellationNoticeMinutes(experience ? policy.advance_notice_minutes : null), locale)
  const items: FormattedBookingPolicySummaryItem[] = [
    { id: 'cancellation', text: t('cancellation', { window }) },
  ]

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
  }
}
