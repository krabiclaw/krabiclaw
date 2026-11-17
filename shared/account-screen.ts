import type { BuyerPaymentEntry } from './account-activity'
import type { NotificationCategorySetting } from './notification-categories'
import { paymentMoney } from './payment-display'
import { formatTimestamp } from '~/utils/timezone'

/**
 * Account settings: one list of rows for the web dashboard and the iPhone app.
 * Each surface decides where a row goes; the rows, their order and what each
 * row says come from here.
 */
export type AccountRowId = 'personal' | 'login' | 'notifications' | 'calendar' | 'appearance' | 'payments' | 'organizations' | 'log-out'

export interface AccountRow {
  id: AccountRowId
  label: string
  summary?: string
}

export interface AccountRowsInput {
  name: string | null
  phoneNumber: string | null
  email: string
  /** Every notification category's channels; null while they are still being read. */
  notifications: NotificationCategorySetting[] | null
  organizations: number
  /** The appearance kept on this device. The server cannot know it, so the app fills it in. */
  theme?: 'system' | 'light' | 'dark'
}

export const THEME_OPTIONS = [
  { label: 'System', description: 'Follow your device appearance.', value: 'system' },
  { label: 'Light', description: 'Always use light mode.', value: 'light' },
  { label: 'Dark', description: 'Always use dark mode.', value: 'dark' },
] as const

export function accountRows(input: AccountRowsInput): AccountRow[] {
  const on = input.notifications?.filter(setting => setting.email || setting.whatsapp || setting.push).length
  const notifications = input.notifications === null ? '' : on === input.notifications.length ? 'All on' : `${on} of ${input.notifications.length} on`
  return [
    { id: 'personal', label: 'Personal information', summary: [input.name, input.phoneNumber].filter(Boolean).join(' · ') || 'Name, photo, WhatsApp number' },
    { id: 'login', label: 'Login & security', summary: input.email },
    { id: 'notifications', label: 'Notifications', summary: notifications },
    // Availability belongs to an organization, so it is offered once there is one.
    ...(input.organizations ? [{ id: 'calendar' as const, label: 'Profile & availability', summary: 'Public profile, hours, time off and Google Calendar' }] : []),
    { id: 'appearance', label: 'Appearance', summary: input.theme ? `${input.theme.charAt(0).toUpperCase()}${input.theme.slice(1)} theme` : undefined },
    { id: 'payments', label: 'Payments', summary: 'Your payments and refunds' },
    { id: 'organizations', label: 'Organizations', summary: input.organizations === 0 ? undefined : input.organizations === 1 ? '1 organization' : `${input.organizations} organizations` },
    { id: 'log-out', label: 'Log out' },
  ]
}

/** Airbnb heads the current year "Completed" and each past year by its number. */
export function paymentYearLabel(entry: Pick<BuyerPaymentEntry, 'created_at'>, now = new Date()): string {
  const year = entry.created_at.slice(0, 4)
  return year === String(now.getUTCFullYear()) ? 'Completed' : year
}

/** "Paid Nov 19" or "Refunded Nov 19". */
export function paymentHeadline(entry: Pick<BuyerPaymentEntry, 'kind' | 'created_at'>): string {
  return `${entry.kind === 'paid' ? 'Paid' : 'Refunded'} ${formatTimestamp(entry.created_at, 'en', 'UTC', { month: 'short', day: 'numeric' })}`
}

/** "Thủ Đức · Aug 11–Oct 11": what, and the dates of the visit it paid for. */
export function paymentWhenLabel(entry: Pick<BuyerPaymentEntry, 'title' | 'starts_at' | 'ends_at' | 'timezone'>): string {
  if (!entry.starts_at || !entry.ends_at || !entry.timezone) return entry.title
  const start = formatTimestamp(entry.starts_at, 'en', entry.timezone, { month: 'short', day: 'numeric' })
  const end = formatTimestamp(entry.ends_at, 'en', entry.timezone, { month: 'short', day: 'numeric' })
  return `${entry.title} · ${start === end ? start : `${start}–${end}`}`
}

/** The amount and its currency, as the line's trailing value reads. */
export function paymentAmountLabel(entry: Pick<BuyerPaymentEntry, 'amount' | 'currency'>): string {
  return `${paymentMoney(entry.amount, entry.currency)} ${entry.currency}`
}

/** "iOS · Safari": the platform and browser a session signed in from. */
export function describeDevice(userAgent?: string | null): string {
  const ua = userAgent ?? ''
  const os = /iPhone|iPad|Darwin\//.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : /CFNetwork\//.test(ua) ? 'iPhone app' : null
  return [os, browser].filter(Boolean).join(' · ') || 'Unknown device'
}
