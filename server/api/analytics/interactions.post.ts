import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { HOUR_MS, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { boundedOccurrence, isCanonicalEventId } from '~/server/utils/pageview-tracking'
import { BROWSER_INTERACTION_EVENT_NAMES, CONVERSION_EVENT_CATALOG, type OrganizationConversionEventName } from '~/utils/organization-conversion-events'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import type { InsightsClickEvent } from '~/shared/insights'

const SIGNED_IN_EVENTS = new Set<string>(BROWSER_INTERACTION_EVENT_NAMES.filter(name => CONVERSION_EVENT_CATALOG[name].origin === 'authenticated'))

// A signed-in Blawby user's product usage. It is measured on the platform organization; the
// signed-in user is the actor, and the organization they were working on (which they must belong
// to) is the subject. Only the catalog's allowlisted scalar properties are kept.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database unavailable' }, { status: 503 })
  const organizationId = typeof event.context.organizationId === 'string' ? event.context.organizationId : ''
  if (event.context.tenantType !== TENANT_TYPES.PLATFORM || !organizationId) return jsonResponse({ error: 'Signed-in interactions are measured on the platform' }, { status: 400 })
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const body = await readBody(event) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Invalid analytics payload' }, { status: 400 })
  const eventName = typeof body.event_name === 'string' ? body.event_name : ''
  if (!SIGNED_IN_EVENTS.has(eventName)) return jsonResponse({ error: 'Invalid event_name' }, { status: 400 })
  if (!isCanonicalEventId(body.event_id)) return jsonResponse({ error: 'event_id must be a UUID' }, { status: 400 })
  const rule = CONVERSION_EVENT_CATALOG[eventName as OrganizationConversionEventName]

  let subjectOrganizationId: string | null = null
  if (typeof body.organization_id === 'string' && body.organization_id) {
    const member = await queryFirst<{ id: string }>(env.DB, 'SELECT id FROM member WHERE "organizationId" = ? AND "userId" = ? LIMIT 1', [body.organization_id, session.user.id])
    if (!member) return jsonResponse({ error: 'Organization not found' }, { status: 403 })
    subjectOrganizationId = body.organization_id
  }
  if (rule.entityType === 'organization' && !subjectOrganizationId) return jsonResponse({ error: 'organization_id is required' }, { status: 400 })

  if (!await incrementHourlyRateLimit(env.DB, `rate:interaction:${session.user.id}:${new Date().toISOString().slice(0, 13)}`, import.meta.dev ? 100_000 : 1_200, HOUR_MS)) {
    return jsonResponse({ error: 'Too many events. Please try again later.' }, { status: 429 })
  }

  const result = await recordOrganizationConversionEvent(env.DB, event.req, {
    // Signed-in product usage is never one of the website clicks Insights counts (those are public).
    organizationId, eventName: eventName as Exclude<OrganizationConversionEventName, InsightsClickEvent>, stage: 'occurred', surface: 'dashboard',
    ...(subjectOrganizationId ? { entityType: 'organization' as const, entityId: subjectOrganizationId } : {}),
    actor: { type: 'user', id: session.user.id },
    id: body.event_id, properties: body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties) ? body.properties as Record<string, unknown> : null,
    originEventId: readPageEventId(body.page_event_id),
    occurredAt: boundedOccurrence(body.occurred_at, new Date().toISOString()),
  })
  return jsonResponse({ success: true, id: result.id, recorded: result.created }, { status: result.created ? 201 : 200 })
})
