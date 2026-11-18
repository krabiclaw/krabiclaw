import { useLocalStorage } from '@vueuse/core'
import { toValue, type MaybeRefOrGetter } from 'vue'
import { isRecord } from '~/utils/api-clients'
import { authClient } from '~/lib/auth-client'
import { isValidInstant, isValidTimezone } from '~/utils/timezone'
import type { GuestMessageSchedule } from '~/server/domain/guest-message-schedule'
import type { MessageTemplate, listMessageOfferings, listMessageTemplates, listScheduledGuestMessages, scheduledGuestMessage } from '~/server/domain/guest-messaging'
export { messageScheduleLabel, scheduleVocabulary } from '~/utils/message-schedule-presentation'

export type { MessageTemplate, GuestMessageSchedule }
export type MessageTemplatePage = {
  templates: Array<MessageTemplate & { schedule_label: string }>
  pagination: Awaited<ReturnType<typeof listMessageTemplates>>['pagination']
  can_manage: boolean
}
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
  return isRecord(value) && isPagination(value.pagination) && Array.isArray(value.templates) && typeof value.can_manage === 'boolean'
    && value.templates.every(template => isRecord(template) && typeof template.schedule_label === 'string' && isMessageTemplate(template))
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
export type MessageTrigger = { id: GuestMessageSchedule['trigger']; label: string }
export type MessageOffset = { value: number; label: string }
export interface MessageOfferingOptions {
  offerings: MessageOffering[]
  triggers: MessageTrigger[]
  offset_days: MessageOffset[]
  offset_hours: MessageOffset[]
  max_offerings: number
  can_manage: boolean
}

export function isMessageOfferings(value: unknown): value is MessageOfferingOptions {
  return isRecord(value) && Array.isArray(value.offerings) && value.offerings.every(offering => isRecord(offering)
    && ['stay', 'experience', 'service', 'table'].includes(String(offering.kind)) && typeof offering.id === 'string' && Boolean(offering.id)
    && typeof offering.name === 'string' && Boolean(offering.name) && (offering.timezone === null || (typeof offering.timezone === 'string' && isValidTimezone(offering.timezone))))
    && Array.isArray(value.triggers) && value.triggers.length === 3
    && value.triggers.every(trigger => isRecord(trigger) && ['booking_received', 'check_in', 'check_out'].includes(String(trigger.id)) && typeof trigger.label === 'string' && Boolean(trigger.label.trim()))
    && new Set(value.triggers.map(trigger => trigger.id)).size === 3
    && typeof value.can_manage === 'boolean' && Number.isSafeInteger(value.max_offerings) && Number(value.max_offerings) > 0
    && [value.offset_days, value.offset_hours].every(offsets => Array.isArray(offsets) && offsets.length > 0
      && offsets.every(offset => isRecord(offset) && Number.isInteger(offset.value) && typeof offset.label === 'string' && Boolean(offset.label.trim())))
}

export function isScheduledMessageResponse(value: unknown): value is { message: ScheduledMessage } { return isRecord(value) && isScheduledMessage(value.message) }
export function isSuggestedReplies(value: unknown): value is { generation_id: string; suggestions: string[] } { return isRecord(value) && typeof value.generation_id === 'string' && Boolean(value.generation_id) && Array.isArray(value.suggestions) && value.suggestions.length > 0 && value.suggestions.length <= 3 && value.suggestions.every(item => typeof item === 'string' && Boolean(item.trim())) }

/** Suggested replies are each person's choice for one workspace in this browser; on until turned off. */
export function useSuggestedReplies(organizationId: MaybeRefOrGetter<string | null>) {
  const session = authClient.useSession()
  return useLocalStorage(() => `krabiclaw.suggested-replies.${session.value.data?.user.id ?? 'signed-out'}.${toValue(organizationId)}`, true)
}
