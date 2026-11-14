import type { GuestRequest } from '~/server/domain/requests'
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

export interface GuestThreadEntryAttachmentViewModel {
  id: string
  url: string
  /** The small rendition for a gallery tile; an asset with none yet is served at `url`. */
  thumbnailUrl: string
  alt: string | null
  width: number | null
  height: number | null
}

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
