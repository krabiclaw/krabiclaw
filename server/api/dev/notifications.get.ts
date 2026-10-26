import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { queryAll } from '~/server/db'
import { assertDevRouteAllowed } from '~/server/utils/dev-route-auth'

export default defineHandler(async (event) => {
  assertDevRouteAllowed(event)
  const db = cloudflareEnv(event).DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const query = getQuery(event)
  const organizationId = typeof query.organization_id === 'string' ? query.organization_id : null
  const locationId = typeof query.location_id === 'string' ? query.location_id : null
  const since = typeof query.since === 'string' ? query.since : null
  const limit = Math.min(Math.max(Number.parseInt(String(query.limit ?? '200'), 10) || 200, 1), 500)
  const filters: string[] = []
  const binds: Array<string | number> = []
  if (organizationId) { filters.push('gt.organization_id = ?'); binds.push(organizationId) }
  if (locationId) { filters.push('gt.location_id = ?'); binds.push(locationId) }
  if (since) { filters.push('d.created_at >= ?'); binds.push(since) }

  const notifications = await queryAll(db, `
    SELECT id, organization_id, location_id, parent_id AS source_entry_id,
           scope_kind AS scope, json_extract(payload_json, '$.severity') AS severity, event_name AS template, json_extract(payload_json, '$.title') AS title, created_at
    FROM activity_entries
    WHERE kind = 'notification'
      AND (? IS NULL OR organization_id = ?)
      AND (? IS NULL OR location_id = ?)
      AND (? IS NULL OR created_at >= ?)
    ORDER BY created_at DESC
    LIMIT ?
  `, [organizationId, organizationId, locationId, locationId, since, since, limit])
  const deliveries = await queryAll(db, `
    SELECT d.id, e.request_id, d.entry_id, d.channel, d.provider, d.purpose,
           d.status, d.provider_message_id, d.email_json, d.email_message_id, d.error, d.created_at, d.updated_at
    FROM guest_thread_deliveries d
    JOIN activity_entries e ON e.id = d.entry_id
    JOIN requests gt ON gt.id = e.request_id
    ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY d.created_at DESC
    LIMIT ?
  `, [...binds, limit])

  return jsonResponse({ notifications, deliveries })
})
