interface DashboardInvalidationBase {
  eventId: string
  organizationId: string
  occurredAt: string
}

/**
 * A conversation's gateway events, by Discord's names: a message was written
 * (MESSAGE_CREATE), a message or the conversation changed, such as a
 * delivery receipt or a block (MESSAGE_UPDATE). A team conversation's reach
 * only its participants.
 */
export interface ConversationEvent extends DashboardInvalidationBase {
  type: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE'
  conversationId: string
  locationId: string | null
  team: boolean
}

/** One person's read position or archive moved (MESSAGE_ACK); it reaches only them. */
export interface ConversationAck extends DashboardInvalidationBase {
  type: 'MESSAGE_ACK'
  conversationId: string
  targetUserId: string
}

/** Home changes have no stay; calendar edits and imports have no stay either. */
export interface StayInvalidation extends DashboardInvalidationBase {
  type: 'stay.changed' | 'nights.changed'
  locationId: string
  productId: string
  stayId: string | null
}

/** One person left a conversation or lost access to it; contains no conversation content. */
export interface ConversationLeave extends DashboardInvalidationBase {
  type: 'CONVERSATION_LEAVE'
  conversationId: string
  targetUserId: string
}

/** A content-free prompt to re-read the caller's current authorized scope. */
export interface AccessInvalidation extends DashboardInvalidationBase {
  type: 'access.changed'
}

/** Source work changed; each viewer re-reads its own authorized business scope. */
export interface BusinessInvalidation extends DashboardInvalidationBase {
  type: 'business.changed'
}

export type DashboardInvalidation = ConversationEvent | ConversationAck | ConversationLeave | StayInvalidation | AccessInvalidation | BusinessInvalidation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDashboardInvalidation(value: unknown): value is DashboardInvalidation {
  if (!isRecord(value)
    || typeof value.eventId !== 'string' || !value.eventId
    || typeof value.organizationId !== 'string' || !value.organizationId
    || typeof value.occurredAt !== 'string' || !value.occurredAt) return false

  if (value.type === 'access.changed' || value.type === 'business.changed') return Object.keys(value).every(key => ['type', 'eventId', 'organizationId', 'occurredAt'].includes(key))
  if (value.type === 'MESSAGE_ACK' || value.type === 'CONVERSATION_LEAVE') return typeof value.conversationId === 'string' && Boolean(value.conversationId)
    && typeof value.targetUserId === 'string' && Boolean(value.targetUserId)

  if (!(value.locationId === null || typeof value.locationId === 'string')) return false

  if (value.type === 'stay.changed' || value.type === 'nights.changed') {
    return typeof value.locationId === 'string' && Boolean(value.locationId)
      && typeof value.productId === 'string' && Boolean(value.productId)
      && (value.stayId === null || (typeof value.stayId === 'string' && Boolean(value.stayId)))
  }

  return (value.type === 'MESSAGE_CREATE' || value.type === 'MESSAGE_UPDATE')
    && typeof value.conversationId === 'string' && Boolean(value.conversationId) && typeof value.team === 'boolean'
}
