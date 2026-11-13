import type { InboxTranscriptPage } from '~/server/domain/guest-threads/types'
import { isRecord } from '~/utils/api-clients'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type {
  GuestThreadSubmissionType,
  InboxListPage,
  InboxRow,
  InboxStreamItem,
  InboxThread,
  InboxThreadDetails,
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
export type ThreadListPage = InboxListPage & { unread?: InboxUnreadCounts }
export type ThreadDetail = InboxThread
export type ThreadDetails = InboxThreadDetails
export type StreamItem = InboxStreamItem

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
    && (value.unread === undefined || (isRecord(value.unread) && ['all', 'guests', 'support', 'team'].every(kind => isCount((value.unread as Record<string, unknown>)[kind]))))
}

function isPhoto(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && isText(value.url) && isText(value.thumbnail_url)
    && (value.width === null || isCount(value.width)) && (value.height === null || isCount(value.height))
}

function isStreamItem(value: unknown): value is InboxStreamItem {
  if (!isRecord(value) || !isText(value.id)) return false
  if (value.type === 'day') return isText(value.label)
  if (value.type === 'event') return isText(value.text) && isText(value.sent_at)
  if (value.type === 'change') return isText(value.sent_at) && isRecord(value.change)
    && ['pending', 'accepted', 'declined', 'withdrawn', 'stale', 'expired'].includes(String(value.change.status))
  return value.type === 'message' && (value.side === 'guest' || value.side === 'business') && isText(value.author)
    && isNullableText(value.label) && isText(value.sent_at) && isNullableText(value.time) && isNullableText(value.body)
    && Array.isArray(value.photos) && value.photos.every(isPhoto)
    && (value.translated === null || (isRecord(value.translated) && typeof value.translated.original === 'string'))
    && isNullableText(value.receipt) && typeof value.retryable === 'boolean' && isCount(value.unshown_files)
}

export function isThreadDetailResponse(value: unknown): value is { thread: ThreadDetail } {
  const thread = isRecord(value) ? value.thread : null
  return isRecord(thread)
    && isText(thread.id) && (thread.kind === 'guest' || thread.kind === 'support')
    && isText(thread.title) && isText(thread.avatar_initial) && (thread.channel === 'airbnb' || thread.channel === 'direct')
    && isNullableText(thread.home) && isNullableText(thread.when) && typeof thread.translated === 'boolean'
    && isNullableText(thread.booking_id) && isNullableText(thread.record_title) && (thread.record_kind === null || ['stay', 'booking'].includes(String(thread.record_kind)))
    && isNullableText(thread.activity_path)
    && Array.isArray(thread.stream) && thread.stream.every(isStreamItem)
    && Array.isArray(thread.pending) && thread.pending.every(item => isRecord(item) && isText(item.id) && (item.source === 'automatic' || item.source === 'later')
      && isText(item.label) && isText(item.due_at) && isText(item.time) && typeof item.body === 'string' && typeof item.cancellable === 'boolean')
    && isRecord(thread.composer) && (thread.composer.channel === 'airbnb' || thread.composer.channel === 'email') && typeof thread.composer.available === 'boolean' && (thread.composer.reason === null || typeof thread.composer.reason === 'string')
}

export type PagedThread = ThreadDetail & { page: InboxTranscriptPage }
export function isPagedThreadResponse(value: unknown): value is { thread: PagedThread } {
  if (!isThreadDetailResponse(value)) return false
  const page: unknown = Reflect.get(value.thread, 'page')
  const sequence = (n: unknown) => n === null || Number.isSafeInteger(n) && Number(n) > 0
  return isRecord(page) && sequence(page.before) && sequence(page.oldest) && sequence(page.newest)
    && (page.before === null || page.before === page.oldest)
    && (page.oldest === null ? page.newest === null : Number(page.oldest) <= Number(page.newest))
    && Array.isArray(page.failed_messages) && page.failed_messages.every(isText)
    && Array.isArray(page.booking_actions) && page.booking_actions.every(item => isStreamItem(item) && item.type === 'change')
}

export function isThreadDetails(value: unknown): value is ThreadDetails {
  return isRecord(value)
    && Array.isArray(value.participants) && value.participants.every(person => isRecord(person) && isText(person.name) && isText(person.initial)
      && ['Guest', 'Host', 'Co-host', 'Airbnb Support'].includes(String(person.role)))
    && Array.isArray(value.photos) && value.photos.every(photo => isPhoto(photo) && isRecord(photo) && isText(photo.sent_at))
    && isRecord(value.actions) && ['show_reservation', 'archive', 'unarchive', 'report', 'block', 'unblock'].every(key => typeof (value.actions as Record<string, unknown>)[key] === 'boolean')
}
