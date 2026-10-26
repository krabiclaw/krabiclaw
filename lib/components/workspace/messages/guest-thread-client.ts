import { isRecord } from '~/utils/api-clients'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { EXPERIENCE_PRESENTATION } from '~/utils/product-presentation'
import { normalizeVertical } from '~/utils/vertical-copy'
import { STAY_CHANNELS } from '~/shared/bookings'
import type {
  GuestThreadDeliveryFailureViewModel,
  GuestThreadDetailViewModel,
  GuestThreadListItemViewModel,
  GuestThreadListPage,
  GuestThreadSubmissionType,
} from '~/server/domain/guest-threads/types'

/*
  What the thread list and the conversation both need from the guest-thread API.
  The list and the detail are separate levels of the editor frame and separate
  components, so the response shapes, their runtime validators and the action
  vocabulary live here once rather than in each.
*/

// The API's own view models, not copies of them. Hand-maintained twins of
// these shapes are what let the client read field names the server had
// stopped sending, so there is one declaration and this reads it.
export type SubmissionType = GuestThreadSubmissionType
export type ThreadListItem = GuestThreadListItemViewModel
export type ThreadListPage = GuestThreadListPage
export type ThreadDetail = GuestThreadDetailViewModel

/*
  What a thread is called, in the tenant's own word.

  There is no fourth list of nouns here. A reservation thread is named by
  `booking-presentation` — Reservation for a restaurant, Consultation for a
  legal practice — and a booking thread is a Consultation for legal practice or
  a seat on an experience. A contact thread has no record behind it, and reads
  the way Airbnb's inbox reads one: a direct message.
*/
export function threadRecordTitle(type: SubmissionType, vertical: string | null | undefined): string {
  if (type === 'contact') return 'Message'
  if (type === 'stay') return 'Stay'
  if (type === 'booking' && vertical && normalizeVertical(vertical) !== 'service') {
    return EXPERIENCE_PRESENTATION.itemLabel
  }
  return resolveBookingPresentation(type === 'booking' ? 'booking' : 'reservation', vertical).label
}

/** The plural, for the filter that narrows the list to this kind. */
export function threadFilterLabel(type: SubmissionType, vertical: string | null | undefined): string {
  if (type === 'contact') return 'Direct messages'
  if (type === 'stay') return 'Stays'
  if (type === 'booking' && vertical && normalizeVertical(vertical) !== 'service') {
    return EXPERIENCE_PRESENTATION.itemLabelPlural
  }
  return resolveBookingPresentation(type === 'booking' ? 'booking' : 'reservation', vertical).labelPlural
}

export function isThreadListResponse(value: unknown): value is ThreadListPage {
  return isRecord(value)
    && isRecord(value.pagination)
    && Number.isInteger(value.pagination.limit) && Number(value.pagination.limit) >= 1 && Number(value.pagination.limit) <= 100
    && Number.isSafeInteger(value.pagination.offset) && Number(value.pagination.offset) >= 0
    && typeof value.pagination.hasMore === 'boolean'
    && (value.pagination.hasMore
      ? value.pagination.nextOffset === Number(value.pagination.offset) + Number(value.pagination.limit)
      : value.pagination.nextOffset === null)
    && Array.isArray(value.threads)
    && value.threads.length <= Number(value.pagination.limit)
    && (!value.pagination.hasMore || value.threads.length === Number(value.pagination.limit))
    && new Set(value.threads.map(thread => isRecord(thread) ? thread.id : undefined)).size === value.threads.length
    && value.threads.every(thread =>
      isRecord(thread)
      && (thread.productId === null || typeof thread.productId === 'string')
      && (thread.stayChannel === null || STAY_CHANNELS.some(channel => channel === thread.stayChannel))
      && typeof thread.id === 'string'
      && (thread.guestName === null || typeof thread.guestName === 'string')
      && typeof thread.participantLabel === 'string'
      && (thread.replyChannel === 'email' || thread.replyChannel === 'airbnb')
      && typeof thread.submissionType === 'string'
      && typeof thread.lastActivityAt === 'string'
      && (thread.mailbox === 'current' || thread.mailbox === 'past' || thread.mailbox === 'blocked')
      && typeof thread.manuallyArchived === 'boolean'
      && typeof thread.canArchive === 'boolean'
      && typeof thread.canUnarchive === 'boolean',
    )
}

function isDeliveryFailure(value: unknown): value is GuestThreadDeliveryFailureViewModel {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.channel === 'email' || value.channel === 'whatsapp' || value.channel === 'airbnb' || value.channel === 'push')
    && (value.status === 'failed' || value.status === 'uncertain')
    && (
      value.purpose === 'owner_alert'
      || value.purpose === 'guest_acknowledgement'
      || value.purpose === 'member_reply'
      || value.purpose === 'scheduled_message'
      || value.purpose === 'status_update'
      || value.purpose === 'team_message'
    )
    && (value.error === null || typeof value.error === 'string')
    && typeof value.createdAt === 'string'
}

export function isThreadDetailResponse(value: unknown): value is { thread: ThreadDetail } {
  return isRecord(value)
    && isRecord(value.thread)
    && typeof value.thread.id === 'string'
    && (value.thread.guestName === null || typeof value.thread.guestName === 'string')
    && typeof value.thread.participantLabel === 'string'
    && (value.thread.replyChannel === 'email' || value.thread.replyChannel === 'airbnb')
    && typeof value.thread.guestAccountLinked === 'boolean'
    && (value.thread.organizationName === null || typeof value.thread.organizationName === 'string')
    && (value.thread.organizationVertical === null || typeof value.thread.organizationVertical === 'string')
    && Array.isArray(value.thread.entries)
    && value.thread.entries.every(entry => isRecord(entry) && (entry.providerTimestamp === null || typeof entry.providerTimestamp === 'string')
      && (entry.kind !== 'message' || entry.actorKind === 'guest' || (typeof entry.actorLabel === 'string' && Boolean(entry.actorLabel))))
    && Array.isArray(value.thread.availableActions)
    && (value.thread.mailbox === 'current' || value.thread.mailbox === 'past' || value.thread.mailbox === 'blocked')
    && typeof value.thread.manuallyArchived === 'boolean'
    && (value.thread.archivedAt === null || typeof value.thread.archivedAt === 'string')
    && (value.thread.archivedByUserId === null || typeof value.thread.archivedByUserId === 'string')
    && (value.thread.blockedAt === null || typeof value.thread.blockedAt === 'string')
    && typeof value.thread.canArchive === 'boolean'
    && typeof value.thread.canUnarchive === 'boolean'
    && Array.isArray(value.thread.deliveryFailures)
    && value.thread.deliveryFailures.every(isDeliveryFailure)
}
