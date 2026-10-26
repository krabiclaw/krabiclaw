import { isRecord } from '~/utils/api-clients'
import { isValidInstant, isValidTimezone } from '~/utils/timezone'
import type { GuestMessageSchedule } from '~/server/domain/guest-message-schedule'
import type { MessageTemplate, guestThreadMessagingContext, listMessageTemplates, listScheduledGuestMessages, scheduledGuestMessage } from '~/server/domain/guest-messaging'

export type { MessageTemplate, GuestMessageSchedule }
export type MessageTemplatePage = Awaited<ReturnType<typeof listMessageTemplates>>
export type ScheduledMessage = ReturnType<typeof scheduledGuestMessage>
export type ScheduledMessagePage = Awaited<ReturnType<typeof listScheduledGuestMessages>>
export type GuestMessagingContext = Awaited<ReturnType<typeof guestThreadMessagingContext>>
export function isGuestMessagingContext(value: unknown): value is GuestMessagingContext {
  return isRecord(value) && typeof value.requestId === 'string' && (value.home === null || isRecord(value.home)
    && typeof value.home.product_id === 'string' && typeof value.home.name === 'string' && (value.home.check_in_instructions === null || typeof value.home.check_in_instructions === 'string'))
    && (value.stay === null || isRecord(value.stay) && typeof value.stay.id === 'string')
}

function isSchedule(value: unknown): value is GuestMessageSchedule | null {
  if (value === null) return true
  if (!isRecord(value) || !Array.isArray(value.productIds) || !value.productIds.length || !value.productIds.every(id => typeof id === 'string' && Boolean(id))) return false
  return value.trigger === 'booking_received' ? value.delayMinutes === 5
    : (value.trigger === 'check_in' || value.trigger === 'check_out') && Number.isInteger(value.offsetDays) && typeof value.localTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)
}
export function isMessageTemplate(value: unknown): value is MessageTemplate {
  return isRecord(value) && typeof value.id === 'string' && typeof value.organizationId === 'string'
    && typeof value.title === 'string' && Boolean(value.title.trim()) && typeof value.body === 'string' && Boolean(value.body.trim())
    && Number.isSafeInteger(value.version) && Number(value.version) > 0 && isSchedule(value.schedule) && isValidInstant(value.createdAt) && isValidInstant(value.updatedAt)
}
export function isMessageTemplateResponse(value: unknown): value is { template: MessageTemplate } { return isRecord(value) && isMessageTemplate(value.template) }
function isPagination(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.limit) && Number(value.limit) > 0 && Number(value.limit) <= 100
    && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && typeof value.hasMore === 'boolean'
    && (value.hasMore ? value.nextOffset === Number(value.offset) + Number(value.limit) : value.nextOffset === null)
}
export function isMessageTemplatePage(value: unknown): value is MessageTemplatePage {
  return isRecord(value) && isPagination(value.pagination) && Array.isArray(value.templates) && value.templates.every(isMessageTemplate)
}
export function isScheduledMessage(value: unknown): value is ScheduledMessage {
  return isRecord(value) && ['id', 'organizationId', 'productId', 'stayId', 'title', 'body'].every(key => typeof value[key] === 'string' && Boolean(value[key]))
    && ['pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped'].includes(String(value.status))
    && (value.requestId === null || typeof value.requestId === 'string') && (value.templateId === null || typeof value.templateId === 'string')
    && (value.dueAt === null || isValidInstant(value.dueAt)) && typeof value.timezone === 'string' && isValidTimezone(value.timezone)
    && ['reason', 'errorCode', 'errorField', 'entryId', 'startedAt', 'sentAt'].every(key => value[key] === null || typeof value[key] === 'string')
    && isValidInstant(value.createdAt) && isValidInstant(value.updatedAt)
}
export function isScheduledMessagePage(value: unknown): value is ScheduledMessagePage {
  return isRecord(value) && isPagination(value.pagination) && Array.isArray(value.messages) && value.messages.every(isScheduledMessage)
}
export function messageScheduleLabel(schedule: GuestMessageSchedule | null): string {
  if (!schedule) return 'Send manually'
  if (schedule.trigger === 'booking_received') return '5 minutes after a new direct reservation'
  const event = schedule.trigger === 'check_in' ? 'check-in' : 'checkout'
  const days = Math.abs(schedule.offsetDays)
  return `${days ? `${days} ${days === 1 ? 'day' : 'days'} ${schedule.offsetDays < 0 ? 'before' : 'after'} ${event}` : `On ${event} day`} at ${schedule.localTime} · home’s time zone`
}
