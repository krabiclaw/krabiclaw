import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { ASSIGNED_SERVICE_SQL, assertLocationAccess, assertProductAccess, locationMemberSql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { updateLocation } from '~/server/utils/location-management'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { bookingBatchWriteRefused, prepareScheduleClosures, readProjectedSchedule, sessionHeldCapacitySql } from '~/server/utils/availability'
import { CAPACITY_CONSUMING_SQL, stayGuestFirstName } from '~/shared/bookings'
import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import { closeDates, closureOnDate, datedHours, dateRuns, getDateIntervals, openDates, parseOpeningHours, parseSpecialHours } from '~/shared/reservation-hours'
import { parsePostalAddress } from '~/utils/postal-address'
import { addLocalDays, isValidCalendarDate, localDateAt } from '~/utils/timezone'

/**
 * The places calendar: every restaurant location, experience and consultation
 * the caller may see as a row, each day of a window as a column. The Homes
 * grid reads nights at homes; this is the same grid's other row source, and
 * the one write behind it opens or blocks a place's days.
 *
 * A location's day is open, blocked by the host (a closure in its special
 * hours) or closed by its hours. An offering's day is its sessions: a session
 * a guest holds is booked and never written; the rest are blocked by
 * cancelling them and opened by restoring them.
 */

export const PLACES_CALENDAR_DAYS = 62

export type PlaceKind = 'location' | 'offering'

/** What keeps a day from being written: a guest holds it, the hours close it, or there is nothing on it to write. */
export type PlaceHold = { kind: 'booked' | 'hours' | 'inactive' | 'unscheduled'; text: string }

export interface PlaceDay {
  date: string
  /** Blocked by the host: a location's closure, or every writable session of the offering that day cancelled. */
  closed: boolean
  held: PlaceHold | null
  /** Table bookings on the day, or sessions a guest holds. */
  booked: number
  /** Sessions no guest holds; a location has none. */
  free: number | null
}

export interface Place {
  kind: PlaceKind
  id: string
  name: string
  /** The line under the name: a location's street and city, an offering's kind and where or who provides it. */
  detail: string
  /** A location's slug, for its hours leaf. */
  slug: string | null
  timezone: string
  /** The location's write timestamp; the offering's is its sessions'. */
  updated_at: string | null
  /** The attorney or host whose hours are the offering's schedule. */
  provider: { member_id: string; name: string } | null
}

export interface PlacesCalendar { from: string; to: string; manage: boolean; places: Array<{ place: Place; days: PlaceDay[] }> }

interface LocationRow { id: string; slug: string; title: string; status: string; timezone: string; address: string | null; opening_hours: string | null; special_hours: string | null; updated_at: string }
interface OfferingRow { id: string; name: string; kind: 'experience' | 'service'; timezone: string; scheduling_mode: string; assigned_member_id: string | null; provider_name: string | null; locations: string | null }
interface SessionRow { id: string; product_id: string; timezone: string; starts_at: string; status: 'scheduled' | 'cancelled'; claimed: number; updated_at: string | null }

function fail(statusCode: number, message: string, field?: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code: statusCode === 404 ? 'PLACE_NOT_FOUND' : 'INVALID_PLACE_DATES', ...(field ? { field } : {}) } })
}

function readWindow(input: { from: unknown; to: unknown }): { from: string; to: string } {
  if (!isValidCalendarDate(input.from) || !isValidCalendarDate(input.to)) fail(400, 'from and to must be calendar dates', 'from')
  if (input.to <= input.from) fail(400, 'to must be after from', 'to')
  if (days(input.from, input.to) > PLACES_CALENDAR_DAYS) fail(400, `Read at most ${PLACES_CALENDAR_DAYS} days at once`, 'to')
  return { from: input.from, to: input.to }
}
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
const dates = (from: string, to: string) => Array.from({ length: days(from, to) }, (_, offset) => addLocalDays(from, offset))

const KIND_LABELS = { experience: 'Experience', service: 'Consultation' } as const

async function listPlaces(db: DbClient, principal: MemberAccessPrincipal, only?: { kind: PlaceKind; id: string }): Promise<{ locations: LocationRow[]; offerings: OfferingRow[] }> {
  const { organizationId, userId } = principal
  const everyLocation = await roleAllows({ ...principal, permissions: { locations: ['read'] } })
  const everyOffering = await roleAllows({ ...principal, permissions: { products: ['read'] } })
  const locations = only && only.kind !== 'location' ? [] : await queryAll<LocationRow>(db, `
    SELECT l.id, l.slug, l.title, l.status, l.timezone, l.address, l.opening_hours, l.special_hours, l.updated_at
    FROM business_locations l
    WHERE l.organization_id = ? AND (? IS NULL OR l.id = ?)
      ${only ? '' : `AND EXISTS (SELECT 1 FROM product_locations pl JOIN products p ON p.id = pl.product_id AND p.organization_id = pl.organization_id
        JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
        WHERE pl.organization_id = l.organization_id AND pl.location_id = l.id AND p.kind = 'table')`}
      ${everyLocation ? '' : `AND ${locationMemberSql('l.organization_id', 'l.id')}`}
    ORDER BY l.title, l.id`, [organizationId, only?.id ?? null, only?.id ?? null, ...(everyLocation ? [] : [userId])])
  const offerings = only && only.kind !== 'offering' ? [] : await queryAll<OfferingRow>(db, `
    SELECT p.id, p.name, p.kind, c.scheduling_mode, c.assigned_member_id,
           COALESCE((SELECT l.timezone FROM product_locations pl JOIN business_locations l ON l.id = pl.location_id AND l.organization_id = pl.organization_id WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id ORDER BY l.title LIMIT 1),
             (SELECT ms.timezone FROM member_scheduling ms WHERE ms.member_id = c.assigned_member_id AND ms.organization_id = c.organization_id), o.timezone) AS timezone,
           (SELECT ${MEMBER_NAME_SQL} FROM member m JOIN user u ON u.id = m.userId LEFT JOIN member_scheduling ms ON ms.member_id = m.id AND ms.organization_id = m.organizationId WHERE m.id = c.assigned_member_id AND m.organizationId = c.organization_id) AS provider_name,
           (SELECT group_concat(l.title, ' · ') FROM (SELECT l.title FROM product_locations pl JOIN business_locations l ON l.id = pl.location_id AND l.organization_id = pl.organization_id WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id ORDER BY l.title) l) AS locations
    FROM products p JOIN product_booking_configs c ON c.product_id = p.id AND c.organization_id = p.organization_id JOIN organization o ON o.id = p.organization_id
    WHERE p.organization_id = ? AND p.kind IN ('experience', 'service') AND (? IS NULL OR p.id = ?)
      ${everyOffering ? '' : `AND ${ASSIGNED_SERVICE_SQL}`}
    ORDER BY p.name, p.id`, [organizationId, only?.id ?? null, only?.id ?? null, ...(everyOffering ? [] : [userId])])
  return { locations, offerings }
}

function placeOf(row: LocationRow | OfferingRow): Place {
  if ('title' in row) {
    const address = parsePostalAddress(row.address)
    return { kind: 'location', id: row.id, name: row.title, detail: [address?.addressLines[0], address?.locality].filter(Boolean).join(', ') || 'No address', slug: row.slug, timezone: row.timezone, updated_at: row.updated_at, provider: null }
  }
  const provider = row.scheduling_mode === 'provider' && row.assigned_member_id && row.provider_name ? { member_id: row.assigned_member_id, name: row.provider_name } : null
  return { kind: 'offering', id: row.id, name: row.name, detail: `${KIND_LABELS[row.kind]} · ${provider?.name ?? row.locations ?? 'No location'}`, slug: null, timezone: row.timezone, updated_at: null, provider }
}

function locationDays(row: LocationRow, window: string[], reservations: Map<string, number>): PlaceDay[] {
  const hours = parseOpeningHours(row.opening_hours ? JSON.parse(row.opening_hours) : null)
  const special = parseSpecialHours(row.special_hours ? JSON.parse(row.special_hours) : null)
  return window.map((date) => {
    const booked = reservations.get(date) ?? 0
    const dated = datedHours(special, date)
    const hostClosed = Boolean(closureOnDate(special, date)) || dated?.kind === 'hours' && dated.periods.length === 0
    const intervals = getDateIntervals(hours, special, date)
    const held: PlaceHold | null = row.status !== 'active' ? { kind: 'inactive', text: `${row.title} is inactive` }
      : booked ? { kind: 'booked', text: `${booked} ${booked === 1 ? 'reservation' : 'reservations'}` }
        : !hostClosed && intervals !== null && intervals.length === 0 ? { kind: 'hours', text: `Closed: outside ${row.title}'s hours` } : null
    return { date, closed: hostClosed || held?.kind === 'hours' || held?.kind === 'inactive', held, booked, free: null }
  })
}

function offeringDays(row: OfferingRow, window: string[], sessions: Map<string, SessionRow[]>): PlaceDay[] {
  const provider = row.scheduling_mode === 'provider'
  const first = stayGuestFirstName(row.provider_name)
  const hoursText = provider ? `Outside ${first ? `${first}'s` : 'the provider\'s'} hours` : 'No session on this day'
  return window.map((date) => {
    const onDay = sessions.get(date) ?? []
    const booked = onDay.filter(session => session.claimed > 0).length
    const writable = onDay.filter(session => session.claimed === 0)
    const held: PlaceHold | null = writable.length ? null
      : booked ? { kind: 'booked', text: `${booked} booked ${booked === 1 ? 'session' : 'sessions'}` }
        : { kind: provider ? 'hours' : 'unscheduled', text: hoursText }
    return { date, closed: writable.length > 0 && writable.every(session => session.status === 'cancelled'), held, booked, free: writable.filter(session => session.status === 'scheduled').length }
  })
}

/** Sessions of the offerings in the instants that can fall in the window, keyed by product then local date. */
async function readSessions(db: DbClient, organizationId: string, productIds: string[], from: string, to: string): Promise<Map<string, Map<string, SessionRow[]>>> {
  const byProduct = new Map<string, Map<string, SessionRow[]>>()
  if (!productIds.length) return byProduct
  const fromInstant = `${addLocalDays(from, -1)}T00:00:00.000Z`
  const toInstant = `${addLocalDays(to, 1)}T00:00:00.000Z`
  const [recorded, projected] = await Promise.all([
    queryAll<SessionRow>(db, `
    SELECT s.id, s.product_id, s.timezone, s.starts_at, s.status, s.updated_at,
           COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.product_session_id = s.id AND ${CAPACITY_CONSUMING_SQL}), 0) + ${sessionHeldCapacitySql('s')} AS claimed
    FROM product_sessions s
    WHERE s.organization_id = ? AND s.product_id IN (SELECT value FROM json_each(?)) AND s.status IN ('scheduled', 'cancelled')
      AND s.starts_at >= ? AND s.starts_at < ?
    ORDER BY s.starts_at, s.id`, [organizationId, JSON.stringify(productIds), fromInstant, toInstant]),
    Promise.all(productIds.map(productId => readProjectedSchedule(db, { organizationId, productId, fromInstant, toInstant }))),
  ])
  const byId = new Map(recorded.map(session => [session.id, session]))
  for (const session of projected.flat()) byId.set(session.id, { ...session, claimed: byId.get(session.id)?.claimed ?? 0 })
  for (const row of byId.values()) {
    const date = localDateAt(new Date(row.starts_at), row.timezone)
    if (date < from || date >= to) continue
    const days = byProduct.get(row.product_id) ?? new Map<string, SessionRow[]>()
    days.set(date, [...(days.get(date) ?? []), row])
    byProduct.set(row.product_id, days)
  }
  return byProduct
}

/** A restaurant's table bookings on each of its days, keyed by location then local date. */
async function readTableBookings(db: DbClient, organizationId: string, locationIds: string[], from: string, to: string): Promise<Map<string, Map<string, number>>> {
  const byLocation = new Map<string, Map<string, number>>()
  if (!locationIds.length) return byLocation
  const rows = await queryAll<{ location_id: string; timezone: string; starts_at: string }>(db, `
    SELECT s.location_id, s.timezone, s.starts_at FROM bookings b
      JOIN product_sessions s ON s.id = b.product_session_id AND s.organization_id = b.organization_id
      JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id AND p.kind = 'table'
    WHERE b.organization_id = ? AND s.location_id IN (SELECT value FROM json_each(?)) AND ${CAPACITY_CONSUMING_SQL}
      AND s.starts_at >= ? AND s.starts_at < ?`, [organizationId, JSON.stringify(locationIds), `${addLocalDays(from, -1)}T00:00:00.000Z`, `${addLocalDays(to, 1)}T00:00:00.000Z`])
  for (const row of rows) {
    const date = localDateAt(new Date(row.starts_at), row.timezone)
    if (date < from || date >= to) continue
    const days = byLocation.get(row.location_id) ?? new Map<string, number>()
    days.set(date, (days.get(date) ?? 0) + 1)
    byLocation.set(row.location_id, days)
  }
  return byLocation
}

/** Every place the caller may see, with each day of [from, to). */
export async function readPlacesCalendar(db: DbClient, principal: MemberAccessPrincipal, input: { from: unknown; to: unknown }, only?: { kind: PlaceKind; id: string }): Promise<PlacesCalendar> {
  const { from, to } = readWindow(input)
  const { locations, offerings } = await listPlaces(db, principal, only)
  if (only && !locations.length && !offerings.length) fail(404, 'Place not found')
  const span = dates(from, to)
  const [reservations, sessions, manageLocations, manageOfferings] = await Promise.all([
    readTableBookings(db, principal.organizationId, locations.map(location => location.id), from, to),
    readSessions(db, principal.organizationId, offerings.map(offering => offering.id), from, to),
    roleAllows({ ...principal, permissions: { locations: ['update'] } }),
    roleAllows({ ...principal, permissions: { products: ['update'] } }),
  ])
  return {
    from, to, manage: manageLocations && manageOfferings,
    places: [
      ...locations.map(row => ({ place: placeOf(row), days: locationDays(row, span, reservations.get(row.id) ?? new Map()) })),
      ...offerings.map(row => ({ place: placeOf(row), days: offeringDays(row, span, sessions.get(row.id) ?? new Map()) })),
    ],
  }
}

/**
 * Open or block a place's days: [from, to), narrowed to weekdays when named.
 * A location's days become one closure per run, or are cut out of closures.
 * An offering's unclaimed sessions on those days are cancelled or restored;
 * a session a guest holds is never touched.
 */
export async function setPlaceDates(db: D1Database, principal: MemberAccessPrincipal, input: { kind: string; id: string; body: Record<string, unknown> }): Promise<{ place: Place; days: PlaceDay[] }> {
  const { kind, id, body } = input
  if (kind !== 'location' && kind !== 'offering') fail(404, 'Place not found')
  const unknown = Object.keys(body).find(key => !['from', 'to', 'weekdays', 'closed', 'updated_at'].includes(key))
  if (unknown) fail(400, `${unknown} is not a date setting`, unknown)
  const { from, to } = readWindow({ from: body.from, to: body.to })
  if (typeof body.closed !== 'boolean') fail(400, 'closed must be true or false', 'closed')
  let weekdays: number[] | null = null
  if (body.weekdays !== undefined) {
    if (!Array.isArray(body.weekdays) || !body.weekdays.length || body.weekdays.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) || new Set(body.weekdays).size !== body.weekdays.length) {
      fail(400, 'weekdays must list distinct whole numbers from 0 (Sunday) to 6 (Saturday)', 'weekdays')
    }
    weekdays = body.weekdays as number[]
  }
  if (body.updated_at !== undefined && typeof body.updated_at !== 'string') fail(400, 'updated_at must be a timestamp', 'updated_at')
  const last = addLocalDays(to, -1)
  let runs: Array<{ from: string; to: string }>
  try { runs = dateRuns(from, last, weekdays) } catch (cause) { fail(400, cause instanceof Error ? cause.message : 'No date in this range falls on the chosen weekdays', 'weekdays') }
  const chosen = runs.flatMap(run => dates(run.from, addLocalDays(run.to, 1)))
  const closed = body.closed
  const now = new Date().toISOString()
  if (kind === 'location') {
    await assertLocationAccess(db, { ...principal, locationId: id, patch: { special_hours: null } })
    const row = await queryFirst<LocationRow>(db, 'SELECT id, slug, title, status, timezone, address, opening_hours, special_hours, updated_at FROM business_locations WHERE organization_id = ? AND id = ?', [principal.organizationId, id])
    if (!row) fail(404, 'Place not found')
    const special = parseSpecialHours(row.special_hours ? JSON.parse(row.special_hours) : null)
    const result = await updateLocation(db, principal.organizationId, row.id, {
      special_hours: closed ? closeDates(special, from, last, weekdays) : openDates(special, from, last, weekdays),
      updated_at: typeof body.updated_at === 'string' ? body.updated_at : row.updated_at,
    }, principal.userId, principal.env)
    if (result.status >= 400) {
      const data = result.data as { error?: string; code?: string; field?: string }
      throw new HTTPError({ statusCode: result.status, statusMessage: data.error ?? 'The location dates could not be saved', data: { code: data.code ?? 'INVALID_PLACE_DATES', ...(data.field ? { field: data.field } : {}) } })
    }
  } else {
    await assertProductAccess(db, { ...principal, productId: id })
    const offering = await queryFirst<{ id: string }>(db, `SELECT p.id FROM products p JOIN product_booking_configs c ON c.product_id = p.id AND c.organization_id = p.organization_id WHERE p.organization_id = ? AND p.id = ? AND p.kind IN ('experience', 'service')`, [principal.organizationId, id])
    if (!offering) fail(404, 'Place not found')
    const sessions = (await readSessions(db, principal.organizationId, [id], from, to)).get(id) ?? new Map<string, SessionRow[]>()
    const projected = closed ? await prepareScheduleClosures(db, {
      organizationId: principal.organizationId, productId: id, actorId: principal.userId, dates: chosen, now,
      fromInstant: `${addLocalDays(from, -1)}T00:00:00.000Z`, toInstant: `${addLocalDays(to, 1)}T00:00:00.000Z`,
    }) : { queries: [], ids: [] }
    const projectedIds = new Set(projected.ids)
    const targets = chosen.flatMap(date => (sessions.get(date) ?? []).filter(session => session.updated_at !== null && !projectedIds.has(session.id) && session.claimed === 0 && session.status === (closed ? 'scheduled' : 'cancelled')).map(session => session.id))
    const unclaimed = `NOT EXISTS (SELECT 1 FROM bookings b WHERE b.product_session_id = product_sessions.id AND ${CAPACITY_CONSUMING_SQL})
      AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.session_id = product_sessions.id AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    if (targets.length || projected.ids.length) {
      await executeBatch(db, [
        ...projected.queries,
        { query: `UPDATE product_sessions SET status = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ? AND status = ? AND id IN (SELECT value FROM json_each(?)) AND ${unclaimed}`,
          params: [closed ? 'cancelled' : 'scheduled', now, principal.userId, principal.organizationId, id, closed ? 'scheduled' : 'cancelled', JSON.stringify(targets)] },
        organizationEventQuery({ organizationId: principal.organizationId, locationId: null, actorId: principal.userId, eventType: 'product.updated', entityType: 'product', entityId: id,
          metadata: { from, to, closed, sessions: targets.length + projected.ids.length, ...(weekdays ? { weekdays: weekdays.join(',') } : {}) } }),
        publicResourceCacheInvalidationQuery(principal.organizationId, 'product-session-updated'),
      ], { operation: 'Set offering dates' }).catch(error => {
        if (bookingBatchWriteRefused(error)) throw new HTTPError({ statusCode: 409, statusMessage: 'The schedule changed while saving these days. Reload the calendar and try again.', cause: error })
        throw error
      })
    }
  }
  const calendar = await readPlacesCalendar(db, principal, { from, to }, { kind, id })
  const entry = calendar.places[0]
  if (!entry) fail(404, 'Place not found')
  // The write's outcome, read back: a chosen day that could be written now reads the chosen state.
  const mismatch = entry.days.find(day => chosen.includes(day.date) && !day.held && day.closed !== closed)
  if (mismatch) throw new HTTPError({ statusCode: 409, statusMessage: `${mismatch.date} does not read ${closed ? 'blocked' : 'open'} after the save; review the calendar before another change`, data: { code: 'PLACE_DATES_UNCONFIRMED', field: 'closed' } })
  return entry
}
