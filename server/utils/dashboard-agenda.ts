import { assertCalendarDate, isValidTimezone, instantDate, localDateAt, addLocalDays } from '~/utils/timezone'
import { HTTPError } from 'nitro'
import { executeBatch, MAX_D1_BATCH_STATEMENTS, type BatchQuery, type DbClient } from '~/server/db'
import { assignedGuestThreadScope, assignedMemberSql, BATCH_VIEWER, locationMemberSql, roleAllows, assertRoleAllows, withViewer, type ResolvedMembership } from '~/server/utils/member-access'
import type { CloudflareEnv } from '~/server/utils/auth'
import { ownerPicturesFromRows } from '~/server/notifications/hero'
import { mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { bookingDay } from '~/server/domain/requests'
import { bookedRecordsInRange, type BookedRecordInRange } from '~/server/domain/product-bookings'
import { CURRENT_GUEST_SQL } from '~/server/domain/conversations'
import { postEditorPath } from '~/server/utils/dashboard-links'
import { bookingConversationOrRecordPath, guestConversationPath } from '~/shared/messages-contract'
import type { Stay } from '~/server/domain/stays'
import { STAY_CHANNEL_LABELS, stayGuestFirstName } from '~/shared/bookings'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'

export const AGENDA_KINDS = ['booking', 'post', 'stay'] as const
export type AgendaKind = typeof AGENDA_KINDS[number]

export interface AgendaItem {
  assigned_member_id: string | null
  assigned_member_name: string | null
  id: string
  conversation_id: string | null
  booking_id: string | null
  product_id: string | null
  stay_channel: Stay['channel'] | null
  /** Current stays appear only on a manager's Today, never as another cleaning. */
  stay_moment: 'arrival' | 'departure' | 'turnover' | 'current' | null
  kind: AgendaKind
  starts_at: string
  ends_at: string | null
  day_key: string
  timezone: string
  show_time_zone: boolean
  title: string
  subtitle: string | null
  status: string
  organization_id: string
  location_id: string | null
  location_title: string | null
  guest_image_url: string | null
  /** The guest's first name as the business reads it; null for a buyer's own visit or a guest a channel did not name. */
  guest_first_name: string | null
  /** A channel stay that landed on held nights, for the managers who resolve it. */
  overbooked: boolean
  /** A stay's checkout date, so its whole interval can be named. */
  check_out_date: string | null
  resource_image_url: string | null
  name: string | null
  party_size: number | null
  to: string | null
}

export interface TodayAgendaPayload extends AgendaPayload {
  resolved_at: string
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
  /** Today alone includes currently hosted guests for managers. Calendar keeps dated moments. */
  currentStaysAt?: Date
}

export interface AgendaLocation {
  id: string
  organization_id: string
  title: string
  image_url: string | null
}

export interface AgendaPayload {
  items: AgendaItem[]
  available_kinds: AgendaKind[]
  locations: AgendaLocation[]
}

interface SourceRow {
  assigned_member_id: string | null
  assigned_member_name: string | null
  id: string
  operational_id: string | null
  product_id: string | null
  kind: AgendaKind
  starts_at: string | null
  ends_at: string | null
  title: string
  party_size_is_minimum: number | null
  status: string
  organization_id: string
  organization_name: string | null
  vertical: string
  location_id: string | null
  location_title: string | null
  timezone: string | null
  guest_image_url: string | null
  picture_owner_type: PictureOwnerType
  picture_owner_id: string
  resource_title: string | null
  party_size: number | null
  viewer_seated: number
  viewer_can_read_details: number
}

interface LocationRow {
  id: string
  organization_id: string
  title: string
}

// A party is counted in the business's own noun: guests at a table or a home, clients at a consultation.
function partyLabel(vertical: string, size: number, minimum: boolean): string {
  const copy = getVerticalCopy(vertical)
  return `${size}${minimum ? '+' : ''} ${size === 1 && !minimum ? copy.guestLabel : copy.guestsLabelPlural}`
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
// answers it: a table's location, a booking's or class's experience, a
// post's own cover. The row names the owner; the resolver decides the picture.
type PictureOwnerType = 'business_location' | 'product' | 'content_document' | 'organization'

export async function agendaStaff(principal?: AgendaPrincipal) {
  const staff = principal && !await roleAllows({ ...principal.membership, permissions: { operations: ['read'] } })
    ? principal.membership : null
  if (staff && !await roleAllows({ ...staff, permissions: { operations: ['listing_calendar'] } })) {
    await assertRoleAllows({ ...staff, permissions: { operations: ['assigned'] } })
  }
  return staff
}

export async function listAgenda(db: DbClient, scope: AgendaScope, query: AgendaQuery): Promise<AgendaPayload> {
  const staff = await agendaStaff(query.principal)
  const plan = prepareAgenda(db, scope, query, staff)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read the agenda' }), Boolean(staff))
}

type AgendaPlanScope = AgendaScope | { organizationId: { sql: string }; buyerUserId?: undefined }

export function prepareAgenda(
  db: DbClient,
  scope: AgendaPlanScope,
  query: AgendaQuery,
  staff: ResolvedMembership | null,
  document?: { membership: BatchQuery },
) {
  assertCalendarDate(query.from)
  assertCalendarDate(query.to)
  if (query.from > query.to) throw new Error('from must not be after to')
  const org = typeof scope.organizationId === 'object' ? scope.organizationId.sql : '?'
  const orgParams = typeof scope.organizationId === 'string' ? [scope.organizationId] : []
  const staffUser = document ? { column: BATCH_VIEWER.user } : staff?.userId
  const userSql = typeof staffUser === 'object' ? staffUser.column : '?'
  const userParams = typeof staffUser === 'string' ? [staffUser, staffUser] : []
  const wide = document ? roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ operations: ['read'] })) : null
  const assignedRequests = staffUser ? assignedGuestThreadScope('rq', staffUser) : null

  const wants = (kind: AgendaKind) => !query.kinds?.length || query.kinds.includes(kind)
  const queries: BatchQuery[] = [
    { query: `WITH agenda_organizations(organization_id) AS MATERIALIZED (
        ${scope.buyerUserId ? `SELECT DISTINCT r.organization_id FROM conversations r WHERE r.user_id = ? AND ${CURRENT_GUEST_SQL('r')}` : `SELECT ${org}`}
      ) SELECT
        EXISTS (SELECT 1 FROM product_booking_configs WHERE organization_id IN agenda_organizations)
          OR EXISTS (SELECT 1 FROM bookings WHERE organization_id IN agenda_organizations) AS booking,
        EXISTS (SELECT 1 FROM product_stay_configs WHERE organization_id IN agenda_organizations) AS stay`,
      params: scope.buyerUserId ? [scope.buyerUserId] : orgParams },
  ]
  const locationIndex = scope.organizationId ? queries.push({
    query: `SELECT l.id, l.organization_id, l.title FROM business_locations l WHERE l.organization_id = ${org}
      ${assignedRequests ? `AND (${wide ? `${wide} OR ` : ''}EXISTS (SELECT 1 FROM conversations rq
        WHERE rq.organization_id = l.organization_id AND rq.location_id = l.id AND ${assignedRequests!.sql})
        OR EXISTS (SELECT 1 FROM product_stay_configs c JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
          WHERE c.organization_id = l.organization_id AND c.location_id = l.id AND ${assignedMemberSql('b', userSql)})
        OR ${locationMemberSql('l.organization_id', 'l.id', userSql)})` : ''}
      ORDER BY l.title, l.id`, params: [...orgParams, ...(assignedRequests ? [...assignedRequests.params, ...userParams] : [])],
  }) - 1 : -1
  const viewer: BatchQuery = scope.buyerUserId
    ? { query: 'SELECT NULL AS organization_id, ? AS user_id, NULL AS member_id, NULL AS role, 0 AS organization_wide', params: [scope.buyerUserId] }
    : { query: 'SELECT ? AS organization_id, ? AS user_id, ? AS member_id, ? AS role, ? AS organization_wide', params: [scope.organizationId, query.principal?.membership.userId ?? null, staff?.memberId ?? null, staff?.role ?? null, staff ? 0 : 1] }
  const readBookings = wants('booking') || (wants('stay') && !query.assignedMemberId)
  const booked = bookedRecordsInRange({ ...BATCH_VIEWER, organizationWide: wide ?? BATCH_VIEWER.organizationWide }, {
    from: query.from, to: query.to, guest: Boolean(scope.buyerUserId),
    includeAssignedStays: true, includeCalendarGrants: true,
    organizationId: query.organizationId, timedLocationId: query.locationId, assignedMemberId: query.assignedMemberId,
  })
  const bookingIndex = readBookings ? queries.push(document ? booked : withViewer(viewer, booked)) - 1 : -1
  const showPosts = Boolean(scope.organizationId && (!staff || document))
  const postIndex = showPosts && wants('post') && !query.assignedMemberId ? queries.push({
    query: `
    SELECT NULL AS assigned_member_id, NULL AS assigned_member_name, p.id, NULL AS operational_id, NULL AS product_id, 'post' AS kind,
           p.published_at AS starts_at, NULL AS ends_at, NULLIF(p.title, '') AS title, NULL AS party_size_is_minimum, NULL AS party_size, p.status,
           p.organization_id, s.name AS organization_name, s.vertical, p.location_id, l.title AS location_title, s.timezone, NULL AS guest_image_url,
           'content_document' AS picture_owner_type, p.id AS picture_owner_id, COALESCE(l.title, s.name, s.subdomain, s.id) AS resource_title,
           0 AS viewer_seated, 0 AS viewer_can_read_details
      FROM content_documents p
      JOIN organization s ON s.id = p.organization_id
      LEFT JOIN business_locations l ON l.id = p.location_id AND l.organization_id = p.organization_id
     WHERE p.kind = 'social_post' AND p.row_role = 'root' AND p.organization_id = ${org}
       ${wide ? `AND (${wide})` : ''}
       ${query.organizationId ? 'AND p.organization_id = ?' : ''} ${query.locationId ? 'AND p.location_id = ?' : ''}
       AND p.status = 'published' AND p.published_at BETWEEN ? AND ?`,
    params: [...orgParams, ...(query.organizationId ? [query.organizationId] : []), ...(query.locationId ? [query.locationId] : []),
      `${addLocalDays(query.from, -2)}T00:00:00.000Z`, `${addLocalDays(query.to, 2)}T23:59:59.999Z`],
  }) - 1 : -1
  const bookingOwners = queries[bookingIndex]
  const postOwners = queries[postIndex]
  const locationOwners = queries[locationIndex]
  const mediaIndex = scope.organizationId ? queries.length : -1
  if (scope.organizationId) {
    const media = mediaPlacementsQuery({
      organizationId: scope.organizationId, ownerType: { sql: 'mp.owner_type' }, includeOrganizationFallback: true,
      owners: { sql: 'SELECT owner_id FROM agenda_picture_owners WHERE owner_type = mp.owner_type' },
    })
    queries.push({
      query: `WITH agenda_picture_owners(owner_type, owner_id) AS MATERIALIZED (
        SELECT NULL, NULL WHERE 0
        ${bookingOwners ? `UNION ALL SELECT
          CASE WHEN product_kind <> 'table' THEN 'product' WHEN location_id IS NULL THEN 'organization' ELSE 'business_location' END,
          CASE WHEN product_kind <> 'table' THEN product_id ELSE COALESCE(location_id, organization_id) END
          FROM (${bookingOwners.query})` : ''}
        ${postOwners ? `UNION ALL SELECT picture_owner_type, picture_owner_id FROM (${postOwners.query})` : ''}
        ${locationOwners ? `UNION ALL SELECT 'business_location', id FROM (${locationOwners.query})` : ''}
      ) ${media.query}`,
      params: [...bookingOwners?.params ?? [], ...postOwners?.params ?? [], ...locationOwners?.params ?? [], ...media.params ?? []],
    })
  }
  return { queries: document ? queries.map(statement => withViewer(document.membership, statement)) : queries, read }

  async function read(results: D1Result[], isStaff: boolean): Promise<AgendaPayload> {
    const available = results[0]!.results[0] as { booking: number; stay: number }
    const locations = (results[locationIndex]?.results ?? []) as LocationRow[]
    const availableKinds = AGENDA_KINDS.filter(kind => ({
      booking: Boolean(available.booking), stay: Boolean(available.stay), post: showPosts && !isStaff,
    })[kind])
    const requestedKinds = new Set(availableKinds.filter(wants))
    if (!requestedKinds.size) return { items: [], available_kinds: availableKinds, locations: [] }

    const records = (results[bookingIndex]?.results ?? []) as BookedRecordInRange[]
    const visible = records.filter(record => record.conversation_id !== null && (!query.locationId || record.location_id === query.locationId))
    const bookings = !requestedKinds.has('booking') ? [] : visible.filter(record => record.unit === 'slot').map((record): SourceRow => {
      const table = record.product_kind === 'table'
      return {
        assigned_member_id: record.assigned_member_id, assigned_member_name: record.assigned_member_name, id: record.conversation_id!, operational_id: record.id,
        product_id: record.product_id, kind: 'booking', starts_at: record.starts_at, ends_at: record.ends_at, title: record.guest_name ?? '',
        party_size_is_minimum: record.party_size_is_minimum, party_size: record.party_size, status: record.status, organization_id: record.organization_id, viewer_seated: record.viewer_seated,
        viewer_can_read_details: record.viewer_can_read_details,
        organization_name: record.organization_name, vertical: record.vertical, location_id: record.location_id, location_title: record.location_title, timezone: record.timezone,
        guest_image_url: record.guest_image_url,
        picture_owner_type: !table ? 'product' : record.location_id === null ? 'organization' : 'business_location',
        picture_owner_id: !table ? record.product_id : record.location_id ?? record.organization_id,
        resource_title: (!table ? record.product_name : null) ?? record.location_title ?? record.organization_name,
      }
    })
    const rows = bookings.concat((results[postIndex]?.results ?? []) as SourceRow[])
    // A stay is two moments at its home: guests arrive on the check-in day at the
    // home's check-in time and leave on the checkout day at its checkout time,
    // both in the location's zone; a home with no time for one has its day alone.
    // Members see the homes they look after, with the guest's first name as their
    // turnover (`stayTurnover`) carries it; buyers read their whole stay interval
    // in Today and Calendar. The same bookings table, read by its nights; SQL
    // narrows by instants a day wider either side and each stay's days decide.
    const stays = !requestedKinds.has('stay') || query.assignedMemberId ? [] : visible.filter(record => record.unit === 'nights')
      .map(record => ({ ...record, conversation_id: record.conversation_id!, guest_image_url: isStaff || scope.buyerUserId ? null : record.guest_image_url,
        check_in_date: bookingDay(record.starts_at, record.timezone), check_out_date: bookingDay(record.ends_at, record.timezone) }))
      .filter(row => scope.buyerUserId || query.currentStaysAt && !isStaff ? row.check_in_date <= query.to && row.check_out_date >= query.from
        : (row.check_in_date >= query.from && row.check_in_date <= query.to) || (row.check_out_date >= query.from && row.check_out_date <= query.to))

    const owners = new Map<string, { organizationId: string; ownerType: PictureOwnerType; ids: Set<string> }>()
    const addOwner = (organizationId: string, ownerType: PictureOwnerType, id: string) => {
      const key = `${organizationId}\n${ownerType}`
      const group = owners.get(key) ?? { organizationId, ownerType, ids: new Set<string>() }
      group.ids.add(id)
      owners.set(key, group)
    }
    for (const location of locations) addOwner(location.organization_id, 'business_location', location.id)
    for (const row of rows) addOwner(row.organization_id, row.picture_owner_type, row.picture_owner_id)
    for (const stay of stays) addOwner(stay.organization_id, 'product', stay.product_id)
    const groups = [...owners.values()]
    const pictures = new Map<string, string | null>()
    const applyPictures = ({ organizationId, ownerType, ids }: typeof groups[number], rows: unknown[]) => {
      const loaded = ownerPicturesFromRows(organizationId, ownerType, [...ids], rows)
      for (const [id, picture] of loaded) pictures.set(`${organizationId}\n${ownerType}\n${id}`, picture?.imageUrl ?? null)
    }
    if (mediaIndex >= 0) {
      for (const group of groups) applyPictures(group, results[mediaIndex]!.results)
    } else {
      for (let offset = 0; offset < groups.length; offset += MAX_D1_BATCH_STATEMENTS) {
        const page = groups.slice(offset, offset + MAX_D1_BATCH_STATEMENTS)
        const media = await executeBatch(db, page.map(({ organizationId, ownerType, ids }) => mediaPlacementsQuery({
          organizationId, ownerType, owners: [...ids], includeOrganizationFallback: true,
        })), { operation: 'Read buyer agenda pictures' })
        for (const [index, group] of page.entries()) applyPictures(group, media[index]!.results)
      }
    }
    const organizationPath = query.organizationSlug ?? (typeof scope.organizationId === 'string' ? scope.organizationId : undefined)
    const items = rows.flatMap<AgendaItem>((row) => {
      const timezone = row.timezone
      if (!isValidTimezone(timezone)) throw new Error(`Timezone is not configured for agenda item ${row.id}`)
      if (!row.starts_at) throw new Error(`Start time is missing for agenda item ${row.id}`)
      const starts_at = instantDate(row.starts_at).toISOString()
      const day_key = localDateAt(instantDate(starts_at), timezone)
      if (day_key < query.from || day_key > query.to) return []
      // The business reads who is coming; the buyer reads where they are going.
      const to = scope.buyerUserId !== undefined
        ? guestConversationPath('account', row.id)
        : row.kind === 'post'
          ? postEditorPath(organizationPath!, row.id)
          : row.viewer_can_read_details ? bookingConversationOrRecordPath(organizationPath!, row.operational_id!, row.viewer_seated ? row.id : null) : null
      return [{
        assigned_member_id:row.assigned_member_id,assigned_member_name:row.assigned_member_name,
        id: `${row.kind}:${row.kind === 'booking' && !row.viewer_can_read_details ? row.operational_id : row.id}`,
        conversation_id: row.viewer_can_read_details ? row.id : null, booking_id: row.kind === 'booking' ? row.operational_id : null, product_id: row.product_id, stay_channel: null, stay_moment: null, kind: row.kind, starts_at,
        ends_at: row.ends_at === null ? null : instantDate(row.ends_at).toISOString(),
        day_key, timezone, show_time_zone: false,
        title: scope.buyerUserId || (row.kind === 'booking' && !row.viewer_can_read_details) ? row.resource_title ?? row.title : row.title,
        subtitle: scope.buyerUserId ? row.organization_name : row.party_size === null ? null : partyLabel(row.vertical, row.party_size, row.party_size_is_minimum === 1),
        status: row.status, organization_id: row.organization_id,
        location_id: row.location_id, location_title: row.location_title,
        guest_image_url: row.guest_image_url,
        guest_first_name: scope.buyerUserId ? null : stayGuestFirstName(row.title), overbooked: false, check_out_date: null,
        resource_image_url: pictures.get(`${row.organization_id}\n${row.picture_owner_type}\n${row.picture_owner_id}`) ?? null,
        name: row.resource_title, party_size: row.party_size, to,
      }]
    })
    // A departure is a turnover when the home's next guests arrive the same day, read in the home's own calendar.
    const sameDayArrival = (stay: typeof stays[number]) => records.some(next => next.unit === 'nights' && next.product_id === stay.product_id && next.id !== stay.id && bookingDay(next.starts_at, next.timezone) === stay.check_out_date)
    for (const stay of stays) {
      if (!isValidTimezone(stay.timezone)) throw new Error(`Timezone is not configured for stay ${stay.id}`)
      if (!stay.product_name?.trim()) throw new Error(`Home ${stay.product_id} has no name for this agenda`)
      // Only a channel's conversation may name no guest. A member reads the guest as their turnover names them: by first name.
      const named = isStaff ? stayGuestFirstName(stay.guest_name) ?? '' : stay.guest_name ?? ''
      if (stay.viewer_can_read_details && !named && (stay.owner !== 'channel' || stay.channel === 'direct')) throw new HTTPError({ statusCode: 500, message: `Stay ${stay.id} has no guest name`, data: { code: 'INVALID_STAY', field: 'guest_name', booking_id: stay.id } })
      const guest = named || `Name not provided by ${STAY_CHANNEL_LABELS[stay.channel]}`
      // Rule 1: a channel stay that landed on held nights shows flagged wherever its arrival and
      // departure do, for the managers who resolve it; a member's turnover carries no booking state.
      const title = !isStaff && Number(stay.overbooked) === 1 ? `Overbooked · ${guest}` : guest
      const moments: Array<['arrival' | 'departure' | 'current', string, string]> = scope.buyerUserId ? [['arrival', stay.check_in_date, stay.starts_at]]
        : [['arrival', stay.check_in_date, stay.starts_at], ['departure', stay.check_out_date, stay.ends_at]]
      if (!scope.buyerUserId && !isStaff && query.currentStaysAt) {
        const today = localDateAt(query.currentStaysAt, stay.timezone)
        if (stay.check_in_date < today && today < stay.check_out_date) moments.push(['current', today, stay.starts_at])
      }
      const turnover = sameDayArrival(stay)
      for (const [moment, day, instant] of moments) {
        if (!scope.buyerUserId && (day < query.from || day > query.to)) continue
        items.push({
          assigned_member_id: null, assigned_member_name: null, id: scope.buyerUserId ? `stay:${stay.id}` : `stay:${stay.id}:${moment}`, conversation_id: isStaff ? null : stay.conversation_id, booking_id: stay.id, product_id: stay.product_id, stay_channel: stay.channel, stay_moment: moment === 'departure' && turnover ? 'turnover' : moment, kind: 'stay', starts_at: instant, ends_at: scope.buyerUserId || moment === 'current' ? stay.ends_at : null, day_key: day, timezone: stay.timezone, show_time_zone: false,
          title: scope.buyerUserId || !stay.viewer_can_read_details ? stay.product_name : title, subtitle: scope.buyerUserId ? stay.organization_name : [moment === 'arrival' ? 'Checking in' : moment === 'departure' ? 'Checking out' : 'Currently hosting', partyLabel(stay.vertical, stay.party_size, false), moment === 'departure' && turnover ? 'Next guests arrive the same day' : null].filter(Boolean).join(' · '),
          status: stay.status, organization_id: stay.organization_id, location_id: stay.location_id, location_title: stay.location_title,
          guest_image_url: stay.guest_image_url, guest_first_name: scope.buyerUserId ? null : stayGuestFirstName(stay.guest_name), overbooked: !isStaff && Number(stay.overbooked) === 1, check_out_date: stay.check_out_date,
          resource_image_url: pictures.get(`${stay.organization_id}\nproduct\n${stay.product_id}`) ?? null, name: stay.product_name, party_size: stay.party_size,
          to: scope.buyerUserId ? guestConversationPath('account', stay.conversation_id)
            : stay.viewer_can_read_details ? bookingConversationOrRecordPath(organizationPath!, stay.id, stay.viewer_seated ? stay.conversation_id : null) : null,
        })
      }
    }
    items.sort((left, right) => left.starts_at.localeCompare(right.starts_at) || left.id.localeCompare(right.id))

    return {
      items, available_kinds: availableKinds,
      locations: locations.map(location => ({ id: location.id, organization_id: location.organization_id, title: location.title, image_url: pictures.get(`${location.organization_id}\nbusiness_location\n${location.id}`) ?? null })),
    }
  }
}

export async function listTodayAgenda(
  db: DbClient,
  scope: AgendaScope,
  input: Pick<AgendaQuery, 'organizationSlug' | 'principal' | 'locationId'>,
  now = new Date(),
): Promise<TodayAgendaPayload> {
  const utcKey = now.toISOString().slice(0, 10)
  const nearby = await listAgenda(db, scope, {
    from: addLocalDays(utcKey, -1),
    to: addLocalDays(utcKey, 1),
    kinds: ['booking', 'stay'],
    organizationSlug: input.organizationSlug,
    principal: input.principal,
    locationId: input.locationId,
    currentStaysAt: now,
  })
  return {
    ...nearby,
    available_kinds: nearby.available_kinds.filter(kind => kind === 'booking' || kind === 'stay'),
    items: nearby.items.filter(item => {
      const today = todayKeyForTimeZone(now, item.timezone)
      return item.day_key === today || (scope.buyerUserId && item.kind === 'stay' && item.ends_at !== null
        && item.day_key <= today && bookingDay(item.ends_at, item.timezone) >= today)
    }),
    resolved_at: now.toISOString(),
  }
}

export function todayKeyForTimeZone(now: Date, timeZone: string): string {
  return localDateAt(now, timeZone)
}
