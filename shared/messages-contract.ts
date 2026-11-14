import type { GuestThreadDeliveryChannel, GuestThreadDeliveryStatus, InboxPhoto, InboxThreadKind } from '~/server/domain/guest-threads/types'

export type ConversationViewerRole = 'guest' | 'member'

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
  name: string
  image: string | null
  role: ConversationViewerRole
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
}

export interface ConversationDetails {
  photos: Array<InboxPhoto & { sent_at: string }>
  actions: { archive: boolean; unarchive: boolean; report: boolean; block: boolean; unblock: boolean }
}
