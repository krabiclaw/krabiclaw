interface DashboardInvalidationBase {
  event_id: string
  organization_id: string
  occurred_at: string
}

/**
 * A conversation's gateway events, by Discord's names: a message was written
 * (MESSAGE_CREATE), a message or the conversation changed, such as a
 * delivery receipt or a block (MESSAGE_UPDATE). A team conversation's reach
 * only its participants.
 */
export interface MessageIdentity { id: string; sequence: number }

export function isMessageIdentity(value: unknown): value is MessageIdentity {
  return isRecord(value) && typeof value.id === 'string' && Boolean(value.id) && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
}

export interface ConversationEvent extends DashboardInvalidationBase {
  type: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE'
  conversation_id: string
  location_id: string | null
  team: boolean
  message?: MessageIdentity
}

/** One person's read position or archive moved (MESSAGE_ACK); it reaches only them. */
export interface ConversationAck extends DashboardInvalidationBase {
  type: 'MESSAGE_ACK'
  conversation_id: string
  user_id: string
}

/** Home changes have no stay; calendar edits and imports have no stay either. */
export interface StayInvalidation extends DashboardInvalidationBase {
  type: 'stay.changed' | 'nights.changed'
  location_id: string
  product_id: string
  booking_id: string | null
}

/** One person left a conversation or lost access to it; contains no conversation content. */
export interface ConversationLeave extends DashboardInvalidationBase {
  type: 'CONVERSATION_LEAVE'
  conversation_id: string
  user_id: string
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
    || typeof value.event_id !== 'string' || !value.event_id
    || typeof value.organization_id !== 'string' || !value.organization_id
    || typeof value.occurred_at !== 'string' || !value.occurred_at) return false

  if (value.type === 'access.changed' || value.type === 'business.changed') return Object.keys(value).every(key => ['type', 'event_id', 'organization_id', 'occurred_at'].includes(key))
  if (value.type === 'MESSAGE_ACK' || value.type === 'CONVERSATION_LEAVE') return typeof value.conversation_id === 'string' && Boolean(value.conversation_id)
    && typeof value.user_id === 'string' && Boolean(value.user_id)

  if (!(value.location_id === null || typeof value.location_id === 'string')) return false

  if (value.type === 'stay.changed' || value.type === 'nights.changed') {
    return typeof value.location_id === 'string' && Boolean(value.location_id)
      && typeof value.product_id === 'string' && Boolean(value.product_id)
      && (value.booking_id === null || (typeof value.booking_id === 'string' && Boolean(value.booking_id)))
  }

  return (value.type === 'MESSAGE_CREATE' || value.type === 'MESSAGE_UPDATE')
    && typeof value.conversation_id === 'string' && Boolean(value.conversation_id) && typeof value.team === 'boolean'
    && (value.message === undefined || isMessageIdentity(value.message))
}
