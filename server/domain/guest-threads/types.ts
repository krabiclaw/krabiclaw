import type { GuestRequest } from '~/server/domain/requests'
import type { MessageAuthorKind, MessageChannel } from '~/server/domain/conversations'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import type { GuestThreadMailbox } from './mailbox'

export type GuestThreadSubmissionType = 'contact' | 'booking' | 'stay'
export type GuestThreadDeliveryChannel = 'email' | 'whatsapp' | 'airbnb' | 'push'
export type GuestThreadDeliveryProvider = 'resend' | 'meta' | 'channex' | 'apns' | 'web_push' | 'log_only'
export type GuestThreadDeliveryPurpose = 'owner_alert' | 'guest_acknowledgement' | 'member_reply' | 'scheduled_message' | 'status_update'
export type GuestThreadDeliveryStatus = 'pending' | 'sending' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'

export type GuestThreadRow = GuestRequest

export interface GuestThreadDeliveryRow {
  id: string
  message_id: string | null
  activity_entry_id: string | null
  task_id: string | null
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

export interface GuestThreadPagination {
  limit: number
  offset: number
  has_more: boolean
  next_offset: number | null
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
  error: string | null
  updated_at: string
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
  /** Words someone wrote (or KrabiClaw's opening, automatic and relayed messages), or an event KrabiClaw recorded. */
  kind: 'message' | 'event'
  /** The part its person plays: the guest, the team, or KrabiClaw alone (conversations.ts messageRole). */
  actorKind: MessageAuthorKind
  actorUserId: string | null
  actorLabel: string | null
  channel: MessageChannel | null
  body: string | null
  eventName: string | null
  payload: Record<string, unknown> | null
  sequence: number
  occurredAt: string
  /** Channex's original timestamp; a timezone-free value is not an instant. */
  providerTimestamp: string | null
  deliveries: GuestThreadEntryDeliveryViewModel[]
  attachments: GuestThreadEntryAttachmentViewModel[]
}

/*
  The inbox: one conversation model behind the web Messages pane, the iOS
  Messages tab and the message emails (design: inbox-parity.md). The server
  hands every surface these shapes already reduced; a client draws them and
  decides nothing. Deliveries, event names, payloads, provider ids and
  submission fields stay on the server.
*/

/** Airbnb Support is a case, not a guest: its own filter, never under Guests. A team conversation is the team's own. */
export type InboxThreadKind = 'guest' | 'support' | 'team'
/** The mark at the corner of the person's circle: Airbnb, or the business's own site and email. */
export type InboxChannel = 'airbnb' | 'direct'

/** One row of the list, as Airbnb's hosting inbox draws it. */
export interface InboxRow {
  id: string
  last_message_at?: string
  kind: InboxThreadKind
  title: string
  avatar_initial: string
  channel: InboxChannel
  /** The home or location the conversation is about; null for one with the business itself. */
  home: string | null
  /** "Oct 16 – 23", "In 3 days", "Check out tomorrow"; null when the conversation has no dates. */
  when: string | null
  /** The last message's words, or "Sent a photo"; empty when nobody has written words yet (a booking with no note). */
  preview: string
  /** "You", or the sender's first name; null when there is no preview. */
  preview_from: string | null
  /** The last message's time in the home's timezone: "2:33 PM", "Yesterday", "Mon", "Nov 2". */
  time: string
  unread: boolean
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
  thumbnail_url: string
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
    sent_at: string
    /** "2:33 PM" on the first message of a run from one side; null on the rest of the run. */
    time: string | null
    body: string | null
    photos: InboxPhoto[]
    /** Files the message carried that are not photos the conversation can show, such as a PDF. */
    unshown_files: number
    /** On the newest business message only: Sending, Sent, Delivered, Read by <name>, Not delivered, Recorded locally. */
    receipt: string | null
    /** The reply was not delivered and can be sent again as it was (a team member's text reply). */
    retryable: boolean
  }
  | { type: 'event'; id: string; text: string; sent_at: string }

export interface InboxThread {
  id: string
  kind: InboxThreadKind
  title: string
  avatar_initial: string
  channel: InboxChannel
  home: string | null
  when: string | null
  /** The stored booking attached to this conversation, whether it uses nights or a session. */
  booking_id: string | null
  record_kind: 'stay' | 'booking' | null
  /** The record in the business's own word: "Reservation", "Consultation", "Experience". */
  record_title: string | null
  /** In a guest's own inbox, where their booking is shown; null for the business. */
  activity_path: string | null
  stream: InboxStreamItem[]
  /** Where a reply goes, and whether one can be sent. */
  /** `reason` says why there is no composer: the reply operation's own refusal. */
  composer: { channel: 'airbnb' | 'email'; available: boolean; reason: string | null }
}

/** "In this conversation": who is in it, its photos and what can be done to it. */
export interface InboxThreadDetails {
  participants: Array<{ name: string; initial: string; role: 'Guest' | 'Host' | 'Co-host' | 'Airbnb Support' }>
  photos: Array<InboxPhoto & { sent_at: string }>
  actions: { archive: boolean; unarchive: boolean; report: boolean; block: boolean; unblock: boolean }
}

export interface ListGuestThreadsOptions {
  conversationIds?: string[]
  includeSortKey?: boolean
  buyerAudience?: boolean
  organizationId?: string | null
  locationId?: string | null
  assignedMemberId?: string | null
  /** The viewer's role in the organization; absent for a server read on the viewer's behalf. */
  principal?: Pick<MemberAccessPrincipal, 'organizationId' | 'role' | 'userId'> | null
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
