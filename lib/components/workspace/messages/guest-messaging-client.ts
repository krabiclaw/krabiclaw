import { useLocalStorage } from '@vueuse/core'
import { toValue, type MaybeRefOrGetter } from 'vue'
import { isRecord } from '~/utils/api-clients'
import { authClient } from '~/lib/auth-client'
import { isValidInstant, isValidTimezone } from '~/utils/timezone'
import type { GuestMessageSchedule } from '~/server/domain/guest-message-schedule'
import type { MessageTemplate, listMessageOfferings, listMessageTemplates, listScheduledGuestMessages, scheduledGuestMessage } from '~/server/domain/guest-messaging'
import { resolveAggregateBookingPresentation, type BookingKind } from '~/utils/booking-presentation'

export type { MessageTemplate, GuestMessageSchedule }
export type MessageTemplatePage = Awaited<ReturnType<typeof listMessageTemplates>>
export type ScheduledMessage = ReturnType<typeof scheduledGuestMessage>
export type ScheduledMessagePage = Awaited<ReturnType<typeof listScheduledGuestMessages>>

const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === 'string' && Boolean(id))
function isSchedule(value: unknown): value is GuestMessageSchedule {
  if (!isRecord(value) || !isIds(value.productIds) || !value.productIds.length) return false
  if (value.trigger === 'booking_received') return value.delayMinutes === 5
  if (value.trigger !== 'check_in' && value.trigger !== 'check_out') return false
  return 'offsetHours' in value ? Number.isInteger(value.offsetHours)
    : Number.isInteger(value.offsetDays) && typeof value.localTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)
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
  return isRecord(value) && ['id', 'organizationId', 'title', 'body'].every(key => typeof value[key] === 'string' && Boolean(value[key]))
    && (value.productId === null || (typeof value.productId === 'string' && Boolean(value.productId)))
    && ['stay', 'booking', 'reservation'].includes(String(value.subjectType)) && typeof value.subjectId === 'string' && Boolean(value.subjectId)
    && value.stayId === (value.subjectType === 'stay' ? value.subjectId : null)
    && ['pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped'].includes(String(value.status))
    && (value.requestId === null || typeof value.requestId === 'string') && (value.templateId === null || typeof value.templateId === 'string')
    && (value.dueAt === null || isValidInstant(value.dueAt)) && typeof value.timezone === 'string' && isValidTimezone(value.timezone)
    && ['reason', 'errorCode', 'errorField', 'entryId', 'startedAt', 'sentAt'].every(key => value[key] === null || typeof value[key] === 'string')
    && isValidInstant(value.createdAt) && isValidInstant(value.updatedAt)
}
export function isScheduledMessagePage(value: unknown): value is ScheduledMessagePage {
  return isRecord(value) && isPagination(value.pagination) && Array.isArray(value.messages) && value.messages.every(isScheduledMessage)
}
export type MessageOffering = Awaited<ReturnType<typeof listMessageOfferings>>['offerings'][number]
export function isMessageOfferings(value: unknown): value is { offerings: MessageOffering[] } {
  return isRecord(value) && Array.isArray(value.offerings) && value.offerings.every(offering => isRecord(offering)
    && ['stay', 'experience', 'service', 'reservation'].includes(String(offering.kind)) && typeof offering.id === 'string' && Boolean(offering.id)
    && typeof offering.name === 'string' && Boolean(offering.name) && (offering.timezone === null || (typeof offering.timezone === 'string' && isValidTimezone(offering.timezone))))
}

/**
 * The words a schedule is described with. A place to stay checks in and out
 * in its home's time zone; anything else is the booking's own noun
 * (consultation, reservation, booking) starting and ending.
 */
export function scheduleVocabulary(vertical: string) {
  if (vertical === 'lodging') return { received: 'a new direct reservation', check_in: 'check-in', check_out: 'checkout', aroundCheckIn: 'Around check-in', aroundCheckOut: 'Around checkout', checkInDay: 'On check-in day', checkOutDay: 'On checkout day', zone: 'home’s time zone' }
  const kind: BookingKind = vertical === 'restaurant' ? 'reservation' : 'booking'
  const { noun } = resolveAggregateBookingPresentation([{ kind, vertical }])
  return { received: `a new ${noun}`, check_in: `the ${noun} starts`, check_out: `the ${noun} ends`, aroundCheckIn: `Around the start of the ${noun}`, aroundCheckOut: `Around the end of the ${noun}`,
    checkInDay: `On the day the ${noun} starts`, checkOutDay: `On the day the ${noun} ends`, zone: `${noun}’s time zone` }
}

export function messageScheduleLabel(schedule: GuestMessageSchedule, vertical: string): string {
  const words = scheduleVocabulary(vertical)
  if (schedule.trigger === 'booking_received') return `5 minutes after ${words.received}`
  const event = words[schedule.trigger]
  const count = (amount: number, unit: string) => `${Math.abs(amount)} ${unit}${Math.abs(amount) === 1 ? '' : 's'} ${amount < 0 ? 'before' : 'after'} ${event}`
  if ('offsetHours' in schedule) return schedule.offsetHours ? count(schedule.offsetHours, 'hour') : `When ${event}`
  return `${schedule.offsetDays ? count(schedule.offsetDays, 'day') : schedule.trigger === 'check_in' ? words.checkInDay : words.checkOutDay} at ${schedule.localTime} · ${words.zone}`
}

export type SendLaterMessage = ReturnType<typeof import('~/server/domain/send-later').sendLaterMessage>
function isSendLaterMessage(value: unknown): value is SendLaterMessage {
  return isRecord(value) && typeof value.id === 'string' && typeof value.threadId === 'string' && typeof value.body === 'string'
    && isValidInstant(value.sendAt) && typeof value.status === 'string' && Number.isSafeInteger(value.version)
}
export function isSendLaterResponse(value: unknown): value is { message: SendLaterMessage } { return isRecord(value) && isSendLaterMessage(value.message) }
export function isSendLaterList(value: unknown): value is { messages: SendLaterMessage[] } { return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isSendLaterMessage) }
export function isSuggestedReplies(value: unknown): value is { generationId: string; suggestions: string[] } { return isRecord(value) && typeof value.generationId === 'string' && Boolean(value.generationId) && Array.isArray(value.suggestions) && value.suggestions.length > 0 && value.suggestions.length <= 3 && value.suggestions.every(item => typeof item === 'string' && Boolean(item.trim())) }

/** Suggested replies are each person's choice for one workspace in this browser; on until turned off. */
export function useSuggestedReplies(organizationId: MaybeRefOrGetter<string | null>) {
  const session = authClient.useSession()
  return useLocalStorage(() => `krabiclaw.suggested-replies.${session.value.data?.user.id ?? 'signed-out'}.${toValue(organizationId)}`, true)
}
