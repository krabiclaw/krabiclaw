import type { InjectionKey } from 'vue'
import { isRecord } from '~/utils/api-clients'
import { isMessageIdentity, type MessageIdentity } from '~/shared/dashboard-invalidations'
import type { ConversationDetails, ConversationEntriesPage, ConversationEntry, ConversationPage } from '~/shared/messages-contract'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type {
  GuestThreadSubmissionType,
  InboxListPage,
  InboxRow,
  InboxUnreadCounts,
} from '~/server/domain/guest-threads/types'

/*
  What the conversation list and a guest conversation both need from the API.
  The list and the detail are separate levels of the editor frame and separate
  components, so the response shapes, their runtime validators and the action
  vocabulary live here once rather than in each.
*/

// The API's own view models, not copies of them. Hand-maintained twins of
// these shapes are what let the client read field names the server had
// stopped sending, so there is one declaration and this reads it.
export type SubmissionType = GuestThreadSubmissionType
export type ThreadListItem = InboxRow
export type ThreadListPage = InboxListPage & { unread?: InboxUnreadCounts; count?: number }
export type ThreadDetails = ConversationDetails

export const removeInboxConversationKey: InjectionKey<(id: string) => void> = Symbol('remove-inbox-conversation')

/**
 * The plural, for the filter that narrows a list to this kind. A booking may be
 * a class, a consultation or a table, so its filter uses the one word true of
 * all of them in this vertical: Consultations for a legal practice, Bookings
 * elsewhere.
 */
export function threadFilterLabel(type: SubmissionType, vertical: string | null | undefined): string {
  if (type === 'contact') return 'Direct messages'
  if (type === 'stay') return 'Stays'
  return resolveBookingPresentation('experience', vertical).labelPlural
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isNullableText = (value: unknown) => value === null || typeof value === 'string'
const isCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

function isRow(value: unknown): value is InboxRow {
  return isRecord(value) && isText(value.id) && (value.kind === 'guest' || value.kind === 'support' || value.kind === 'team')
    && isText(value.title) && isText(value.avatar_initial) && (value.channel === 'airbnb' || value.channel === 'direct')
    && isNullableText(value.home) && isNullableText(value.when) && typeof value.preview === 'string' && (value.preview ? isText(value.preview_from) : value.preview_from === null)
    && isText(value.time) && typeof value.unread === 'boolean'
}

export function isThreadListResponse(value: unknown): value is ThreadListPage {
  return isRecord(value)
    && isRecord(value.pagination)
    && Number.isInteger(value.pagination.limit) && Number(value.pagination.limit) >= 1 && Number(value.pagination.limit) <= 100
    && Number.isSafeInteger(value.pagination.offset) && Number(value.pagination.offset) >= 0
    && typeof value.pagination.has_more === 'boolean'
    && (value.pagination.has_more
      ? value.pagination.next_offset === Number(value.pagination.offset) + Number(value.pagination.limit)
      : value.pagination.next_offset === null)
    && Array.isArray(value.threads)
    && value.threads.length <= Number(value.pagination.limit)
    && (!value.pagination.has_more || value.threads.length === Number(value.pagination.limit))
    && new Set(value.threads.map(thread => isRecord(thread) ? thread.id : undefined)).size === value.threads.length
    && value.threads.every(isRow)
    && (value.count === undefined || isCount(value.count))
    && (value.unread === undefined || (isRecord(value.unread) && ['all', 'guests', 'support', 'team'].every(kind => isCount((value.unread as Record<string, unknown>)[kind]))))
}

function isPhoto(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && isText(value.url) && isText(value.thumbnail_url)
    && (value.width === null || isCount(value.width)) && (value.height === null || isCount(value.height))
}

export function isConversationOperation(value: unknown): value is { message?: MessageIdentity } {
  return isRecord(value) && (value.message === undefined || isMessageIdentity(value.message))
}

const isSequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

export function isConversationEntry(value: unknown): value is ConversationEntry {
  if (!isRecord(value) || !isText(value.id)) return false
  if (value.type === 'day') return isText(value.label)
  if (!isSequence(value.sequence) || !isText(value.sent_at)) return false
  if (value.type === 'event') return isText(value.text)
  return value.type === 'message' && (value.side === 'guest' || value.side === 'business') && isText(value.author)
    && isNullableText(value.label) && isNullableText(value.time) && isNullableText(value.body)
    && Array.isArray(value.photos) && value.photos.every(isPhoto)
    && isNullableText(value.receipt) && typeof value.retryable === 'boolean' && isCount(value.unshown_files)
    && isNullableText(value.author_user_id) && typeof value.automatic === 'boolean'
    && Array.isArray(value.deliveries) && value.deliveries.every(delivery => isRecord(delivery)
      && isText(delivery.id) && isText(delivery.channel) && isText(delivery.status)
      && isNullableText(delivery.error) && isText(delivery.updated_at))
}

export function isConversationPage(value: unknown): value is ConversationPage {
  if (!isRecord(value) || (value.viewer_role !== 'guest' && value.viewer_role !== 'member') || !isRecord(value.conversation)
    || !isText(value.conversation.id) || !isText(value.conversation.organization_id)
    || !Array.isArray(value.entries) || !value.entries.every(isConversationEntry) || !isRecord(value.page)
    || !isRecord(value.capabilities)) return false
  const { can_send, can_manage_participants, can_invite_guest, can_leave } = value.capabilities
  if (typeof can_send !== 'boolean' || typeof can_manage_participants !== 'boolean' || typeof can_invite_guest !== 'boolean'
    || typeof can_leave !== 'boolean') return false
  const { conversation, page } = value
  if (!isText(conversation.title) || !Array.isArray(conversation.participants) || !conversation.participants.every(person =>
    isRecord(person) && (isText(person.id) || (value.viewer_role === 'guest' && person.id === null)) && isText(person.name) && isNullableText(person.member_id) && isNullableText(person.image)
    && (person.role === 'guest' || person.role === 'member') && typeof person.can_remove === 'boolean')) return false
  if ((conversation.kind !== 'team' && conversation.kind !== 'guest' && conversation.kind !== 'support')
    || (conversation.channel !== 'direct' && conversation.channel !== 'airbnb')
    || typeof conversation.is_group !== 'boolean' || !isNullableText(conversation.name) || !isNullableText(conversation.booking_id)
    || !isNullableText(conversation.created_by_user_id) || !isNullableText(conversation.location_id) || !isNullableText(conversation.activity_path)
    || !isRecord(conversation.composer) || !isNullableText(conversation.composer.reason)
    || (conversation.composer.channel !== 'team' && conversation.composer.channel !== 'email' && conversation.composer.channel !== 'airbnb')) return false
  return isConversationWindow(page)
}

export function isConversationEntriesPage(value: unknown): value is ConversationEntriesPage {
  return isRecord(value) && isText(value.conversation_id)
    && Array.isArray(value.entries) && value.entries.every(isConversationEntry)
    && isConversationWindow(value.page)
}

function isConversationWindow(page: unknown): page is ConversationPage['page'] {
  if (!isRecord(page)) return false
  const cursor = (number: unknown) => number === null || isSequence(number)
  return cursor(page.before) && cursor(page.oldest) && cursor(page.newest) && cursor(page.read_through)
    && (page.before === null || page.before === page.oldest)
    && (page.oldest === null ? page.newest === null : Number(page.oldest) <= Number(page.newest))
}

export function isThreadDetails(value: unknown): value is ThreadDetails {
  return isRecord(value)
    && Array.isArray(value.photos) && value.photos.every(photo => isPhoto(photo) && isRecord(photo) && isText(photo.sent_at))
    && isRecord(value.actions) && ['archive', 'unarchive', 'report', 'block', 'unblock'].every(key => typeof (value.actions as Record<string, unknown>)[key] === 'boolean')
}
