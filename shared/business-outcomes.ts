import { CONVERSION_EVENT_CATALOG, type ConversionValue, type OrganizationConversionEventName } from '../utils/organization-conversion-events'
import type { AttributionTouch } from '../utils/analytics-attribution'

/** The existing business facts exposed by the progress projection. Intent/feedback and publication claims are not results. */
export const BUSINESS_ACTIVITY_EVENTS = [
  'article.created', 'article.updated', 'article.published',
  'post.created', 'post.published', 'post.deleted', 'post.channel_deleted',
  'product.created', 'product.updated', 'product.deleted', 'product.reordered',
  'product.category_created', 'product.category_renamed', 'product.category_deleted',
  'content.updated', 'content.published', 'media.uploaded', 'media.deleted', 'media.placement_changed',
  'location.created', 'location.updated', 'review.received', 'review.replied',
  'stay.created', 'stay.updated', 'stay.cancelled', 'stay.payment_recorded', 'stay.payment_deleted',
  'stay.nights_changed', 'stay.nights_imported', 'stay.calendar_linked', 'stay.calendar_unlinked', 'stay.instructions_updated',
  'team.message_sent', 'team.group_created', 'team.group_updated',
  'message_template.created', 'message_template.updated', 'message_template.deleted', 'scheduled_message.cancelled',
  'member.invited', 'member.role_changed', 'member.removed', 'member.access_scope_revoked',
  'google_ads.campaign_created', 'google_ads.campaign_updated', 'google_ads.campaign_change_unconfirmed', 'google_ads.campaign_change_failed',
  'thread.member_reply', 'thread.scheduled_message', 'thread.archived', 'thread.unarchived',
  'booking.confirm', 'booking.reject', 'booking.cancel', 'booking.no_show',
  'reservation.confirm', 'reservation.reject', 'reservation.cancel', 'reservation.no_show', 'stay.no_show',
  'booking_change.requested', 'booking_change.accepted', 'booking_change.declined', 'booking_change.withdrawn', 'booking_change.moved',
  'review.requested',
  'payment.payment_captured', 'payment.payment_failed', 'payment.refund_pending', 'payment.refund_succeeded', 'payment.refund_failed', 'payment.refund_canceled',
] as const
export const BUSINESS_MEASUREMENT_EVENTS = (Object.keys(CONVERSION_EVENT_CATALOG) as OrganizationConversionEventName[])
  .filter(name => CONVERSION_EVENT_CATALOG[name].kind === 'conversion')
export const BUSINESS_OUTCOME_EVENTS = [
  ...BUSINESS_ACTIVITY_EVENTS, 'post.publication', 'review.submitted', 'review.recorded',
  ...BUSINESS_MEASUREMENT_EVENTS.map(name => `measurement.${name}` as const),
] as const
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
  /** Activity keeps its stored ID. Other sources are namespaced; source.id is always the stored identity. */
  id: string
  source: { table: 'activity_entries' | 'post_publications' | 'reviews' | 'analytics_events'; id: string }
  event: BusinessOutcomeEvent
  subject: { kind: string; id: string }
  actor: { kind: 'guest' | 'member' | 'system' | 'cloudflare' | 'user' | 'agent' | 'unknown'; userId: string | null }
  occurredAt: string
  /** The recorded domain state, not an invented universal completion state. */
  state: string | null
  changedFields: string[]
  requestedFields?: string[]
  revision: string | null
  references: Array<{ kind: string; id: string }>
  /** Existing metadata and recorded beforeState/afterState, including booleans and source revisions; no inferred completion. */
  details?: Record<string, unknown>
  value?: ConversionValue
  moneyOwner?: 'customer_business' | 'platform'
  measurement?: {
    stage: string
    surface: string
    conversionType: string | null
    attribution: AttributionTouch | null
    attributedAt: string | null
    originEventId: string | null
    assignedMemberId: string | null
  }
  verification: {
    status: 'verified' | 'unconfirmed' | 'failed'
    basis: 'persisted_change' | 'stored_web_reply' | 'provider_acceptance' | 'provider_publication' | 'recorded_conversion'
    receipts: BusinessOutcomeReceipt[]
  }
}

export interface BusinessOutcomePage {
  outcomes: BusinessOutcome[]
  pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null }
  coverage: {
    supportedEvents: readonly BusinessOutcomeEvent[]
    sources: readonly BusinessOutcome['source']['table'][]
    attribution: 'recorded_actor_only'
    article: 'persisted_change_only'
    webReply: 'stored_message_only'
    externalReply: 'provider_acceptance_requires_receipt'
    verification: 'only_the_named_evidence_basis'
    unverified: readonly ['public_visibility', 'operation_completion', 'recipient_notification', 'conversation_resolution', 'business_goal_achievement', 'attendance_or_fulfilment', 'causal_revenue_attribution']
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
    latestMemberEntryId: string | null
    commitment: { kind: 'booking' | 'reservation' | 'stay'; id: string; status: string; startsAt: string; endsAt: string } | null
  }
}
