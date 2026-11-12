import { queryAll, type DbClient } from '~/server/db'

export interface DashboardEvent {
  id: string
  event_name: string
  organization_id: string | null
  location_id: string | null
  entity_type: string | null
  entity_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  actor_user_id: string | null
  location_title: string | null
}

export interface DashboardEventsQuery {
  limit?: number
  location_id?: string
  event_name?: string
  actor_user_id?: string
  before?: string
}

export async function listDashboardEvents(
  db: DbClient,
  organizationId: string,
  query: DashboardEventsQuery,
): Promise<{ events: DashboardEvent[]; next_cursor: string | null }> {
  const limit = Math.max(1, Math.min(query.limit || 20, 50))
  const conditions = ['e.organization_id = ?']
  const params: unknown[] = [organizationId]
  if (query.location_id) { conditions.push('e.location_id = ?'); params.push(query.location_id) }
  if (query.event_name) { conditions.push('e.event_name = ?'); params.push(query.event_name) }
  if (query.actor_user_id) { conditions.push('e.actor_user_id = ?'); params.push(query.actor_user_id) }
  if (query.before) {
    const separator = query.before.lastIndexOf('|')
    if (separator === -1) {
      conditions.push('e.created_at < ?')
      params.push(query.before)
    } else {
      const createdAt = query.before.slice(0, separator)
      conditions.push('(e.created_at < ? OR (e.created_at = ? AND e.id < ?))')
      params.push(createdAt, createdAt, query.before.slice(separator + 1))
    }
  }
  params.push(limit)

  const rows = await queryAll<DashboardEvent & { metadata: string | null }>(db, `
    SELECT e.id, e.event_name, e.organization_id, e.location_id, json_extract(e.payload_json, '$.entityType') AS entity_type, json_extract(e.payload_json, '$.entityId') AS entity_id, json_extract(e.payload_json, '$.metadata') AS metadata, e.created_at,
           e.actor_user_id,
           l.title AS location_title
    FROM activity_entries e
    LEFT JOIN business_locations l ON l.id = e.location_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ?
  `, params)
  const last = rows[rows.length - 1]
  return {
    events: rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
    })),
    next_cursor: rows.length === limit && last ? `${last.created_at}|${last.id}` : null,
  }
}
