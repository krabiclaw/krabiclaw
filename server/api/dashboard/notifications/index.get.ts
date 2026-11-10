import { getQuery } from 'nitro/h3';
import { queryAll, queryFirst } from '~/server/db'
import { jsonResponse } from '~/server/utils/api-response'
import { getNotificationAccess } from '~/server/utils/notification-access'
import { bookingEditorPath, guestConversationPath } from '~/server/utils/dashboard-links'
import { CONVERSATION_NOTIFICATION_SQL, SCHEDULE_NOTIFICATION_SQL } from '~/server/utils/notification-center'

interface NotificationRow {
  id: string
  scope: 'global' | 'organization'
  template: string
  severity: 'info' | 'success' | 'warning' | 'error'
  organization_id: string | null
  location_id: string | null
  target_user_id: string | null
  title: string | null
  message: string | null
  thread_id: string | null
  stored_link: string | null
  organization_slug: string | null
  booking_kind: 'booking' | null
  stay_id: string | null
  read_at_destination: number
  conversation: number
  created_at: string
  read_at: string | null
}

/**
 * Where a notification opens. A thread notification names its thread and the
 * link is composed here from the organization's current slug, so a route change
 * or a rename never strands it. Anything else stores its own path.
 */
function deepLink(row: NotificationRow): string | null {
  if (row.organization_slug && row.stay_id) return bookingEditorPath(row.organization_slug, 'stay', row.stay_id)
  if (row.thread_id && row.organization_slug) {
    if (row.booking_kind === 'booking') return bookingEditorPath(row.organization_slug, row.booking_kind, row.thread_id)
    if (row.conversation) return guestConversationPath(row.organization_slug, row.thread_id)
  }
  return row.stored_link
}

export default defineHandler(async (event) => {
  const access = await getNotificationAccess(event)
  const query = getQuery(event)
  const rawLimit = Number(query.limit ?? 20)
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 20
  if (query.after !== undefined && (typeof query.after !== 'string' || !query.after)) throw new HTTPError({ statusCode: 400, statusMessage: 'A notification page cursor is required' })
  const cursor = query.after === undefined ? null : await queryFirst<{ id: string; created_at: string }>(access.db, `
    SELECT n.id, n.created_at FROM activity_entries n WHERE ${access.whereSql} AND n.id = ?
  `, [...access.whereParams, query.after])
  if (query.after !== undefined && !cursor) throw new HTTPError({ statusCode: 404, statusMessage: 'Notification page cursor not found' })

  const [rows, count] = await Promise.all([
    queryAll<NotificationRow>(access.db, `
      SELECT n.id, n.scope_kind AS scope, n.event_name AS template, json_extract(n.payload_json, '$.severity') AS severity, n.organization_id, n.location_id, n.target_user_id, json_extract(n.payload_json, '$.title') AS title, n.body AS message,
             json_extract(n.payload_json, '$.thread_id') AS thread_id, json_extract(n.payload_json, '$.deep_link') AS stored_link,
             (SELECT slug FROM organization WHERE id = n.organization_id) AS organization_slug,
             CASE WHEN ${SCHEDULE_NOTIFICATION_SQL} AND booking.product_session_id IS NOT NULL THEN 'booking' END AS booking_kind,
             CASE WHEN ${SCHEDULE_NOTIFICATION_SQL} THEN COALESCE(CASE WHEN booking.product_session_id IS NULL THEN booking.id END, json_extract(n.payload_json, '$.stay_id')) END AS stay_id,
             CASE WHEN ${CONVERSATION_NOTIFICATION_SQL} THEN 1 ELSE 0 END AS conversation,
             CASE WHEN n.scope_kind = 'organization' AND (${SCHEDULE_NOTIFICATION_SQL} OR ${CONVERSATION_NOTIFICATION_SQL}
               OR n.event_name IN ('task_assigned', 'task_starting')) THEN 1 ELSE 0 END AS read_at_destination,
             n.created_at, nr.read_at
      FROM activity_entries n
      LEFT JOIN requests request ON request.id = json_extract(n.payload_json, '$.thread_id') AND request.organization_id = n.organization_id
      LEFT JOIN bookings booking ON booking.request_id = request.id AND booking.organization_id = n.organization_id
      LEFT JOIN (SELECT parent_id, MAX(occurred_at) AS read_at FROM activity_entries WHERE kind = 'acknowledgement' AND actor_user_id = ? GROUP BY parent_id) nr ON nr.parent_id = n.id
      WHERE ${access.whereSql}${cursor ? ' AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))' : ''}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?
    `, [access.userId, ...access.whereParams, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []), limit + 1]), queryFirst<{ count: number }>(access.db, `
      SELECT COUNT(*) AS count
      FROM activity_entries n
      LEFT JOIN (SELECT parent_id, MAX(occurred_at) AS read_at FROM activity_entries WHERE kind = 'acknowledgement' AND actor_user_id = ? GROUP BY parent_id) nr ON nr.parent_id = n.id
      WHERE ${access.whereSql} AND nr.read_at IS NULL
    `, [access.userId, ...access.whereParams]), ])

  if (!count || !Number.isSafeInteger(count.count) || count.count < 0) throw new HTTPError({ statusCode: 500, statusMessage: 'Notification count could not be loaded' })
  const page = rows.slice(0, limit)
  return jsonResponse({
    notifications: page.map(row => {
      const { thread_id: _thread, stored_link: _link, organization_slug: _org, booking_kind: _kind, stay_id: _stay, conversation: _conversation, ...notification } = row
      return { ...notification, deep_link: deepLink(row), read_at_destination: row.read_at_destination === 1 }
    }),
    next_cursor: rows.length > limit ? page.at(-1)!.id : null,
    unread_count: count.count,
  })
})
import { defineHandler, HTTPError } from 'nitro';
