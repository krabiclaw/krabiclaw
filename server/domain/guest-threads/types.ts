import type { GuestRequest, ThreadOperationalRecord } from '~/server/domain/requests'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import type { GuestThreadMailbox } from './mailbox'
import type { StayChannel } from '~/shared/bookings'
import type { BookingChangeView } from './booking-changes'

export type GuestThreadEntryKind = 'submission' | 'message' | 'operation' | 'assignment'
export type GuestThreadActorKind = 'guest' | 'member' | 'system'
export type GuestThreadChannel = 'web' | 'email' | 'whatsapp' | 'airbnb' | 'system'
export type GuestThreadSubmissionType = 'contact' | 'reservation' | 'booking' | 'stay'
export type GuestThreadDeliveryChannel = 'email' | 'whatsapp' | 'airbnb' | 'push'
export type GuestThreadDeliveryProvider = 'resend' | 'meta' | 'channex' | 'apns' | 'web_push' | 'log_only'
export type GuestThreadDeliveryPurpose = 'owner_alert' | 'guest_acknowledgement' | 'member_reply' | 'scheduled_message' | 'status_update'
export type GuestThreadDeliveryStatus = 'pending' | 'sending' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'

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
  email_json: string | null
  email_message_id: string | null
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
  /** The guest's answers to the business's own questions, in the wording they answered: part of the form like its notes. */
  answers: import('~/shared/form-questions').FormAnswerSnapshot[]
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
  submissionType: GuestThreadSubmissionType
  locationLabel: string | null
  locationId: string | null
  assignedMemberId: string | null
  productId: string | null
  stayChannel: StayChannel | null
  occurrenceAt: string | null
  timeZone: string | null
  latestMessageFromGuest: boolean
  /** An open guest_reply task: the guest asked something nobody has answered. */
  needsReply: boolean
  operationalStatus: string | null
  operationalStatusLabel: string | null
  unread: boolean
  unreadCount: number
  preview: { kind: 'message' | 'submission'; text: string } | null
  lastActivityAt: string
  /** The location hero the row leads with. Null when the thread or the location has none. */
  imageUrl: string | null
  /** A business logo its owner shows whole is fitted inside the frame rather than cropped to fill it. */
  imageFit: 'cover' | 'contain'
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
  provider: GuestThreadDeliveryProvider
  purpose: GuestThreadDeliveryPurpose
  status: GuestThreadDeliveryStatus
}

/** A photo a message carries. */
export interface GuestThreadEntryAttachmentViewModel {
  id: string
  url: string
  /** The small rendition for a gallery tile; an asset with none yet is served at `url`. */
  thumbnailUrl: string
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
  /** Canonical consent state and public before/after details for a requested change. */
  bookingChange: BookingChangeView | null
}

export interface GuestThreadDeliveryFailureViewModel {
  id: string
  channel: GuestThreadDeliveryChannel
  purpose: GuestThreadDeliveryPurpose
  recipient: string | null
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
  /** Where the conversation lives: Airbnb's own thread, or KrabiClaw directly. Where a reply can go is `guestReplyDestination`'s. */
  conversationChannel: 'airbnb' | 'direct'
  guestEmail: string | null
  guestPhone: string | null
  submissionType: GuestThreadSubmissionType
  submissionId: string
  locationLabel: string | null
  /** An open guest_reply task: the guest asked something nobody has answered. */
  needsReply: boolean
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
  blockedAt: string | null
  canArchive: boolean
  canUnarchive: boolean
  deliveryFailures: GuestThreadDeliveryFailureViewModel[]
  createdAt: string
  updatedAt: string
}

/*
  The inbox: one conversation model behind the web Messages pane, the iOS
  Messages tab and the message emails (design: inbox-parity.md). The server
  hands every surface these shapes already reduced; a client draws them and
  decides nothing. Deliveries, event names, payloads, provider ids and
  submission fields stay on the server.
*/

/** Airbnb Support is a case, not a guest: its own filter, never under Guests. */
export type InboxThreadKind = 'guest' | 'support'
/** The mark at the corner of the person's circle: Airbnb, or the business's own site and email. */
export type InboxChannel = 'airbnb' | 'direct'

/** One row of the list, as Airbnb's hosting inbox draws it. */
export interface InboxRow {
  id: string
  kind: InboxThreadKind
  guestName: string
  avatarInitial: string
  channel: InboxChannel
  /** The home or location the conversation is about; null for one with the business itself. */
  home: string | null
  /** "Oct 16 – 23", "In 3 days", "Check out tomorrow"; null when the conversation has no dates. */
  when: string | null
  /** The last message's words, or "Sent a photo"; empty when nobody has written words yet (a booking with no note). */
  preview: string
  /** "You", or the sender's first name; null when there is no preview. */
  previewFrom: string | null
  /** The last message's time in the home's timezone: "2:33 PM", "Yesterday", "Mon", "Nov 2". */
  time: string
  unread: boolean
  /** Whether marking it unread can show it as new: a guest message alerted this member. A
   * conversation nothing in it ever alerted (a booking nobody has written about) was never unread. */
  canMarkUnread: boolean
}

/** Unread conversations per kind, for the filter menu. */
export interface InboxUnreadCounts { all: number; guests: number; support: number; team: number }

export interface InboxListPage {
  threads: InboxRow[]
  pagination: GuestThreadPagination
}

export interface InboxPhoto {
  id: string
  url: string
  thumbnailUrl: string
  width: number | null
  height: number | null
}

export type InboxStreamItem =
  | { type: 'day'; id: string; label: string }
  | {
    type: 'message'
    id: string
    side: 'guest' | 'business'
    /** "Mililani", "You", the team member's first name, "Skyler · Automatic". */
    author: string
    /** An automatic message's template, "Check-in instructions"; null otherwise. */
    label: string | null
    /** One instant: the provider's time when it has one, else when KrabiClaw sent it. */
    sentAt: string
    /** "2:33 PM" on the first message of a run from one side; null on the rest of the run. */
    time: string | null
    /** The words shown, which are the translation when Airbnb translated the message. */
    body: string | null
    photos: InboxPhoto[]
    /** The guest's own words when `body` is Airbnb's translation of them. */
    translated: { original: string } | null
    /** Files the message carried that are not photos the conversation can show, such as a PDF. */
    unshownFiles: number
    /** On the newest business message only: Sending, Sent, Delivered, Read by <name>, Not delivered, Recorded locally. */
    receipt: string | null
    /** The reply was not delivered and can be sent again as it was (a team member's text reply). */
    retryable: boolean
  }
  | { type: 'event'; id: string; text: string; sentAt: string }
  | { type: 'change'; id: string; sentAt: string; change: BookingChangeView }

/** A message waiting to go out: an automatic message, or one a member set to send later. */
export interface InboxPendingMessage {
  id: string
  source: 'automatic' | 'later'
  /** "Check-in instructions" for an automatic message; the words for one sent later. */
  label: string
  sendAt: string
  /** "Fri, Nov 6, 3:00 PM" in the home's timezone. */
  time: string
  body: string
  cancellable: boolean
}

export interface InboxThread {
  id: string
  kind: InboxThreadKind
  guestName: string
  avatarInitial: string
  channel: InboxChannel
  home: string | null
  when: string | null
  /** A message in the conversation was translated: the header says "Translation on". */
  translated: boolean
  /** What Show reservation opens: a stay's id, or the conversation's own id for a booking or reservation (the id the reservation route takes). */
  recordId: string | null
  recordKind: 'stay' | 'booking' | 'reservation' | null
  /** The record in the business's own word: "Reservation", "Consultation", "Experience". */
  recordTitle: string | null
  /** In a guest's own inbox, where their booking is shown; null for the business. */
  activityPath: string | null
  stream: InboxStreamItem[]
  pending: InboxPendingMessage[]
  /** Where a reply goes, and whether one can be sent. */
  /** `reason` says why there is no composer: the reply operation's own refusal. */
  composer: { channel: 'airbnb' | 'email'; available: boolean; reason: string | null }
}

/** "In this conversation": who is in it, its photos and what can be done to it. */
export interface InboxThreadDetails {
  participants: Array<{ name: string; initial: string; role: 'Guest' | 'Host' | 'Co-host' | 'Airbnb Support' }>
  photos: Array<InboxPhoto & { sentAt: string }>
  actions: { showReservation: boolean; archive: boolean; unarchive: boolean; report: boolean; block: boolean; unblock: boolean }
}

export interface ListGuestThreadsOptions {
  buyerAudience?: boolean
  organizationId?: string | null
  locationId?: string | null
  assignedMemberId?: string | null
  principal?: MemberAccessPrincipal | null
  userId: string
  type?: GuestThreadSubmissionType | null
  /** Only conversations with an open guest_reply task. */
  needsReply?: boolean
  unreadOnly?: boolean
  /** Current or Past, as `resolveGuestThreadMailbox` defines them. Null lists both. */
  mailbox?: GuestThreadMailbox | null
  /** The inbox's kind filter; null lists both. */
  kind?: InboxThreadKind | null
  /** Matches the guest's name, the home and the conversation's words. */
  q?: string | null
  limit?: number
  offset?: number
}
