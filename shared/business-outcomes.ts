export const BUSINESS_OUTCOME_EVENTS = ['article.created', 'article.updated', 'article.published', 'thread.member_reply'] as const
export type BusinessOutcomeEvent = typeof BUSINESS_OUTCOME_EVENTS[number]
export type BusinessProgressOperation = 'article.update' | 'article.publish' | 'guest_thread.reply'

export interface BusinessOutcomeReceipt {
  id: string
  channel: string
  provider: string
  status: string
  providerMessageId: string | null
}

export interface BusinessOutcome {
  /** The canonical activity_entries id, shared across every presentation. */
  id: string
  event: BusinessOutcomeEvent
  subject: { kind: 'article' | 'guest_thread'; id: string }
  actor: { kind: 'guest' | 'member' | 'system' | 'cloudflare'; userId: string | null }
  occurredAt: string
  verification: {
    status: 'verified' | 'unconfirmed' | 'failed'
    basis: 'persisted_change' | 'stored_web_reply' | 'provider_acceptance'
    receipts: BusinessOutcomeReceipt[]
  }
}

export interface BusinessOutcomePage {
  outcomes: BusinessOutcome[]
  pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null }
  coverage: {
    supportedEvents: readonly BusinessOutcomeEvent[]
    attribution: 'recorded_actor_only'
    article: 'persisted_change_only'
    webReply: 'stored_message_only'
    externalReply: 'provider_acceptance_requires_receipt'
    unverified: readonly ['public_visibility', 'operation_completion', 'recipient_notification', 'conversation_resolution', 'business_goal_achievement']
  }
}

export interface BusinessProgressReference {
  operation: BusinessProgressOperation
  subjectId: string
  evidenceRevision: string
  evidence: {
    kind: 'article'
    status: string | null
    updatedAt: string
    activityEntryId: string | null
    media: Array<{ placementId: string; assetId: string; assetUpdatedAt: string }>
  } | {
    kind: 'guest_thread'
    conversationState: string
    archivedAt: string | null
    blockedAt: string | null
    latestGuestEntryId: string | null
    latestReplyEntryId: string | null
    commitment: { kind: 'booking' | 'reservation' | 'stay'; id: string; status: string; startsAt: string; endsAt: string } | null
  }
}
