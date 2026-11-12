import { useLocalStorage } from '@vueuse/core'
import { toValue, type MaybeRefOrGetter } from 'vue'
import { isRecord } from '~/utils/api-clients'
import { authClient } from '~/lib/auth-client'
import { isValidInstant, isValidTimezone } from '~/utils/timezone'
import type { GuestMessageSchedule } from '~/server/domain/guest-message-schedule'
import type { MessageTemplate, listMessageOfferings, listMessageTemplates, listScheduledGuestMessages, scheduledGuestMessage } from '~/server/domain/guest-messaging'
import { resolveAggregateBookingPresentation } from '~/utils/booking-presentation'

export type { MessageTemplate, GuestMessageSchedule }
export type MessageTemplatePage = Awaited<ReturnType<typeof listMessageTemplates>>
export type ScheduledMessage = ReturnType<typeof scheduledGuestMessage>
export type ScheduledMessagePage = Awaited<ReturnType<typeof listScheduledGuestMessages>>

const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === 'string' && Boolean(id))
function isSchedule(value: unknown): value is GuestMessageSchedule {
  if (!isRecord(value) || !isIds(value.product_ids) || !value.product_ids.length) return false
  if (value.trigger === 'booking_received') return value.delay_minutes === 5
  if (value.trigger !== 'check_in' && value.trigger !== 'check_out') return false
  return 'offset_hours' in value ? Number.isInteger(value.offset_hours)
    : Number.isInteger(value.offset_days) && typeof value.local_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.local_time)
}
export function isMessageTemplate(value: unknown): value is MessageTemplate {
  return isRecord(value) && typeof value.id === 'string' && typeof value.organization_id === 'string'
    && typeof value.title === 'string' && Boolean(value.title.trim()) && typeof value.body === 'string' && Boolean(value.body.trim())
    && Number.isSafeInteger(value.version) && Number(value.version) > 0 && isSchedule(value.schedule) && isValidInstant(value.created_at) && isValidInstant(value.updated_at)
}
export function isMessageTemplateResponse(value: unknown): value is { template: MessageTemplate } { return isRecord(value) && isMessageTemplate(value.template) }
function isPagination(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.limit) && Number(value.limit) > 0 && Number(value.limit) <= 100
    && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && typeof value.has_more === 'boolean'
    && (value.has_more ? value.next_offset === Number(value.offset) + Number(value.limit) : value.next_offset === null)
}
export function isMessageTemplatePage(value: unknown): value is MessageTemplatePage {
  return isRecord(value) && isPagination(value.pagination) && Array.isArray(value.templates) && value.templates.every(isMessageTemplate)
}
/** An outbox row: an automatic message about a booking, or a member's own send-later reply in a conversation. */
export function isScheduledMessage(value: unknown): value is ScheduledMessage {
  const text = (field: unknown) => typeof field === 'string' && Boolean(field)
  if (!isRecord(value) || !['id', 'organization_id', 'body'].every(key => text(value[key]))) return false
  const automatic = value.author_user_id === null
    ? text(value.template_title) && text(value.product_id) && text(value.booking_id) && Number.isSafeInteger(value.template_version) && typeof value.timezone === 'string' && isValidTimezone(value.timezone)
    : text(value.author_user_id) && text(value.conversation_id) && value.template_title === null && value.product_id === null && value.booking_id === null && value.template_id === null && value.template_version === null && value.timezone === null
  return automatic
    && ['pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped'].includes(String(value.status))
    && (value.conversation_id === null || typeof value.conversation_id === 'string') && (value.template_id === null || typeof value.template_id === 'string')
    && (value.due_at === null || isValidInstant(value.due_at))
    && ['reason', 'error_code', 'error_field', 'message_id', 'started_at', 'sent_at'].every(key => value[key] === null || typeof value[key] === 'string')
    && isValidInstant(value.created_at) && isValidInstant(value.updated_at)
}
export function isScheduledMessagePage(value: unknown): value is ScheduledMessagePage {
  return isRecord(value) && isPagination(value.pagination) && Array.isArray(value.messages) && value.messages.every(isScheduledMessage)
}
export type MessageOffering = Awaited<ReturnType<typeof listMessageOfferings>>['offerings'][number]
export function isMessageOfferings(value: unknown): value is { offerings: MessageOffering[] } {
  return isRecord(value) && Array.isArray(value.offerings) && value.offerings.every(offering => isRecord(offering)
    && ['stay', 'experience', 'service', 'table'].includes(String(offering.kind)) && typeof offering.id === 'string' && Boolean(offering.id)
    && typeof offering.name === 'string' && Boolean(offering.name) && (offering.timezone === null || (typeof offering.timezone === 'string' && isValidTimezone(offering.timezone))))
}

/**
 * The words a schedule is described with. A place to stay checks in and out
 * in its home's time zone; anything else is the booking's own noun
 * (consultation, reservation, booking) starting and ending: a restaurant's
 * bookings are mostly its tables, so it says reservation.
 */
export function scheduleVocabulary(vertical: string) {
  if (vertical === 'lodging') return { received: 'a new direct reservation', check_in: 'check-in', check_out: 'checkout', aroundCheckIn: 'Around check-in', aroundCheckOut: 'Around checkout', checkInDay: 'On check-in day', checkOutDay: 'On checkout day', zone: 'home’s time zone' }
  const { noun } = resolveAggregateBookingPresentation([{ kind: vertical === 'restaurant' ? 'table' : 'experience', vertical }])
  return { received: `a new ${noun}`, check_in: `the ${noun} starts`, check_out: `the ${noun} ends`, aroundCheckIn: `Around the start of the ${noun}`, aroundCheckOut: `Around the end of the ${noun}`,
    checkInDay: `On the day the ${noun} starts`, checkOutDay: `On the day the ${noun} ends`, zone: `${noun}’s time zone` }
}

export function messageScheduleLabel(schedule: GuestMessageSchedule, vertical: string): string {
  const words = scheduleVocabulary(vertical)
  if (schedule.trigger === 'booking_received') return `5 minutes after ${words.received}`
  const event = words[schedule.trigger]
  const count = (amount: number, unit: string) => `${Math.abs(amount)} ${unit}${Math.abs(amount) === 1 ? '' : 's'} ${amount < 0 ? 'before' : 'after'} ${event}`
  if ('offset_hours' in schedule) return schedule.offset_hours ? count(schedule.offset_hours, 'hour') : `When ${event}`
  return `${schedule.offset_days ? count(schedule.offset_days, 'day') : schedule.trigger === 'check_in' ? words.checkInDay : words.checkOutDay} at ${schedule.local_time} · ${words.zone}`
}

export function isScheduledMessageResponse(value: unknown): value is { message: ScheduledMessage } { return isRecord(value) && isScheduledMessage(value.message) }
export function isSuggestedReplies(value: unknown): value is { generation_id: string; suggestions: string[] } { return isRecord(value) && typeof value.generation_id === 'string' && Boolean(value.generation_id) && Array.isArray(value.suggestions) && value.suggestions.length > 0 && value.suggestions.length <= 3 && value.suggestions.every(item => typeof item === 'string' && Boolean(item.trim())) }

/** Suggested replies are each person's choice for one workspace in this browser; on until turned off. */
export function useSuggestedReplies(organizationId: MaybeRefOrGetter<string | null>) {
  const session = authClient.useSession()
  return useLocalStorage(() => `krabiclaw.suggested-replies.${session.value.data?.user.id ?? 'signed-out'}.${toValue(organizationId)}`, true)
}
