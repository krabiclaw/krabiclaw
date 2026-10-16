interface DashboardInvalidationBase {
  eventId: string
  organizationId: string
  occurredAt: string
}

export interface GuestThreadInvalidation extends DashboardInvalidationBase {
  type: 'thread.created' | 'thread.changed' | 'entry.appended' | 'delivery.changed'
  locationId: string | null
  threadId: string
}

export interface NotificationInvalidation extends DashboardInvalidationBase {
  type: 'notification.created' | 'notification.read'
  locationId: string | null
  targetUserId: string | null
}

/** Home changes have no stay; calendar edits and imports have no stay either. */
export interface StayInvalidation extends DashboardInvalidationBase {
  type: 'stay.changed' | 'nights.changed'
  locationId: string
  productId: string
  stayId: string | null
}

/** A team conversation gained a message or was started; only its members receive it. */
export interface TeamThreadInvalidation extends DashboardInvalidationBase {
  type: 'team_thread.changed'
  teamThreadId: string
}

export type DashboardInvalidation = GuestThreadInvalidation | NotificationInvalidation | StayInvalidation | TeamThreadInvalidation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDashboardInvalidation(value: unknown): value is DashboardInvalidation {
  if (!isRecord(value)
    || typeof value.eventId !== 'string' || !value.eventId
    || typeof value.organizationId !== 'string' || !value.organizationId
    || typeof value.occurredAt !== 'string' || !value.occurredAt) return false

  if (value.type === 'team_thread.changed') return typeof value.teamThreadId === 'string' && Boolean(value.teamThreadId)

  if (!(value.locationId === null || typeof value.locationId === 'string')) return false

  if (value.type === 'notification.created' || value.type === 'notification.read') {
    return value.targetUserId === null || typeof value.targetUserId === 'string'
  }

  if (value.type === 'stay.changed' || value.type === 'nights.changed') {
    return typeof value.locationId === 'string' && Boolean(value.locationId)
      && typeof value.productId === 'string' && Boolean(value.productId)
      && (value.stayId === null || (typeof value.stayId === 'string' && Boolean(value.stayId)))
  }

  return (value.type === 'thread.created'
    || value.type === 'thread.changed'
    || value.type === 'entry.appended'
    || value.type === 'delivery.changed')
    && typeof value.threadId === 'string' && Boolean(value.threadId)
}
