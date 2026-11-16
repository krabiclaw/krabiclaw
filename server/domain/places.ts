import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { ASSIGNED_SERVICE_SQL, assertLocationAccess, assertProductAccess, locationMemberSql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { updateLocation } from '~/server/utils/location-management'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { bookingBatchWriteRefused, prepareScheduleDays, readSlots, scheduleSessions, slotCalendars, slotReadQueries, type BookableSession } from '~/server/utils/availability'
import { stayGuestFirstName } from '~/shared/bookings'
import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import { closeDates, dateRuns, locationDayClosure, openDates, parseOpeningHours, parseSpecialHours } from '~/shared/reservation-hours'
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
  /** Sessions no guest holds that a guest can still book; a location has none. */
  free: number | null
  /** Places a guest can still book that day, as the booking page counts them; null for a location or when a session is uncapped. */
  places_left: number | null
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

interface LocationRow { id: string; slug: string; title: string; status: string; timezone: string; address: string | null; opening_hours: string | null; special_hours: string | null; updated_at: string; assigned: number }
interface OfferingRow { id: string; name: string; kind: 'experience' | 'service'; timezone: string; scheduling_mode: string; assigned_member_id: string | null; provider_name: string | null; locations: string | null; assigned: number }

function fail(statusCode: number, message: string, field?: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code: statusCode === 404 ? 'PLACE_NOT_FOUND' : 'INVALID_PLACE_DATES', ...(field ? { field } : {}) } })
}

export function placesWindow(input: { from: unknown; to: unknown }): { from: string; to: string } {
  if (!isValidCalendarDate(input.from) || !isValidCalendarDate(input.to)) fail(400, 'from and to must be calendar dates', 'from')
  if (input.to <= input.from) fail(400, 'to must be after from', 'to')
  if (days(input.from, input.to) > PLACES_CALENDAR_DAYS) fail(400, `Read at most ${PLACES_CALENDAR_DAYS} days at once`, 'to')
  return { from: input.from, to: input.to }
}
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
const dates = (from: string, to: string) => Array.from({ length: days(from, to) }, (_, offset) => addLocalDays(from, offset))
/** The instants any local day of the window can start in, whatever the place's timezone. */
const instants = (window: { from: string; to: string }) => ({ fromInstant: `${addLocalDays(window.from, -1)}T00:00:00.000Z`, toInstant: `${addLocalDays(window.to, 1)}T00:00:00.000Z` })

const KIND_LABELS = { experience: 'Experience', service: 'Consultation' } as const

/**
 * The calendar's statements: its locations with tables, its experiences and
 * consultations, and the slot read of their offerings. The organization is a
 * SQL value so a route can name it by slug in the same batch as the
 * membership. Each row says whether the reader is assigned to it; the role
 * decides afterwards whether that matters.
 */
export function placesCalendarQueries(organization: BatchQuery, userId: string, window: { from: string; to: string }, only?: { kind: PlaceKind; id: string }): BatchQuery[] {
  const org = organization
  const products: BatchQuery = {
    query: `SELECT p.id FROM products p JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
      WHERE p.organization_id = ${org.query} AND ${only?.kind === 'location' ? "p.kind = 'table' AND p.id IN (SELECT product_id FROM product_locations WHERE location_id = ?)"
        : only ? "p.kind IN ('experience', 'service') AND p.id = ?" : "p.kind IN ('experience', 'service', 'table')"}`,
    params: [...org.params!, ...(only ? [only.id] : [])],
  }
  return [{
    query: only && only.kind !== 'location' ? 'SELECT NULL WHERE 0' : `
    SELECT l.id, l.slug, l.title, l.status, l.timezone, l.address, l.opening_hours, l.special_hours, l.updated_at, ${locationMemberSql('l.organization_id', 'l.id')} AS assigned
    FROM business_locations l
    WHERE l.organization_id = ${org.query} AND (? IS NULL OR l.id = ?)
      ${only ? '' : `AND EXISTS (SELECT 1 FROM product_locations pl JOIN products p ON p.id = pl.product_id AND p.organization_id = pl.organization_id
        JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
        WHERE pl.organization_id = l.organization_id AND pl.location_id = l.id AND p.kind = 'table')`}
    ORDER BY l.title, l.id`,
    params: only && only.kind !== 'location' ? [] : [userId, ...org.params!, only?.id ?? null, only?.id ?? null],
  }, {
    query: only && only.kind !== 'offering' ? 'SELECT NULL WHERE 0' : `
    SELECT p.id, p.name, p.kind, c.scheduling_mode, c.assigned_member_id, ${ASSIGNED_SERVICE_SQL} AS assigned,
           COALESCE((SELECT l.timezone FROM product_locations pl JOIN business_locations l ON l.id = pl.location_id AND l.organization_id = pl.organization_id WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id ORDER BY l.title LIMIT 1),
             (SELECT ms.timezone FROM member_scheduling ms WHERE ms.member_id = c.assigned_member_id AND ms.organization_id = c.organization_id), o.timezone) AS timezone,
           (SELECT ${MEMBER_NAME_SQL} FROM member m JOIN user u ON u.id = m.userId LEFT JOIN member_scheduling ms ON ms.member_id = m.id AND ms.organization_id = m.organizationId WHERE m.id = c.assigned_member_id AND m.organizationId = c.organization_id) AS provider_name,
           (SELECT group_concat(l.title, ' · ') FROM (SELECT l.title FROM product_locations pl JOIN business_locations l ON l.id = pl.location_id AND l.organization_id = pl.organization_id WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id ORDER BY l.title) l) AS locations
    FROM products p JOIN product_booking_configs c ON c.product_id = p.id AND c.organization_id = p.organization_id JOIN organization o ON o.id = p.organization_id
    WHERE p.organization_id = ${org.query} AND p.kind IN ('experience', 'service') AND (? IS NULL OR p.id = ?)
    ORDER BY p.name, p.id`,
    params: only && only.kind !== 'offering' ? [] : [userId, ...org.params!, only?.id ?? null, only?.id ?? null],
  }, ...slotReadQueries({ organization: org, products, ...instants(window), scope: 'editor', now: new Date().toISOString() })]
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
    const closure = locationDayClosure(row, hours, special, date)
    const held: PlaceHold | null = closure?.reason === 'inactive' ? { kind: 'inactive', text: `${row.title} is inactive` }
      : booked ? { kind: 'booked', text: `${booked} ${booked === 1 ? 'reservation' : 'reservations'}` }
        : closure?.reason === 'regular_hours' ? { kind: 'hours', text: `Closed: outside ${row.title}'s hours` } : null
    return { date, closed: closure !== null && (closure.reason !== 'regular_hours' || held?.kind === 'hours'), held, booked, free: null, places_left: null }
  })
}

function offeringDays(row: OfferingRow, window: string[], sessions: Map<string, BookableSession[]>, onSale: Set<string | null>, now: string): PlaceDay[] {
  const provider = row.scheduling_mode === 'provider'
  const first = stayGuestFirstName(row.provider_name)
  const hoursText = provider ? `Outside ${first ? `${first}'s` : 'the provider\'s'} hours` : 'No session on this day'
  return window.map((date) => {
    const onDay = sessions.get(date) ?? []
    const booked = onDay.filter(session => session.claimed > 0).length
    const writable = onDay.filter(session => session.claimed === 0)
    // What a guest can book that day, exactly as the booking page reads it.
    const open = onDay.filter(session => session.status === 'scheduled' && !session.is_full && session.starts_at > now && onSale.has(session.location_id))
    const held: PlaceHold | null = writable.length ? null
      : booked ? { kind: 'booked', text: `${booked} booked ${booked === 1 ? 'session' : 'sessions'}` }
        : { kind: provider ? 'hours' : 'unscheduled', text: hoursText }
    return {
      date, closed: writable.length > 0 && writable.every(session => session.status === 'cancelled'), held, booked,
      free: open.filter(session => session.claimed === 0).length,
      places_left: open.some(session => session.remaining === null) ? null : open.reduce((sum, session) => sum + session.remaining!, 0),
    }
  })
}

/** Each session's local date in the window, keyed by product. */
function byLocalDate<T extends { starts_at: string; timezone: string }>(rows: T[], window: { from: string; to: string }): Map<string, T[]> {
  const days = new Map<string, T[]>()
  for (const row of rows) {
    const date = localDateAt(new Date(row.starts_at), row.timezone)
    if (date < window.from || date >= window.to) continue
    days.set(date, [...(days.get(date) ?? []), row])
  }
  return days
}

/** The calendar from its statements' results: the role decides which rows the reader sees, and Google is asked only for those. */
export async function placesCalendarOf(principal: MemberAccessPrincipal, window: { from: string; to: string }, results: Array<{ results: unknown[] }>, only?: { kind: PlaceKind; id: string }): Promise<PlacesCalendar> {
  const [locationResult, offeringResult, ...slotResults] = results
  const [everyLocation, everyOffering, manageLocations, manageOfferings] = await Promise.all([
    roleAllows({ ...principal, permissions: { locations: ['read'] } }),
    roleAllows({ ...principal, permissions: { products: ['read'] } }),
    roleAllows({ ...principal, permissions: { locations: ['update'] } }),
    roleAllows({ ...principal, permissions: { products: ['update'] } }),
  ])
  const locations = (locationResult!.results as LocationRow[]).filter(row => everyLocation || row.assigned)
  const offerings = (offeringResult!.results as OfferingRow[]).filter(row => everyOffering || row.assigned)
  if (only && !locations.length && !offerings.length) fail(404, 'Place not found')
  const now = new Date().toISOString()
  // Only what the reader may see is computed: a hidden offering's settings never fail their calendar.
  const visible = new Set(offerings.map(row => row.id))
  const calendars = slotCalendars(principal.env, { ...instants(window), scope: 'editor', now }, slotResults, (productId, kind) => kind === 'table' || visible.has(productId))
  const span = dates(window.from, window.to)
  const reservations = new Map<string, Map<string, number>>()
  for (const location of locations) {
    const seatings = [...calendars.values()].filter(calendar => calendar.schedule.kind === 'table' && calendar.schedule.locations.has(location.id))
      .flatMap(calendar => calendar.stored.filter(row => row.location_id === location.id && row.bookings > 0))
    reservations.set(location.id, new Map([...byLocalDate(seatings, window)].map(([date, rows]) => [date, rows.reduce((sum, row) => sum + row.bookings, 0)])))
  }
  const sessions = await Promise.all(offerings.map(async (row) => {
    const calendar = calendars.get(row.id)
    if (!calendar) throw new Error(`Offering ${row.id} has no slot calendar`)
    return { onSale: calendar.onSale, days: byLocalDate(scheduleSessions(calendar, await calendar.places(), { statuses: ['scheduled', 'cancelled'], now }), window) }
  }))
  return {
    from: window.from, to: window.to, manage: manageLocations && manageOfferings,
    places: [
      ...locations.map(row => ({ place: placeOf(row), days: locationDays(row, span, reservations.get(row.id)!) })),
      ...offerings.map((row, index) => ({ place: placeOf(row), days: offeringDays(row, span, sessions[index]!.days, sessions[index]!.onSale, now) })),
    ],
  }
}

/** Every place the caller may see, with each day of [from, to), in one batch. */
export async function readPlacesCalendar(db: DbClient, principal: MemberAccessPrincipal, input: { from: unknown; to: unknown }, only?: { kind: PlaceKind; id: string }): Promise<PlacesCalendar> {
  const window = placesWindow(input)
  const results = await executeBatch(db, placesCalendarQueries({ query: '?', params: [principal.organizationId] }, principal.userId, window, only), { operation: 'Read places calendar' })
  return placesCalendarOf(principal, window, results, only)
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
  const { from, to } = placesWindow({ from: body.from, to: body.to })
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
    const calendar = (await readSlots(db, principal.env, {
      organization: { query: '?', params: [principal.organizationId] }, products: { query: 'SELECT ?', params: [id] },
      ...instants({ from, to }), scope: 'editor', now,
    })).get(id)
    if (!calendar) fail(404, 'Place not found')
    const days = prepareScheduleDays(calendar, await calendar.places(), { dates: chosen, closed, actorId: principal.userId, now })
    if (days.count) {
      await executeBatch(db, [
        ...days.queries,
        organizationEventQuery({ organizationId: principal.organizationId, locationId: null, actorId: principal.userId, eventType: 'product.updated', entityType: 'product', entityId: id,
          metadata: { from, to, closed, sessions: days.count, ...(weekdays ? { weekdays: weekdays.join(',') } : {}) } }),
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
