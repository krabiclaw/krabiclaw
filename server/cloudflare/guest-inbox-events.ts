import type { DashboardInvalidation, GuestThreadInvalidation, NotificationInvalidation, StayInvalidation } from '~/shared/dashboard-invalidations'
import { queryFirst, type DbClient } from '~/server/db'
import { HTTPError } from 'nitro'

export type GuestInboxEventType = GuestThreadInvalidation['type']

export interface GuestInboxPublicationEnv {
  GUEST_INBOX_HUBS?: DurableObjectNamespace
}

export async function publishGuestInboxThreadEvent(
  env: GuestInboxPublicationEnv,
  db: DbClient,
  input: {
    threadId: string
    type: GuestInboxEventType
  },
): Promise<void> {
  const thread = await queryFirst<{
    id: string
    organization_id: string
    location_id: string | null
  }>(db, `
    SELECT id, organization_id, location_id
    FROM requests
    WHERE id = ?
    LIMIT 1
  `, [input.threadId])
  if (!thread) throw new Error(`Guest thread ${input.threadId} not found for inbox publication`)
  await publishDashboardInvalidation(env, {
    eventId: crypto.randomUUID(),
    type: input.type,
    organizationId: thread.organization_id,
    locationId: thread.location_id,
    threadId: thread.id,
    occurredAt: new Date().toISOString(),
  })
}

export async function publishDashboardInvalidation(
  env: GuestInboxPublicationEnv,
  event: DashboardInvalidation,
): Promise<void> {
  if (!env.GUEST_INBOX_HUBS) {
    throw new HTTPError({ statusCode: 503, message: 'GUEST_INBOX_HUBS binding is not configured', data: { code: 'REALTIME_CONFIGURATION_REQUIRED', field: 'GUEST_INBOX_HUBS' } })
  }

  const hub = env.GUEST_INBOX_HUBS.get(env.GUEST_INBOX_HUBS.idFromName(event.organizationId))
  const request = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-krabiclaw-organization-id': event.organizationId,
    },
    body: JSON.stringify(event),
  }
  const publication = { eventId: event.eventId, type: event.type, organizationId: event.organizationId }
  // This broadcast is how an open dashboard learns a booking just arrived. A
  // transport error or a 5xx used to return quietly while a 4xx threw, so the
  // failures that meant the hub was actually broken were the ones that stayed
  // invisible and the tenant's inbox simply never updated.
  const response = await hub.fetch('https://guest-inbox.internal/broadcast', request)
  if (!response.ok) {
    console.error('dashboard_invalidation_transport_failed', { ...publication, status: response.status })
    throw new HTTPError({ statusCode: 503, message: `Dashboard invalidation publication failed with HTTP ${response.status}`, data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', publicationStatus: response.status } })
  }
}

export async function publishNotificationInvalidation(
  env: GuestInboxPublicationEnv,
  input: Omit<NotificationInvalidation, 'eventId' | 'occurredAt'>,
): Promise<void> {
  await publishDashboardInvalidation(env, {
    ...input,
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
  })
}

export async function publishStayInvalidation(
  env: GuestInboxPublicationEnv,
  input: Omit<StayInvalidation, 'eventId' | 'occurredAt'>,
  committed: { version: number } | { updated_at: string },
): Promise<void> {
  try {
    await publishDashboardInvalidation(env, {
      ...input,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The change was saved, but dashboard updates could not be published. Reload before retrying.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, product_id: input.productId, stay_id: input.stayId, ...committed }, cause })
  }
}
