import type { GuestRequest, ThreadOperationalRecord } from '~/server/domain/requests'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import type { GuestThreadMailbox } from './mailbox'

export type GuestThreadEntryKind = 'submission' | 'message' | 'operation' | 'assignment' | 'resolution'
export type GuestThreadActorKind = 'guest' | 'member' | 'system'
export type GuestThreadChannel = 'web' | 'email' | 'whatsapp' | 'airbnb' | 'system'
export type ConversationState = 'needs_attention' | 'waiting_on_guest' | 'resolved'
export type GuestThreadSubmissionType = 'contact' | 'reservation' | 'booking' | 'stay'
export type GuestThreadDeliveryChannel = 'email' | 'whatsapp' | 'airbnb' | 'push'
export type GuestThreadDeliveryProvider = 'resend' | 'meta' | 'channex' | 'apns' | 'log_only'
export type GuestThreadReplyChannel = 'email' | 'airbnb'
export type GuestThreadDeliveryPurpose = 'owner_alert' | 'guest_acknowledgement' | 'member_reply' | 'scheduled_message' | 'status_update'
export type GuestThreadDeliveryStatus = 'pending' | 'sending' | 'uncertain' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'

export type GuestThreadRow = GuestRequest

export interface GuestThreadEntryRow {
  id: string
  request_id: string
  kind: GuestThreadEntryKind
  actor_kind: GuestThreadActorKind
  actor_user_id: string | null
  channel: GuestThreadChannel | null
  body: string | null
  event_name: string | null
  payload_json: string | null
  dedupe_key: string
  sequence: number
  occurred_at: string
  created_at: string
}

export interface GuestThreadDeliveryRow {
  id: string
  entry_id: string
  channel: GuestThreadDeliveryChannel
  provider: GuestThreadDeliveryProvider
  purpose: GuestThreadDeliveryPurpose
  status: GuestThreadDeliveryStatus
  provider_message_id: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface ThreadSummaryProjection {
  guestName: string | null
  participantLabel: string
  guestEmail: string | null
  guestPhone: string | null
  organizationId: string
  locationId: string | null
  locationTitle: string | null
  createdAt: string
  operationalStatus: string | null
}

/**
 * The opening submission's fields, named once here so the detail API and the
 * conversation view cannot drift apart. A `Record<string, unknown>` is what let
 * the view read `date`/`time`/`requests` — names the API never emitted — and
 * silently render a reservation with no date on it.
 *
 * A contact thread carries `subject`/`message`; a reservation or booking
 * carries the occurrence, read from its operational record. A field the thread
 * does not have is null, never a stand-in from somewhere else.
 */
export interface ThreadDetailSourceFields {
  subject?: string | null
  message?: string | null
  whenLabel?: string | null
  startsAt?: string | null
  /** When the occurrence ends, which is when the thread moves to Past on its own. */
  endsAt?: string | null
  timezone?: string | null
  guests?: string | null
  partySize?: number | null
  notes?: string | null
  locationTitle?: string | null
  productTitle?: string | null
}

export interface ThreadDetailSourceModel {
  submissionType: GuestThreadSubmissionType
  submissionId: string
  operationalStatus: string | null
  operationalStatusLabel: string | null
  fields: ThreadDetailSourceFields
}


export interface GuestThreadListItemViewModel {
  id: string
  organizationId?: string
  organizationName?: string | null
  organizationVertical?: string | null
  guestName: string | null
  participantLabel: string
  replyChannel: GuestThreadReplyChannel
  submissionType: GuestThreadSubmissionType
  locationLabel: string | null
  locationId: string | null
  assignedMemberId: string | null
  occurrenceAt: string | null
  timeZone: string | null
  latestMessageFromGuest: boolean
  conversationState: ConversationState | null
  operationalStatus: string | null
  operationalStatusLabel: string | null
  unread: boolean
  unreadCount: number
  preview: { kind: 'message' | 'submission'; text: string } | null
  lastActivityAt: string
  needsAttention: boolean
  /** The location hero the row leads with. Null when the thread or the location has none. */
  imageUrl: string | null
  /** When the booking behind this thread happens, in its own timezone. A contact thread has none. */
  whenLabel: string | null
  /** From `resolveGuestThreadMailbox`; the client never works these out from dates. */
  mailbox: GuestThreadMailbox
  manuallyArchived: boolean
  canArchive: boolean
  canUnarchive: boolean
}

export interface GuestThreadPagination {
  limit: number
  offset: number
  hasMore: boolean
  nextOffset: number | null
}

export interface GuestThreadListPage {
  threads: GuestThreadListItemViewModel[]
  pagination: GuestThreadPagination
}

/**
 * What became of one outbound send. `channel` here is where the message went,
 * which is not the entry's own channel: a reservation submitted on the web can
 * alert its owner over WhatsApp, and only this says so.
 */
export interface GuestThreadEntryDeliveryViewModel {
  id: string
  channel: GuestThreadDeliveryChannel
  purpose: GuestThreadDeliveryPurpose
  status: GuestThreadDeliveryStatus
}

/** A photo a message carries. */
export interface GuestThreadEntryAttachmentViewModel {
  id: string
  url: string
  alt: string | null
  width: number | null
  height: number | null
}

export interface GuestThreadEntryViewModel {
  id: string
  kind: GuestThreadEntryKind
  actorKind: GuestThreadActorKind
  actorUserId: string | null
  actorLabel: string | null
  channel: GuestThreadChannel | null
  body: string | null
  eventName: string | null
  payload: Record<string, unknown> | null
  sequence: number | null
  occurredAt: string
  /** Channex's original timestamp; a timezone-free value is not an instant. */
  providerTimestamp: string | null
  deliveries: GuestThreadEntryDeliveryViewModel[]
  attachments: GuestThreadEntryAttachmentViewModel[]
}

export interface GuestThreadDeliveryFailureViewModel {
  id: string
  channel: GuestThreadDeliveryChannel
  purpose: GuestThreadDeliveryPurpose
  error: string | null
  status: GuestThreadDeliveryStatus
  createdAt: string
}

export interface GuestThreadDetailViewModel {
  id: string
  organizationName: string | null
  organizationVertical: string | null
  activityPath: string | null
  guestName: string | null
  participantLabel: string
  replyChannel: GuestThreadReplyChannel
  /** The conversation belongs to a guest account, so a reply reaches its account inbox even without a guest email. */
  guestAccountLinked: boolean
  guestEmail: string | null
  guestPhone: string | null
  submissionType: GuestThreadSubmissionType
  submissionId: string
  locationLabel: string | null
  conversationState: ConversationState | null
  source: ThreadDetailSourceModel
  operationalRecord: Pick<ThreadOperationalRecord, 'id' | 'kind' | 'status' | 'starts_at' | 'ends_at' | 'timezone' | 'party_size' | 'check_in_date' | 'check_out_date'> | null
  entries: GuestThreadEntryViewModel[]
  /** What can be done to the booking. Where the conversation lives is below, separately. */
  availableActions: string[]
  /** From `resolveGuestThreadMailbox`. */
  mailbox: GuestThreadMailbox
  manuallyArchived: boolean
  archivedAt: string | null
  archivedByUserId: string | null
  canArchive: boolean
  canUnarchive: boolean
  deliveryFailures: GuestThreadDeliveryFailureViewModel[]
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface ListGuestThreadsOptions {
  buyerAudience?: boolean
  organizationId?: string | null
  locationId?: string | null
  assignedMemberId?: string | null
  principal?: MemberAccessPrincipal | null
  userId: string
  type?: GuestThreadSubmissionType | null
  conversationState?: ConversationState | null
  unreadOnly?: boolean
  /** Current or Past, as `resolveGuestThreadMailbox` defines them. Null lists both. */
  mailbox?: GuestThreadMailbox | null
  limit?: number
  offset?: number
}
