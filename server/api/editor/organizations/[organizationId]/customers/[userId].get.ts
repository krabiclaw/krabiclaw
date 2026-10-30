import { jsonResponse } from '~/server/utils/api-response'
import { queryAll, queryFirst } from '~/server/db'
import { requireOrganizationAccess } from '~/server/utils/location-access'

// A customer of this organization is a Better Auth user with activity here,
// not a stored profile. Who they said they were is read from their most recent
// thread's guest snapshot — never from the Better Auth user, whose email is a
// generated placeholder while the person is anonymous.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const userId = getRouterParam(event, 'userId')
  if (!organizationId || !userId) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  const { db } = await requireOrganizationAccess(event, organizationId)

  const latest = await queryFirst<ApiRecord>(db, `
    SELECT user_id AS id,
      json_extract(payload_json, '$.guest.name') AS name,
      json_extract(payload_json, '$.guest.email') AS email,
      json_extract(payload_json, '$.guest.phone') AS phone,
      id AS latest_request_id, kind AS latest_request_kind,
      (SELECT MIN(created_at) FROM requests WHERE organization_id = ? AND user_id = ?) AS first_seen_at,
      created_at AS last_seen_at
    FROM requests
    WHERE organization_id = ? AND user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [organizationId, userId, organizationId, userId])
  if (!latest) return jsonResponse({ error: 'Customer not found' }, { status: 404 })

  // When and for how many live on the reservation, not on the thread: the
  // thread is the conversation, and the table held is its own row.
  const reservations = await queryAll<ApiRecord>(db, `
    SELECT r.id, res.location_id, json_extract(r.payload_json, '$.guest.name') AS name, json_extract(r.payload_json, '$.guest.email') AS email, json_extract(r.payload_json, '$.guest.phone') AS phone, res.starts_at, res.timezone, res.party_size || CASE WHEN json_extract(r.payload_json, '$.party_size_is_minimum') THEN '+' ELSE '' END AS guests, res.status, json_extract(r.payload_json, '$.completion.at') AS completed_at, json_extract(r.payload_json, '$.completion.source') AS completion_source, (SELECT MIN(rr.first_sent_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_request_sent_at, (SELECT MIN(rr.reminder_sent_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_reminder_sent_at, (SELECT MIN(rr.submitted_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_submitted_at, r.review_id, r.created_at
    FROM requests r JOIN reservations res ON res.request_id = r.id
    WHERE r.kind = 'reservation' AND r.organization_id = ? AND r.user_id = ?
    ORDER BY res.starts_at DESC, r.created_at DESC
    LIMIT 25
  `, [organizationId, userId])

  const bookings = await queryAll<ApiRecord>(db, `
    SELECT r.id, ps.location_id, b.product_id, p.name AS product_title, json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.guest.email') AS guest_email, json_extract(r.payload_json, '$.guest.phone') AS guest_phone, ps.starts_at, ps.timezone, b.party_size, b.status, json_extract(r.payload_json, '$.completion.at') AS completed_at, json_extract(r.payload_json, '$.completion.source') AS completion_source, (SELECT MIN(rr.first_sent_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_request_sent_at, (SELECT MIN(rr.reminder_sent_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_reminder_sent_at, (SELECT MIN(rr.submitted_at) FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id) AS review_submitted_at, r.review_id, r.created_at
    FROM requests r
    JOIN bookings b ON b.request_id = r.id
    JOIN product_sessions ps ON ps.id = b.product_session_id
    LEFT JOIN products p ON p.id = b.product_id
    WHERE r.kind = 'booking' AND r.organization_id = ? AND r.user_id = ?
    ORDER BY ps.starts_at DESC, r.created_at DESC
    LIMIT 25
  `, [organizationId, userId])

  const reviews = await queryAll<ApiRecord>(db, `
    SELECT id, location_id, rating, title, content, status, source, booking_type, booking_id, review_request_id, helpful_count, created_at, updated_at
    FROM reviews
    WHERE organization_id = ? AND user_id = ?
    ORDER BY created_at DESC
    LIMIT 25
  `, [organizationId, userId])

  const reviewRequests = await queryAll<ApiRecord>(db, `
    SELECT id, location_id, booking_type, booking_id, expires_at, first_sent_at, reminder_sent_at, submitted_at, clicked_at, revoked_at, send_count, last_error, user_id, created_at, updated_at
    FROM review_requests
    WHERE organization_id = ? AND user_id = ?
    ORDER BY created_at DESC
    LIMIT 25
  `, [organizationId, userId])

  return jsonResponse({
    customer: latest, reservations, bookings, reviews, reviewRequests, })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
