import { assertCalendarDate, isValidTimezone, instantDate, localDateAt, addLocalDays, localDateTimeToInstant } from '~/utils/timezone'
import { HTTPError } from 'nitro'
import { executeBatch, queryAll, type DbClient } from '~/server/db'
import { resolveOrganizationCmsCapabilities } from '~/server/utils/cms-capabilities'
import { assignedBookingSql, assignedHomeSql, roleAllows, assertRoleAllows, type ResolvedMembership } from '~/server/utils/member-access'
import type { CloudflareEnv } from '~/server/utils/auth'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { REQUEST_CURRENT_BUYER_SQL } from '~/server/domain/requests'
import { postEditorPath } from '~/server/utils/dashboard-links'

export const AGENDA_KINDS = ['reservation', 'booking', 'post', 'stay'] as const
export type AgendaKind = typeof AGENDA_KINDS[number]

export interface AgendaItem {
  assignedMemberId: string | null
  assignedMemberName: string | null
  id: string
  requestId: string | null
  operationalBookingId: string | null
  operationalReservationId: string | null
  /** The stay a `stay` row is an arrival or departure of; one stay is two rows. */
  stayId: string | null
  /** Whether a `stay` row is guests arriving or leaving; null for every other kind. */
  stayMoment: 'arrival' | 'departure' | null
  kind: AgendaKind
  startsAt: string
  endsAt: string | null
  dayKey: string
  timeZone: string
  showTimeZone: boolean
  title: string
  subtitle: string | null
  status: string
  organizationId: string
  locationId: string | null
  locationTitle: string | null
  guestImageUrl: string | null
  resourceImageUrl: string | null
  resourceTitle: string | null
  partySize: number | null
  to: string
}

export interface TodayAgendaPayload extends AgendaPayload {
  resolvedAt: string
}

export interface AgendaPrincipal {
  env: CloudflareEnv
  // The membership this request resolved, not loose fields: the scope reads
  // below authorize with it.
  membership: ResolvedMembership
}

/**
 * Whose agenda: a business's, which sees every guest it hosts, or a buyer's,
 * which sees the visits they currently own across every business. The same
 * rows and the same screens; only the owner condition differs.
 */
export type AgendaScope = { organizationId: string; buyerUserId?: undefined } | { buyerUserId: string; organizationId?: undefined }

export interface AgendaQuery {
  from: string
  to: string
  organizationId?: string
  locationId?: string
  assignedMemberId?: string
  kinds?: AgendaKind[]
  principal?: AgendaPrincipal
  organizationSlug?: string
}

export interface AgendaLocation {
  id: string
  organizationId: string
  title: string
  imageUrl: string | null
}

export interface AgendaPayload {
  items: AgendaItem[]
  availableKinds: AgendaKind[]
  locations: AgendaLocation[]
}

interface SourceRow {
  assigned_member_id: string | null
  assigned_member_name: string | null
  id: string
  operational_id: string | null
  kind: AgendaKind
  starts_at: string | null
  ends_at: string | null
  title: string
  subtitle: string | null
  status: string
  organization_id: string
  organization_name: string | null
  location_id: string | null
  location_title: string | null
  timezone: string | null
  guest_image_url: string | null
  picture_owner_type: PictureOwnerType
  picture_owner_id: string
  resource_title: string | null
  party_size: number | null
}

interface CapabilityOrganizationRow {
  id: string
  name: string | null
  subdomain: string | null
  vertical: string
  theme_id: string
}

interface LocationRow {
  id: string
  organization_id: string
  title: string
}

function scopeParams(scope: AgendaScope, query: AgendaQuery): unknown[] {
  const params: unknown[] = [scope.buyerUserId ?? scope.organizationId]
  if (query.organizationId) params.push(query.organizationId)
  if (query.locationId) params.push(query.locationId)
  return params
}

// A buyer's row is one whose request they still own, which is the same
// condition the account's activity and conversations read with.
function scopeConditions(scope: AgendaScope, query: AgendaQuery, alias: string): string {
  return [
    scope.buyerUserId
      ? `${alias}.user_id = ? AND EXISTS (SELECT 1 FROM requests r WHERE r.id = ${alias}.id AND ${REQUEST_CURRENT_BUYER_SQL})`
      : `${alias}.organization_id = ?`,
    query.organizationId ? `AND ${alias}.organization_id = ?` : '',
    query.locationId ? `AND ${alias}.location_id = ?` : '',
  ].filter(Boolean).join('\n')
}

export function parseAgendaQuery(query: Record<string, unknown>): { from: string; to: string; kinds: AgendaKind[] | undefined } {
  const stringQuery = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : undefined
  const from = stringQuery(query.from)
  const to = stringQuery(query.to)
  if (!from || !to) throw new HTTPError({ statusCode: 400, statusMessage: 'from and to are required' })
  const kinds = stringQuery(query.kinds)?.split(',').map(kind => kind.trim()).filter((kind): kind is AgendaKind => AGENDA_KINDS.includes(kind as AgendaKind))
  return { from, to, kinds }
}

// The picture an agenda row shows is its owner's, as resolveOwnerPicture
// answers it: a reservation's location, a booking's or class's experience, a
// post's own cover. The row names the owner; the resolver decides the picture.
type PictureOwnerType = 'business_location' | 'product' | 'content_document' | 'organization'

function locationPictureOwner(alias: string) {
  return {
    type: `CASE WHEN ${alias}.location_id IS NULL THEN 'organization' ELSE 'business_location' END`,
    id: `COALESCE(${alias}.location_id, ${alias}.organization_id)`,
  }
}

export async function listAgenda(
  db: DbClient,
  scope: AgendaScope,
  query: AgendaQuery,
): Promise<AgendaPayload> {
  assertCalendarDate(query.from)
  assertCalendarDate(query.to)
  if (query.from > query.to) throw new Error('from must not be after to')

  const staff = query.principal && !await roleAllows({ ...query.principal.membership, permissions: { operations: ['read'] } })
    ? query.principal.membership : null
  if (staff) await assertRoleAllows({ ...staff, permissions: { operations: ['assigned'] } })

  // One round trip reads everything the scope alone decides: the businesses in
  // scope, whether any has ever taken a booking or a reservation, and the
  // business's branches. Each statement used to wait for the one before it.
  const scopeSql = scope.buyerUserId
    ? `IN (SELECT r.organization_id FROM requests r WHERE r.user_id = ? AND ${REQUEST_CURRENT_BUYER_SQL})`
    : '= ?'
  const scopeParam = scope.buyerUserId ?? scope.organizationId
  const [capabilityResult, bookableResult, reservingResult, locationResult, hostingResult] = await executeBatch(db, [
    { query: `SELECT s.id, s.name, s.subdomain, s.vertical, s.theme_id FROM organization s WHERE s.id ${scopeSql} ORDER BY s.id`, params: [scopeParam] },
    { query: `SELECT 1 AS present FROM product_booking_configs WHERE organization_id ${scopeSql} LIMIT 1`, params: [scopeParam] },
    { query: `SELECT 1 AS present FROM reservations WHERE organization_id ${scopeSql} LIMIT 1`, params: [scopeParam] },
    // A buyer's calendar is not filtered by branch; the business's is.
    { query: `SELECT l.id, l.organization_id, l.title FROM business_locations l WHERE l.organization_id = ? AND l.organization_id ${scopeSql} ORDER BY l.title, l.id`, params: [scope.organizationId ?? '', scopeParam] },
    // A business with a place to stay has arrivals and departures; a buyer's agenda has none.
    { query: 'SELECT 1 AS present FROM product_stay_configs WHERE organization_id = ? LIMIT 1', params: [scope.organizationId ?? ''] },
  ], { operation: 'Read the agenda scope' })
  const capabilityOrganizations = (capabilityResult?.results ?? []) as CapabilityOrganizationRow[]
  const locations = scope.organizationId ? (locationResult?.results ?? []) as LocationRow[] : []
  // A buyer has visits, not a publishing calendar.
  const available = new Set<AgendaKind>(scope.buyerUserId || staff ? [] : ['post'])
  for (const organization of capabilityOrganizations) {
    const { capabilities } = resolveOrganizationCmsCapabilities(organization.vertical, organization.theme_id)
    const features = new Set([...capabilities.pages.map(page => page.feature), ...capabilities.managers.map(manager => manager.id)])
    if (!staff && features.has('reservations')) available.add('reservation')
    // A class's schedule is the product's own; the calendar carries who is
    // coming to it, not every session it could run.
    if (features.has('products')) available.add('booking')
  }
  // A business that has taken bookings or reservations sees them whatever its
  // site template says: the record exists, so the calendar shows it.
  if (capabilityOrganizations.length) {
    if (bookableResult?.results?.length) available.add('booking')
    if (!staff && reservingResult?.results?.length) available.add('reservation')
  }
  if (scope.organizationId && hostingResult?.results?.length) available.add('stay')
  const availableKinds = AGENDA_KINDS.filter(kind => available.has(kind))
  const requestedKinds = new Set((query.kinds?.length ? query.kinds : availableKinds).filter(kind => available.has(kind)))
  if (requestedKinds.size === 0) {
    return {
      items: [], availableKinds,
      locations: [],
    }
  }

  const sourceQueries: Promise<SourceRow[]>[] = []
  const broadFrom = `${addLocalDays(query.from, -2)}T00:00:00.000Z`
  const broadTo = `${addLocalDays(query.to, 2)}T23:59:59.999Z`
  const commonSelect = (alias: string, kind: AgendaKind, fields: string, enrichment: {
    joins?: string
    pictureOwner?: { type: string; id: string }
    resourceTitle?: string
    assignedMember?: string
    /** The zone the row's instant was offered in; a post has none and reads the business's. */
    timezone?: string
  } = {}) => `
    SELECT ${enrichment.assignedMember??'NULL'} assigned_member_id, ${enrichment.assignedMember?`(SELECT u.name FROM member m JOIN user u ON u.id=m.userId WHERE m.id=${enrichment.assignedMember} AND m.organizationId=${alias}.organization_id)`:'NULL'} assigned_member_name, ${alias}.id, ${kind === 'booking' ? 'agenda_booking.id' : kind === 'reservation' ? 'agenda_reservation.id' : 'NULL'} AS operational_id, '${kind}' AS kind, ${fields}, ${alias}.organization_id,
           s.name AS organization_name,
           ${alias}.location_id,
           l.title AS location_title,
           ${enrichment.timezone ?? 's.timezone'} AS timezone,
           ${kind === 'post' ? 'NULL' : `(SELECT u.image FROM user u WHERE u.id = ${alias}.user_id)`} AS guest_image_url,
           ${(enrichment.pictureOwner ?? locationPictureOwner(alias)).type} AS picture_owner_type,
           ${(enrichment.pictureOwner ?? locationPictureOwner(alias)).id} AS picture_owner_id,
           ${enrichment.resourceTitle ?? 'COALESCE(l.title, s.name, s.subdomain, s.id)'} AS resource_title
    FROM ${kind === 'post' ? 'content_documents' : 'requests'} ${alias}
    JOIN organization s ON s.id = ${alias}.organization_id
    LEFT JOIN business_locations l ON l.id = ${alias}.location_id AND l.organization_id = ${alias}.organization_id
    
    ${enrichment.joins ?? ''}
    WHERE ${kind === 'post' ? `${alias}.kind = 'social_post' AND ${alias}.row_role = 'root' AND ` : `${alias}.kind = '${kind}' AND `}${scopeConditions(scope, query, alias)}
  `
  const params = () => scopeParams(scope, query)

  // A held table and a booked seat are their own rows, and each states one
  // instant in its own zone. The window here is deliberately broad in UTC; the
  // day a row belongs to is decided below, in that row's zone.
  if (requestedKinds.has('reservation')) sourceQueries.push(queryAll(db, `${commonSelect('r', 'reservation', `agenda_reservation.starts_at, agenda_reservation.ends_at,
    json_extract(r.payload_json, '$.guest.name') AS title, printf('%d%s guests', agenda_reservation.party_size, CASE json_extract(r.payload_json, '$.party_size_is_minimum') WHEN 1 THEN '+' ELSE '' END) AS subtitle, agenda_reservation.party_size, agenda_reservation.status`, {
    joins: 'JOIN reservations agenda_reservation ON agenda_reservation.request_id = r.id',
    timezone: 'agenda_reservation.timezone',
  })} AND agenda_reservation.status <> 'cancelled' AND agenda_reservation.starts_at BETWEEN ? AND ?`, [...params(), broadFrom, broadTo]))
  if (requestedKinds.has('booking')) sourceQueries.push(queryAll(db, `${commonSelect('b', 'booking', `agenda_session.starts_at, agenda_session.ends_at,
    json_extract(b.payload_json, '$.guest.name') AS title, printf('%d guests', agenda_booking.party_size) AS subtitle, agenda_booking.party_size AS party_size, agenda_booking.status`, {
    joins: `JOIN bookings agenda_booking ON agenda_booking.request_id = b.id
      JOIN product_sessions agenda_session ON agenda_session.id = agenda_booking.product_session_id
      LEFT JOIN products agenda_product ON agenda_product.id = agenda_booking.product_id AND agenda_product.organization_id = agenda_booking.organization_id`,
    assignedMember:'agenda_booking.assigned_member_id',
    timezone: 'agenda_session.timezone',
    pictureOwner: { type: `'product'`, id: 'agenda_booking.product_id' },
    resourceTitle: 'COALESCE(agenda_product.name, l.title, s.name, s.subdomain, s.id)',
  })} ${staff ? `AND (${assignedBookingSql('agenda_booking')})` : ''} AND agenda_booking.status <> 'cancelled' AND agenda_session.starts_at BETWEEN ? AND ?`, [...params(), ...(staff ? [staff.userId] : []), broadFrom, broadTo]))
  // A post is on the agenda on the day it was published; nothing is due.
  if (requestedKinds.has('post')) sourceQueries.push(queryAll(db, `${commonSelect('p', 'post', `p.published_at AS starts_at, NULL AS ends_at,
    NULLIF(p.title, '') AS title, NULL AS subtitle, NULL AS party_size, p.status`, {
    pictureOwner: { type: `'content_document'`, id: 'p.id' },
  })}
    AND p.status = 'published' AND p.published_at BETWEEN ? AND ?`, [...params(), broadFrom, broadTo]))

  // A stay is two moments at its home: guests arrive on the check-in date at the
  // home's check-in time and leave on the checkout date at its checkout time,
  // both in the location's zone. Members see the homes they look after.
  const stayRows = requestedKinds.has('stay') && scope.organizationId ? queryAll<{
    id: string; organization_id: string; product_id: string; product_name: string; status: string; check_in_date: string; check_out_date: string
    guest_name: string | null; guest_surname: string | null; party_size: number; location_id: string; location_title: string; timezone: string; check_in_time: string; check_out_time: string
  }>(db, `SELECT st.id, st.organization_id, st.product_id, p.name AS product_name, st.status, st.check_in_date, st.check_out_date, st.guest_name, st.guest_surname,
        st.adults + st.children AS party_size, c.location_id, l.title AS location_title, l.timezone, c.check_in_time, c.check_out_time
      FROM stays st
      JOIN product_stay_configs c ON c.organization_id = st.organization_id AND c.product_id = st.product_id
      JOIN products p ON p.organization_id = st.organization_id AND p.id = st.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE st.organization_id = ? AND st.status <> 'cancelled' AND (st.check_in_date BETWEEN ? AND ? OR st.check_out_date BETWEEN ? AND ?)
       ${query.locationId ? 'AND c.location_id = ?' : ''} ${staff ? `AND ${assignedHomeSql('c')}` : ''}`,
    [scope.organizationId, query.from, query.to, query.from, query.to, ...(query.locationId ? [query.locationId] : []), ...(staff ? [staff.userId, staff.userId] : [])])
    : Promise.resolve([])

  // The branch pictures depend on nothing the source rows carry, so they are
  // read in the same round trip as the rows.
  const [sourceRows, stays, locationPictures] = await Promise.all([
    Promise.all(sourceQueries),
    stayRows,
    scope.organizationId ? loadOwnerPictures(db, scope.organizationId, 'business_location', locations.map(location => location.id)) : Promise.resolve(new Map<string, { imageUrl: string } | null>()),
  ])
  const rows = sourceRows.flat()
  // Pictures are read per owning business; a buyer's rows span several.
  const pictures = new Map<string, string | null>()
  await Promise.all([...new Set(rows.map(row => `${row.organization_id}\n${row.picture_owner_type}`))].map(async (group) => {
    const [organizationId, ownerType] = group.split('\n') as [string, PictureOwnerType]
    const owners = rows.filter(row => row.organization_id === organizationId && row.picture_owner_type === ownerType)
    const loaded = await loadOwnerPictures(db, organizationId, ownerType, owners.map(row => row.picture_owner_id))
    for (const row of owners) pictures.set(`${group}\n${row.picture_owner_id}`, loaded.get(row.picture_owner_id)?.imageUrl ?? null)
  }))
  const items = rows.filter(row=>!query.assignedMemberId || row.assigned_member_id===query.assignedMemberId).flatMap<AgendaItem>((row) => {
    const timeZone = row.timezone
    if (!isValidTimezone(timeZone)) throw new Error(`Timezone is not configured for agenda item ${row.id}`)
    if (!row.starts_at) throw new Error(`Start time is missing for agenda item ${row.id}`)
    const startsAt = instantDate(row.starts_at).toISOString()
    const dayKey = localDateAt(instantDate(startsAt), timeZone)
    if (dayKey < query.from || dayKey > query.to) return []
    // The business reads who is coming; the buyer reads where they are going.
    const to = scope.buyerUserId !== undefined
      ? `/dashboard/account/bookings/${row.kind}/${encodeURIComponent(row.id)}`
      : row.kind === 'post'
        ? postEditorPath(query.organizationSlug ?? scope.organizationId, row.id)
        : `/dashboard/${query.organizationSlug ?? scope.organizationId}/bookings/${row.kind}/${encodeURIComponent(row.id)}`
    return [{
      assignedMemberId:row.assigned_member_id,assignedMemberName:row.assigned_member_name,
      id: `${row.kind}:${row.id}`, requestId: row.kind === 'post' ? null : row.id, operationalBookingId: row.kind === 'booking' ? row.operational_id : null, operationalReservationId: row.kind === 'reservation' ? row.operational_id : null, stayId: null, stayMoment: null, kind: row.kind, startsAt,
      endsAt: row.ends_at === null ? null : instantDate(row.ends_at).toISOString(),
      dayKey, timeZone, showTimeZone: false,
      title: scope.buyerUserId ? row.resource_title ?? row.title : row.title,
      subtitle: scope.buyerUserId ? row.organization_name : row.subtitle,
      status: row.status, organizationId: row.organization_id,
      locationId: row.location_id, locationTitle: row.location_title,
      guestImageUrl: row.guest_image_url,
      resourceImageUrl: pictures.get(`${row.organization_id}\n${row.picture_owner_type}\n${row.picture_owner_id}`) ?? null,
      resourceTitle: row.resource_title, partySize: row.party_size, to,
    }]
  })
  const organizationPath = query.organizationSlug ?? scope.organizationId
  for (const stay of query.assignedMemberId ? [] : stays) {
    if (!isValidTimezone(stay.timezone)) throw new Error(`Timezone is not configured for stay ${stay.id}`)
    const guest = [stay.guest_name, stay.guest_surname].filter(Boolean).join(' ') || 'Guest'
    for (const [moment, day, time] of [['arrival', stay.check_in_date, stay.check_in_time], ['departure', stay.check_out_date, stay.check_out_time]] as const) {
      if (day < query.from || day > query.to) continue
      const instant = localDateTimeToInstant(day, time, stay.timezone, 'compatible').toISOString()
      items.push({
        assignedMemberId: null, assignedMemberName: null, id: `stay:${stay.id}:${moment}`, requestId: null, operationalBookingId: null, operationalReservationId: null,
        stayId: stay.id, stayMoment: moment, kind: 'stay', startsAt: instant, endsAt: null, dayKey: day, timeZone: stay.timezone, showTimeZone: false,
        title: guest, subtitle: `${moment === 'arrival' ? 'Checking in' : 'Checking out'} · ${stay.party_size === 1 ? '1 guest' : `${stay.party_size} guests`}`,
        status: stay.status, organizationId: stay.organization_id, locationId: stay.location_id, locationTitle: stay.location_title,
        guestImageUrl: null, resourceImageUrl: null, resourceTitle: stay.product_name, partySize: stay.party_size,
        to: `/dashboard/${organizationPath}/bookings/stay/${encodeURIComponent(stay.id)}`,
      })
    }
  }
  items.sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id))

  return {
    items, availableKinds,
    locations: locations.map(location => ({ id: location.id, organizationId: location.organization_id, title: location.title, imageUrl: locationPictures.get(location.id)?.imageUrl ?? null })),
  }
}

export async function listTodayAgenda(
  db: DbClient,
  scope: AgendaScope,
  input: Pick<AgendaQuery, 'organizationSlug' | 'principal'>,
  now = new Date(),
): Promise<TodayAgendaPayload> {
  const utcKey = now.toISOString().slice(0, 10)
  const nearby = await listAgenda(db, scope, {
    from: addLocalDays(utcKey, -1),
    to: addLocalDays(utcKey, 1),
    kinds: ['reservation', 'booking', 'stay'],
    organizationSlug: input.organizationSlug,
    principal: input.principal,
  })
  return {
    ...nearby,
    availableKinds: nearby.availableKinds.filter(kind => kind === 'reservation' || kind === 'booking' || kind === 'stay'),
    items: nearby.items.filter(item => item.dayKey === todayKeyForTimeZone(now, item.timeZone)),
    resolvedAt: now.toISOString(),
  }
}

export function todayKeyForTimeZone(now: Date, timeZone: string): string {
  return localDateAt(now, timeZone)
}
