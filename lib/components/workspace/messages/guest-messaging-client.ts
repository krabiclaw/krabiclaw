import { useLocalStorage } from '@vueuse/core'
import { toValue, type MaybeRefOrGetter } from 'vue'
import { isRecord } from '~/utils/api-clients'
import { authClient } from '~/lib/auth-client'
import { isValidInstant, isValidTimezone } from '~/utils/timezone'
import type { GuestMessageSchedule } from '~/server/domain/guest-message-schedule'
import type { MessageTemplate, listMessageTemplates, listScheduledGuestMessages, scheduledGuestMessage } from '~/server/domain/guest-messaging'

export type { MessageTemplate, GuestMessageSchedule }
export type MessageTemplatePage = Awaited<ReturnType<typeof listMessageTemplates>>
export type ScheduledMessage = ReturnType<typeof scheduledGuestMessage>
export type ScheduledMessagePage = Awaited<ReturnType<typeof listScheduledGuestMessages>>

function isSchedule(value: unknown): value is GuestMessageSchedule {
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
export function messageScheduleLabel(schedule: GuestMessageSchedule): string {
  if (schedule.trigger === 'booking_received') return '5 minutes after a new direct reservation'
  const event = schedule.trigger === 'check_in' ? 'check-in' : 'checkout'
  const days = Math.abs(schedule.offsetDays)
  return `${days ? `${days} ${days === 1 ? 'day' : 'days'} ${schedule.offsetDays < 0 ? 'before' : 'after'} ${event}` : `On ${event} day`} at ${schedule.localTime} · home’s time zone`
}

export type SendLaterMessage = ReturnType<typeof import('~/server/domain/send-later').sendLaterMessage>
function isSendLaterMessage(value: unknown): value is SendLaterMessage {
  return isRecord(value) && typeof value.id === 'string' && typeof value.threadId === 'string' && typeof value.body === 'string'
    && isValidInstant(value.sendAt) && typeof value.status === 'string' && Number.isSafeInteger(value.version)
}
export function isSendLaterResponse(value: unknown): value is { message: SendLaterMessage } { return isRecord(value) && isSendLaterMessage(value.message) }
export function isSendLaterList(value: unknown): value is { messages: SendLaterMessage[] } { return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isSendLaterMessage) }
export function isSuggestedReply(value: unknown): value is { suggestion: string } { return isRecord(value) && typeof value.suggestion === 'string' && Boolean(value.suggestion.trim()) }

/** Suggested replies are each person's choice for one workspace in this browser; on until turned off. */
export function useSuggestedReplies(organizationId: MaybeRefOrGetter<string | null>) {
  const session = authClient.useSession()
  return useLocalStorage(() => `krabiclaw.suggested-replies.${session.value.data?.user.id ?? 'signed-out'}.${toValue(organizationId)}`, true)
}
