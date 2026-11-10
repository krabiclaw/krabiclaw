import type { ConversationEvent, DashboardInvalidation, StayInvalidation } from '~/shared/dashboard-invalidations'
import { queryFirst, type DbClient } from '~/server/db'
import { HTTPError } from 'nitro'

export interface GuestInboxPublicationEnv {
  GUEST_INBOX_HUBS?: DurableObjectNamespace
}

/** A message was written in a conversation, or it or the conversation changed: the gateway tells who may see it. */
export async function publishConversationEvent(
  env: GuestInboxPublicationEnv,
  db: DbClient,
  input: { conversationId: string; type: ConversationEvent['type'] },
): Promise<void> {
  const conversation = await queryFirst<{ id: string; organization_id: string; location_id: string | null; kind: string }>(db,
    'SELECT id, organization_id, location_id, kind FROM conversations WHERE id = ?', [input.conversationId])
  if (!conversation) throw new Error(`Conversation ${input.conversationId} not found for publication`)
  await publishDashboardInvalidation(env, {
    eventId: crypto.randomUUID(),
    type: input.type,
    organizationId: conversation.organization_id,
    locationId: conversation.location_id,
    conversationId: conversation.id,
    team: conversation.kind === 'team',
    occurredAt: new Date().toISOString(),
  })
}

/** One person's read position or archive moved; only their own apps hear it. */
export async function publishConversationAck(env: GuestInboxPublicationEnv, input: { organizationId: string; conversationId: string; targetUserId: string }): Promise<void> {
  await publishDashboardInvalidation(env, { ...input, eventId: crypto.randomUUID(), type: 'MESSAGE_ACK', occurredAt: new Date().toISOString() })
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

/** Every still-authorized member reconciles its own resource access. */
export async function publishAccessInvalidation(env: GuestInboxPublicationEnv, input: { organizationId: string }): Promise<void> {
  try {
    await publishDashboardInvalidation(env, {
      eventId: crypto.randomUUID(), type: 'access.changed', organizationId: input.organizationId, occurredAt: new Date().toISOString(),
    })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'Access changed, but open apps could not be told. Retry the same operation to refresh them.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, organization_id: input.organizationId }, cause })
  }
}

/** Carries no business facts; clients must read their current authorized projection. */
export async function publishBusinessInvalidation(env: GuestInboxPublicationEnv, organizationId: string): Promise<void> {
  try {
    await publishDashboardInvalidation(env, {
      eventId: crypto.randomUUID(), type: 'business.changed', organizationId, occurredAt: new Date().toISOString(),
    })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The change was saved, but open dashboards could not be updated. Reload before retrying.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, organization_id: organizationId }, cause })
  }
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
