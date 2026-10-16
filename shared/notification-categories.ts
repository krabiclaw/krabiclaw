/**
 * What a person can be notified about, and over which channel.
 *
 * A notification is delivered to a person, so the preference belongs to the
 * person — not to a site. This replaced `settings_json.$.config.owner_notification_channels`,
 * which was per-site and, when unset, picked a channel from whichever data
 * happened to exist (`hasWhatsAppPhone ? ['whatsapp'] : ['email']`).
 *
 * The defaults below are the single source of a category's setting for a user
 * with no stored row. There is no per-user backfill, so nothing can drift out
 * of step with this table.
 */

export const NOTIFICATION_CATEGORIES = [
  'account_security',
  'reservations_bookings',
  'guest_messages',
  'reviews',
  'review_requests',
  'organization_and_billing',
  'product_news',
] as const

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]

export type NotificationChannel = 'email' | 'whatsapp'

export interface NotificationCategorySetting {
  email: boolean
  whatsapp: boolean
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Account security email cannot be switched off. Losing a password reset or an
 * email verification locks a person out of their own account, and an
 * organization invitation that silently never arrives looks like a broken
 * product rather than an honoured preference.
 */
export const MANDATORY_EMAIL_CATEGORIES = ['account_security'] as const satisfies readonly NotificationCategory[]

export function isMandatoryEmailCategory(category: NotificationCategory): boolean {
  return (MANDATORY_EMAIL_CATEGORIES as readonly NotificationCategory[]).includes(category)
}

export const NOTIFICATION_CATEGORY_DEFAULTS = {
  account_security: { email: true, whatsapp: false },
  reservations_bookings: { email: true, whatsapp: true },
  guest_messages: { email: true, whatsapp: true },
  reviews: { email: true, whatsapp: false },
  review_requests: { email: true, whatsapp: false },
  organization_and_billing: { email: true, whatsapp: false },
  product_news: { email: true, whatsapp: false },
} as const satisfies Record<NotificationCategory, NotificationCategorySetting>

export const NOTIFICATION_CATEGORY_LABELS = {
  account_security: 'Account and security',
  reservations_bookings: 'Reservations and bookings',
  guest_messages: 'Guest messages',
  reviews: 'New reviews',
  review_requests: 'Review requests',
  organization_and_billing: 'Organization and billing',
  product_news: 'KrabiClaw news',
} as const satisfies Record<NotificationCategory, string>

/** The state a settings row previews, without restating the channel names twice. */
export function describeNotificationSetting(setting: NotificationCategorySetting): string {
  if (setting.email && setting.whatsapp) return 'Email and WhatsApp'
  if (setting.email) return 'Email'
  if (setting.whatsapp) return 'WhatsApp'
  return 'Off'
}
