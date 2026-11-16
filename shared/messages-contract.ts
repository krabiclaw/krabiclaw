import type { GuestThreadDeliveryChannel, GuestThreadDeliveryStatus, InboxPhoto, InboxThreadKind } from '~/server/domain/guest-threads/types'

export type ConversationViewerRole = 'guest' | 'member'

export function guestConversationPath(orgSlug: string, conversationId: string): string {
  return `/dashboard/${encodeURIComponent(orgSlug)}/messages/${encodeURIComponent(conversationId)}`
}

export function accountReservationPath(conversationId: string): string {
  return `${guestConversationPath('account', conversationId)}/reservation`
}

export function bookingEditorPath(orgSlug: string, bookingId: string): string {
  return `/dashboard/${encodeURIComponent(orgSlug)}/bookings/${encodeURIComponent(bookingId)}`
}

/** A scheduling role can read a reservation without having a seat in its conversation. */
export function bookingConversationOrRecordPath(orgSlug: string, bookingId: string, readableConversationId: string | null): string {
  return readableConversationId === null ? bookingEditorPath(orgSlug, bookingId) : guestConversationPath(orgSlug, readableConversationId)
}

export interface ConversationDelivery {
  id: string
  channel: GuestThreadDeliveryChannel
  status: GuestThreadDeliveryStatus
  error: string | null
  updated_at: string
}

export interface ConversationMessage {
  type: 'message'
  id: string
  sequence: number
  author_user_id: string | null
  side: 'guest' | 'business'
  author: string
  automatic: boolean
  /** KrabiClaw's post of a job: the card the job's Done is on. */
  job: boolean
  sent_at: string
  time: string | null
  body: string | null
  photos: InboxPhoto[]
  unshown_files: number
  receipt: string | null
  retryable: boolean
  deliveries: ConversationDelivery[]
}

export type ConversationEntry =
  | { type: 'day'; id: string; label: string }
  | { type: 'event'; id: string; sequence: number; text: string; sent_at: string }
  | ConversationMessage

export interface ConversationParticipant {
  id: string | null
  /** The booker manages an invited guest by its conversation-scoped invitation ID. */
  invitation_id?: string
  name: string
  image: string | null
  role: ConversationViewerRole
  /** What the person is here, as the conversation names them: Guest, Host, Co-host or Team. */
  title: string
  can_remove: boolean
}

export interface ConversationHeader {
  id: string
  organization_id: string
  kind: InboxThreadKind
  title: string
  name: string | null
  is_group: boolean
  created_by_user_id: string | null
  booking_id: string | null
  activity_path: string | null
  /** The booking's existing confirmation or creation, placed in the transcript's order. */
  reservation?: {
    at: string
    day: Extract<ConversationEntry, { type: 'day' }>
    confirmation: { message_id: string | null; text: string } | null
  }
  participants: ConversationParticipant[]
  composer: { channel: 'airbnb' | 'email' | 'team' }
}

export interface ConversationEntriesPage {
  conversation_id: string
  entries: ConversationEntry[]
  page: {
    before: number | null
    oldest: number | null
    newest: number | null
    read_through: number | null
  }
}

export interface ConversationPage extends Omit<ConversationEntriesPage, 'conversation_id'> {
  conversation: ConversationHeader
  viewer_role: ConversationViewerRole
  capabilities: {
    can_manage_participants: boolean
    can_invite_guest: boolean
    can_leave: boolean
  }
  /** What the viewer does here: Done for the job this conversation is about, or Review a request or change waiting on them. */
  work: { type: 'done'; task_id: string; version: number } | { type: 'review' } | null
  /** The open task each actionable job message represents, keyed by message ID. */
  job_actions?: Record<string, string>
}

export interface ConversationDetails {
  photos: Array<InboxPhoto & { sent_at: string }>
  actions: { archive: boolean; unarchive: boolean; report: boolean; block: boolean; unblock: boolean }
}
