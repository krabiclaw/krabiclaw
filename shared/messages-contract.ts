import type { GuestThreadDeliveryChannel, GuestThreadDeliveryStatus, InboxStreamItem, InboxThread } from '~/server/domain/guest-threads/types'
import type { TeamThread } from '~/server/domain/team-messages'

export type ConversationViewerRole = 'guest' | 'member'

export interface ConversationDelivery {
  id: string
  channel: GuestThreadDeliveryChannel
  status: GuestThreadDeliveryStatus
  error: string | null
  updated_at: string
}

export type ConversationMessage = Extract<InboxStreamItem, { type: 'message' }> & {
  sequence: number
  author_user_id: string | null
  automatic: boolean
  deliveries: ConversationDelivery[]
}

export type ConversationEntry =
  | Extract<InboxStreamItem, { type: 'day' }>
  | (Extract<InboxStreamItem, { type: 'event' }> & { sequence: number })
  | ConversationMessage

export interface ConversationParticipant {
  id: string | null
  name: string
  member_id: string | null
  image: string | null
  role: ConversationViewerRole
  can_remove: boolean
}

export type ConversationHeader =
  | (Omit<InboxThread, 'stream'> & { kind: 'guest' | 'support'; organization_id: string; participants: ConversationParticipant[] })
  | (Omit<TeamThread, 'participants'> & { kind: 'team'; organization_id: string; title: string; participants: ConversationParticipant[] })

export interface ConversationPage {
  conversation: ConversationHeader
  entries: ConversationEntry[]
  page: {
    before: number | null
    oldest: number | null
    newest: number | null
    read_through: number | null
    failed_messages: string[]
  }
  viewer_role: ConversationViewerRole
  capabilities: {
    can_send: boolean
    can_manage_participants: boolean
    can_invite_guest: boolean
    can_leave: boolean
    can_view_read_receipts: boolean
  }
}
