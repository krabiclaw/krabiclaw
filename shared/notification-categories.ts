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
  'team_messages',
  'reviews',
  'review_requests',
  'organization_and_billing',
  'product_news',
] as const

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]

export type NotificationChannel = 'email' | 'whatsapp' | 'push'

export interface NotificationCategorySetting {
  email: boolean
  whatsapp: boolean
  push: boolean
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Account security email cannot be switched off. Losing a password reset or an
 * email verification locks a person out of their own account, and an
 * organization invitation that silently never arrives looks like a broken
 * product rather than an honoured preference.
 *
 * This governs channel delivery only. An email's transactional, subscribed or
 * promotional purpose is declared by its message, independently of this list.
 */
export const MANDATORY_EMAIL_CATEGORIES = ['account_security'] as const satisfies readonly NotificationCategory[]

export function isMandatoryEmailCategory(category: NotificationCategory): boolean {
  return (MANDATORY_EMAIL_CATEGORIES as readonly NotificationCategory[]).includes(category)
}

/**
 * Team conversations live in the KrabiClaw app and reach a member only by
 * push. Nothing sends them by email or WhatsApp, so those switches do not exist
 * for these categories rather than being switches that do nothing.
 */
export const PUSH_ONLY_CATEGORIES = ['team_messages'] as const satisfies readonly NotificationCategory[]

export function isPushOnlyCategory(category: NotificationCategory): boolean {
  return (PUSH_ONLY_CATEGORIES as readonly NotificationCategory[]).includes(category)
}

export const NOTIFICATION_CATEGORY_DEFAULTS = {
  account_security: { email: true, whatsapp: false, push: false },
  reservations_bookings: { email: true, whatsapp: true, push: true },
  guest_messages: { email: true, whatsapp: true, push: true },
  // Delivered by push only: a member's app is where team conversations live.
  team_messages: { email: false, whatsapp: false, push: true },
  reviews: { email: true, whatsapp: false, push: false },
  review_requests: { email: true, whatsapp: false, push: false },
  organization_and_billing: { email: true, whatsapp: false, push: false },
  product_news: { email: true, whatsapp: false, push: false },
} as const satisfies Record<NotificationCategory, NotificationCategorySetting>

export const NOTIFICATION_CATEGORY_LABELS = {
  account_security: 'Account and security',
  reservations_bookings: 'Reservations and bookings',
  guest_messages: 'Guest messages',
  team_messages: 'Team messages',
  reviews: 'New reviews',
  review_requests: 'Review requests',
  organization_and_billing: 'Organization and billing',
  product_news: 'KrabiClaw news',
} as const satisfies Record<NotificationCategory, string>

/**
 * What each business calls the requests and the people behind the two
 * categories that name them. A law practice takes consultation requests from
 * clients; it never has guests or bookings.
 */
const VERTICAL_CATEGORY_WORDS = {
  restaurant: { requests: 'Reservations', people: 'Guest' },
  experience: { requests: 'Bookings', people: 'Guest' },
  lodging: { requests: 'Stays', people: 'Guest' },
  service: { requests: 'Consultation requests', people: 'Client' },
} as const

type CategoryVertical = keyof typeof VERTICAL_CATEGORY_WORDS

function joinWords(words: readonly string[]): string {
  const [first, ...rest] = [...new Set(words)]
  if (!first) return ''
  const tail = rest.map(word => word.toLowerCase())
  return tail.length === 0 ? first : `${[first, ...tail.slice(0, -1)].join(', ')} and ${tail.at(-1)}`
}

/**
 * Category names in the words of the businesses this person belongs to, so a
 * lawyer reads "Consultation requests" and someone with a restaurant and a
 * practice reads "Reservations and consultation requests". With no business
 * (or none the table names) the categories keep their general labels.
 */
export function notificationCategoryLabels(verticals: readonly string[]): Record<NotificationCategory, string> {
  const words = (Object.keys(VERTICAL_CATEGORY_WORDS) as CategoryVertical[]).filter(vertical => verticals.includes(vertical)).map(vertical => VERTICAL_CATEGORY_WORDS[vertical])
  if (!words.length) return { ...NOTIFICATION_CATEGORY_LABELS }
  return {
    ...NOTIFICATION_CATEGORY_LABELS,
    reservations_bookings: joinWords(words.map(word => word.requests)),
    guest_messages: `${joinWords(words.map(word => word.people))} messages`,
  }
}

export const NOTIFICATION_CATEGORY_ICONS = {
  account_security: 'i-lucide-shield-check',
  reservations_bookings: 'i-lucide-calendar-check',
  guest_messages: 'i-lucide-message-circle',
  team_messages: 'i-lucide-messages-square',
  reviews: 'i-lucide-star',
  review_requests: 'i-lucide-message-square-heart',
  organization_and_billing: 'i-lucide-credit-card',
  product_news: 'i-lucide-megaphone',
} as const satisfies Record<NotificationCategory, string>

/** The state a settings row previews, without restating the channel names twice. */
export function describeNotificationSetting(setting: NotificationCategorySetting): string {
  const channels = ([['Email', setting.email], ['WhatsApp', setting.whatsapp], ['Push', setting.push]] as const)
    .filter(([, enabled]) => enabled)
    .map(([label]) => label)
  if (channels.length === 0) return 'Off'
  return channels.length === 1 ? channels[0]! : `${channels.slice(0, -1).join(', ')} and ${channels.at(-1)}`
}
