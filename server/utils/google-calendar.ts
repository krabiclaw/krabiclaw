import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import type { GoogleCalendarIntegration } from '~/shared/organization-settings'
import { execute, executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { composeBuyerActivityUrl } from './dashboard-notification-links'
import { BOOKING_ENDS_SQL, bookingDay, isBookingDay } from '~/server/domain/requests'
import { CURRENT_GUEST_SQL } from '~/server/domain/conversations'
import type { ProductKind } from '~/shared/product-details'
import { z } from 'zod'

export interface CalendarChoice { id: string; summary: string; accessRole: string; description?: string }
export class CalendarSelectionConflict extends Error {}
/**
 * A booking as its Google event shows it: any kind, a stay included. Its
 * starts_at/ends_at are the booking's; a stay whose home has no check-in or
 * checkout time stores that end as a day, and its event spans whole days.
 */
export interface CalendarSubject {
  booking_id: string
  /** What was booked: a table reads as a reservation, a consultation as a consultation, a home as a stay. */
  product_kind: ProductKind
  request_id: string | null
  buyer_user_id: string | null
  status: string
  starts_at: string
  ends_at: string
  timezone: string
  guest_name: string | null
  /** Who handles the booking: its product's member. */
  member_name: string | null
  guest_email: string | null
  member_email: string | null
  assigned_member_id: string | null
  is_consultation: number
  revision: string
}
interface GoogleEvent {
  id: string; etag?: string; status?: string; updated?: string
  summary?: string; description?: string; visibility?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  attendees?: Array<{ email?: string; responseStatus?: string; organizer?: boolean; resource?: boolean; additionalGuests?: number; optional?: boolean }>
  attendeesOmitted?: boolean
  guestsCanInviteOthers?: boolean; guestsCanModify?: boolean; guestsCanSeeOtherGuests?: boolean
}
interface EventLink {
  id: string; organization_id: string; integration_revision: string; account_id: string
  calendar_id: string; event_id: string; booking_id: string
  request_id: string | null; booking_revision: string; synced_revision: string | null
  state: string; updated_at: string
}
class CalendarError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Google Calendar returned ${status}. Check the account grant and calendar writer access.`)
    this.status = status
  }
}
const BASE = 'https://www.googleapis.com/calendar/v3'
async function google<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init?.headers },
  })
  if (!response.ok) throw new CalendarError(response.status)
  return response.status === 204 ? undefined as T : await response.json() as T
}
export async function listWritableCalendars(token: string): Promise<CalendarChoice[]> {
  const calendars: CalendarChoice[] = []
  let next: string | undefined
  do {
    const result = await google<{ items?: CalendarChoice[]; nextPageToken?: string }>(token,
      `/users/me/calendarList?minAccessRole=writer&showHidden=true&maxResults=250${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`)
    calendars.push(...(result.items ?? []).filter(item => ['owner', 'writer'].includes(item.accessRole)))
    next = result.nextPageToken
  } while (next)
  return calendars
}
/** Google owns the calendar; only its domain identity is stored locally. */
export async function connectCalendar(db: DbClient, organizationId: string, accountId: string, token: string) {
  const current = await readCalendarIntegration(db, organizationId)
  if (current?.account_id === accountId && current.status !== 'disabled') {
    await requireWriter(token, current.calendar_id)
    return
  }
  const pending = await queryFirst<{ n: number }>(db, "SELECT count(*) n FROM google_calendar_event_links WHERE organization_id=? AND state<>'deleted'", [organizationId])
  if (pending?.n) throw new CalendarSelectionConflict('Your previous calendar is still disconnecting. Try again shortly.')
  if (current?.account_id === accountId) {
    await requireWriter(token, current.calendar_id)
    await storeCalendarSelection(db, organizationId, current)
    return
  }
  const attempt = await queryFirst<{ account_id: string; revision: string }>(db,
    "SELECT account_id, revision FROM organization_integrations WHERE organization_id = ? AND provider = 'google_calendar' AND status = 'setting_up'", [organizationId])
  if (attempt && attempt.account_id !== accountId) throw new CalendarSelectionConflict('Finish connecting the previous Google account first.')
  let revision = attempt?.revision ?? current?.revision ?? null
  // Google assigns the calendar ID. The provider's exact marker identifies a
  // calendar when a previous create may have succeeded before its reply arrived.
  const marker = `Krabiclaw bookings for organization ${organizationId}`
  const calendars = (await listWritableCalendars(token)).filter(item => item.description === marker)
  if (calendars.length > 1) throw new CalendarSelectionConflict('More than one booking calendar was found. Contact support.')
  let calendar = calendars[0]
  if (!calendar) {
    if (attempt) throw new CalendarSelectionConflict('Calendar setup has not finished. Retry to check its progress.')
    const now = new Date().toISOString()
    revision = crypto.randomUUID()
    const claim = await execute(db, `INSERT INTO organization_integrations
      (id, organization_id, provider, account_id, status, revision, created_at, updated_at)
      SELECT ?, o.id, 'google_calendar', ?, 'setting_up', ?, ?, ? FROM organization o WHERE o.id = ?
        AND NOT EXISTS (SELECT 1 FROM google_calendar_event_links WHERE organization_id = o.id AND state <> 'deleted')
        AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM organization_integrations WHERE organization_id = o.id AND provider = 'google_calendar'))
          OR EXISTS (SELECT 1 FROM organization_integrations WHERE organization_id = o.id AND provider = 'google_calendar' AND revision = ?))
      ON CONFLICT (organization_id, provider) DO UPDATE SET account_id = excluded.account_id, status = excluded.status,
        revision = excluded.revision, updated_at = excluded.updated_at, target_id = NULL, target_name = NULL, last_error = NULL`,
    [crypto.randomUUID(), accountId, revision, now, now, organizationId, current?.revision ?? null, current?.revision ?? null])
    if (claim.meta.changes !== 1) throw new CalendarSelectionConflict('Calendar selection changed. Reload and try again.')
    try {
      calendar = await google<CalendarChoice>(token, '/calendars', { method: 'POST', body: JSON.stringify({ summary: 'KrabiClaw', description: marker }) })
      if (!calendar?.id || !calendar.summary) throw new Error('Google did not return the new booking calendar.')
    } catch (error) {
      // A refused create leaves the previous selection in place. An ambiguous
      // result keeps the claim until the provider shows the calendar.
      if (error instanceof CalendarError && error.status >= 400 && error.status < 500) {
        const restored = current
          ? await execute(db, `UPDATE organization_integrations SET account_id = ?, target_id = ?, target_name = ?, status = ?, last_error = ?, revision = ?, updated_at = ?
              WHERE organization_id = ? AND provider = 'google_calendar' AND revision = ?`,
            [current.account_id, current.calendar_id, current.calendar_name, current.status, current.last_error, current.revision, current.updated_at, organizationId, revision])
          : await execute(db, "DELETE FROM organization_integrations WHERE organization_id = ? AND provider = 'google_calendar' AND revision = ?", [organizationId, revision])
        if (restored.meta.changes !== 1) throw new CalendarSelectionConflict('Calendar selection changed while Google refused the new calendar.', { cause: error })
      }
      throw error
    }
  }
  await storeCalendarSelection(db, organizationId, { account_id: accountId, calendar_id: calendar.id, calendar_name: calendar.summary }, { revision })
}
async function requireWriter(token: string, calendarId: string) {
  const calendar = await google<CalendarChoice>(token, `/users/me/calendarList/${encodeURIComponent(calendarId)}`)
  if (!['writer', 'owner'].includes(calendar.accessRole)) throw new Error('This account no longer has calendar writer access.')
  return calendar
}
export function calendarEvent(subject: CalendarSubject, managementUrl: string | null, previous?: GoogleEvent) {
  new Intl.DateTimeFormat('en', { timeZone: subject.timezone }).format()
  // An end known only as a day makes the event whole days: the stay's check-in day to its checkout day, Google's end being exclusive.
  const allDay = isBookingDay(subject.starts_at) || isBookingDay(subject.ends_at)
  const [start, end] = allDay ? [bookingDay(subject.starts_at, subject.timezone), bookingDay(subject.ends_at, subject.timezone)] : [subject.starts_at, subject.ends_at]
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || end <= start) throw new Error('Invalid canonical booking interval')
  const consultation = Boolean(subject.is_consultation)
  const noun = consultation ? 'Consultation' : subject.product_kind === 'table' ? 'Reservation' : subject.product_kind === 'stay' ? 'Stay' : 'Booking'
  const attendees: Array<{ email: string; responseStatus: string }> = []
  if (consultation && subject.status === 'confirmed' && !subject.request_id) throw new Error('The confirmed consultation is missing its client conversation; Calendar invitations cannot be sent.')
  // An allocation without its request is a private hold, not a client invitation.
  if (consultation && subject.request_id) {
    for (const email of [subject.guest_email, subject.member_email]) {
      if (!email || !z.email().safeParse(email).success) throw new Error('The consultation requires a real client email and a verified assigned attorney email before Calendar invitations can be sent.')
      const normalized = email.trim().toLowerCase()
      if (attendees.some(item => item.email === normalized)) continue
      const retained = previous?.attendees?.find(item => item.email?.toLowerCase() === normalized)
      attendees.push({ email: normalized, responseStatus: retained?.responseStatus ?? 'needsAction' })
    }
  }
  return {
    summary: `${subject.status === 'pending' ? 'Pending ' + noun.toLowerCase() : noun}${!consultation && subject.guest_name ? ' — ' + subject.guest_name : ''}`,
    description: `Status: ${subject.status}${subject.member_name ? `\n${consultation ? 'Attorney' : 'Team member'}: ${subject.member_name}` : ''}${subject.buyer_user_id && subject.request_id && managementUrl ? `\nManage ${noun.toLowerCase()}: ${managementUrl}` : ''}`,
    start: allDay ? { date: start } : { dateTime: start, timeZone: subject.timezone },
    end: allDay ? { date: end } : { dateTime: end, timeZone: subject.timezone },
    visibility: 'private',
    // Stated, so that rewriting an event someone deleted in Google brings it back.
    status: consultation && subject.status === 'pending' ? 'tentative' : 'confirmed',
    ...(consultation ? { attendees, guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: false } : {}),
  }
}
export async function readCalendarIntegration(db: DbClient, organizationId: string): Promise<GoogleCalendarIntegration | null> {
  return (await queryFirst<GoogleCalendarIntegration>(db, "SELECT account_id, target_id AS calendar_id, target_name AS calendar_name, status, last_error, revision, created_at, updated_at FROM organization_integrations WHERE organization_id=? AND provider='google_calendar' AND status <> 'setting_up'", [organizationId])) ?? null
}
// The canonical subject query serves both changed-subject batches and one
// provider identity's lifecycle fences. The database bounds each result.
export async function calendarSubjects(db: DbClient, organizationId: string, integration: GoogleCalendarIntegration, identity?: Pick<EventLink, 'booking_id'>): Promise<CalendarSubject[]> {
  const now = new Date().toISOString()
  return queryAll<CalendarSubject>(db, `WITH subjects AS (
    SELECT b.id booking_id, (SELECT p.kind FROM products p WHERE p.id=b.product_id AND p.organization_id=b.organization_id) product_kind, r.id request_id,
      CASE WHEN r.kind='booking' AND (${CURRENT_GUEST_SQL('r')}) THEN r.user_id END buyer_user_id, b.status,
      b.starts_at, b.ends_at, b.timezone, json_extract(r.payload_json, '$.guest.name') guest_name, member.name member_name,
      json_extract(r.payload_json,'$.guest.email') guest_email, member.email member_email, c.assigned_member_id,
      EXISTS(SELECT 1 FROM products p WHERE p.id=b.product_id AND p.organization_id=b.organization_id AND p.kind='service') is_consultation,
      json_array(b.status, b.starts_at, b.ends_at, b.timezone, json_extract(r.payload_json,'$.guest.name'), member.name,
        json_extract(r.payload_json,'$.guest.email'), member.email, c.assigned_member_id, r.id,
        CASE WHEN r.kind='booking' AND (${CURRENT_GUEST_SQL('r')}) THEN r.user_id END) revision
    FROM bookings b LEFT JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
      JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id
      LEFT JOIN conversations r ON r.booking_id=b.id AND r.kind='booking' AND r.organization_id=b.organization_id
      LEFT JOIN (SELECT m.id, m.organizationId, ${MEMBER_NAME_SQL} name, CASE WHEN u.emailVerified=1 THEN u.email END email FROM member m JOIN user u ON u.id=m.userId
        LEFT JOIN member_scheduling ms ON ms.member_id=m.id) member ON member.id=c.assigned_member_id AND member.organizationId=b.organization_id
    WHERE b.organization_id=? AND b.status IN ('pending','confirmed')
      AND (b.product_session_id IS NULL OR s.status='scheduled') AND ${BOOKING_ENDS_SQL('b')}>? AND (? IS NULL OR b.id=?)
  ) SELECT subjects.* FROM subjects
    LEFT JOIN google_calendar_event_links l ON l.organization_id=? AND l.integration_revision=?
      AND l.booking_id=subjects.booking_id AND l.state<>'deleted'
    WHERE ? IS NOT NULL OR l.id IS NULL OR l.booking_revision<>subjects.revision
    ORDER BY COALESCE(l.updated_at,''), subjects.booking_id LIMIT ?`,
  [organizationId,now,identity?.booking_id??null,identity?.booking_id??null,
    organizationId,integration.revision,identity?.booking_id??null,identity?1:25])
}
/** Persist intents before any provider I/O, including initial upcoming backfill. */
async function reconcileIntents(db: DbClient, organizationId: string, integration: GoogleCalendarIntegration) {
  const subjects = integration.status === 'disabled' ? [] : await calendarSubjects(db, organizationId, integration)
  const now = new Date().toISOString()
  for (const subject of subjects) {
    const revision = subject.revision
    const id = crypto.randomUUID()
    await execute(db, `INSERT INTO google_calendar_event_links
      (id, organization_id, integration_revision, account_id, calendar_id, event_id, booking_id, request_id, booking_revision, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM organization_integrations WHERE organization_id = ? AND provider='google_calendar' AND revision = ? AND status <> 'disabled'
      ON CONFLICT(organization_id, integration_revision, booking_id) WHERE state <> 'deleted' DO UPDATE SET
      request_id = excluded.request_id, booking_revision = excluded.booking_revision,
      state = CASE WHEN google_calendar_event_links.booking_revision <> excluded.booking_revision THEN 'pending' ELSE google_calendar_event_links.state END,
      updated_at = excluded.updated_at WHERE google_calendar_event_links.booking_revision <> excluded.booking_revision`,
    [id, organizationId, integration.revision, integration.account_id, integration.calendar_id, 'kc' + id.replaceAll('-', ''), subject.booking_id, subject.request_id, revision, now, now, organizationId, integration.revision])
  }
  // Select only stale identities. Unchanged and historical successful events
  // receive no writes; cleanup also has a database batch limit.
  await execute(db, `UPDATE google_calendar_event_links SET state='cleanup'
    WHERE id IN (SELECT l.id FROM google_calendar_event_links l
      WHERE l.organization_id=? AND l.state NOT IN ('deleted','cleanup')
        AND (?='disabled' OR l.integration_revision<>? OR NOT EXISTS (
            SELECT 1 FROM bookings b LEFT JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
              JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id
            WHERE b.id=l.booking_id AND b.organization_id=l.organization_id AND (b.product_session_id IS NULL OR s.status='scheduled')
              AND ((b.status IN ('pending','confirmed') AND ${BOOKING_ENDS_SQL('b')}>?)
                OR (b.status='confirmed' AND ${BOOKING_ENDS_SQL('b')}<=? AND l.state='synced'))))
      ORDER BY l.updated_at,l.id LIMIT 25)`,
  [organizationId,integration.status,integration.revision,now,now])
}
async function removeEvent(token: string, link: Pick<EventLink, 'calendar_id' | 'event_id'>) {
  const path = `/calendars/${encodeURIComponent(link.calendar_id)}/events/${link.event_id}`
  await requireWriter(token, link.calendar_id)
  try { await google(token, `${path}?sendUpdates=all`, { method: 'DELETE' }) }
  catch (error) {
    if (!(error instanceof CalendarError) || ![404, 410].includes(error.status)) throw error
    // Event absence is only meaningful while the calendar remains accessible.
    await requireWriter(token, link.calendar_id)
  }
}
async function currentSubject(db: DbClient, organizationId: string, link: EventLink) {
  const integration = await readCalendarIntegration(db, organizationId)
  if (integration?.revision !== link.integration_revision || integration.status === 'disabled') return null
  return (await calendarSubjects(db, organizationId, integration, link))[0] ?? null
}
export interface CalendarProvider {
  token(accountId: string): Promise<string>
}
function defaultProvider(env: CloudflareEnv): CalendarProvider {
  return { token: async accountId => (await linkedAccountAccessToken(env, accountId)).accessToken }
}
export async function syncCalendarOrganization(env: CloudflareEnv, organizationId: string, limit = 25, provider: CalendarProvider = defaultProvider(env)) {
  const db = env.DB
  const integration = await readCalendarIntegration(db, organizationId)
  if (!integration) return { checked: 0, failed: 0 }
  await reconcileIntents(db, organizationId, integration)
  // A failure moves its link's updated_at on, so it waits behind the others rather than starving them.
  const links = await queryAll<EventLink>(db, `SELECT * FROM google_calendar_event_links WHERE organization_id = ?
    AND state IN ('pending', 'cleanup', 'error') ORDER BY updated_at, id LIMIT ?`, [organizationId, limit])
  let checked = 0; let failed = 0
  for (const link of links) {
    checked++
    try {
      const token = await provider.token(link.account_id)
      const subject = await currentSubject(db, organizationId, link)
      if (!subject || link.state === 'cleanup') {
        await removeEvent(token, link)
        await execute(db, "UPDATE google_calendar_event_links SET state='deleted', last_error=NULL, updated_at=? WHERE id=?", [new Date().toISOString(), link.id])
        continue
      }
      const revision = subject.revision
      if (revision !== link.booking_revision) {
        await execute(db, "UPDATE google_calendar_event_links SET state='pending' WHERE id=?", [link.id])
        continue
      }
      await requireWriter(token, link.calendar_id)
      const url = subject.request_id && subject.buyer_user_id ? composeBuyerActivityUrl(env, subject.product_kind === 'stay' ? 'stay' : 'booking', subject.request_id) : null
      const path = `/calendars/${encodeURIComponent(link.calendar_id)}/events`
      let existing: GoogleEvent | undefined
      try { existing = await google<GoogleEvent>(token, `${path}/${link.event_id}`) }
      catch (error) { if (!(error instanceof CalendarError) || ![404, 410].includes(error.status)) throw error }
      if (existing?.attendeesOmitted) throw new Error('Google omitted consultation attendees; the complete event is required before updating invitations.')
      const payload = calendarEvent(subject, url, existing)
      const beforeUpdate = await currentSubject(db, organizationId, link)
      if (!beforeUpdate) {
        await removeEvent(token, link)
        await execute(db, "UPDATE google_calendar_event_links SET state='deleted' WHERE id=?", [link.id])
        continue
      }
      if (beforeUpdate.revision !== revision) {
        await execute(db, "UPDATE google_calendar_event_links SET state=CASE WHEN state='cleanup' THEN state ELSE 'pending' END WHERE id=?", [link.id])
        continue
      }
      if (!existing) {
        // Google refuses a second insert of the same event id with 409, a
        // visible failure; the next pass reads that event instead.
        await google(token, `${path}?sendUpdates=all`, { method: 'POST', body: JSON.stringify({ id: link.event_id, ...payload }) })
      } else {
        if (!existing.etag) throw new Error('Google returned no event ETag; the event cannot be updated without risking a concurrent change.')
        const unchanged = Object.entries(payload).every(([key, value]) => {
          if (key === 'start' || key === 'end') return Date.parse(existing![key]?.dateTime ?? '') === Date.parse((value as { dateTime: string }).dateTime) && existing![key]?.timeZone === (value as { timeZone: string }).timeZone
          if (key === 'attendees') return !(existing!.attendees ?? []).some(item => item.additionalGuests || item.resource || item.optional) && JSON.stringify((existing!.attendees ?? []).map(item => ({ email: item.email?.toLowerCase(), responseStatus: item.responseStatus ?? 'needsAction' })).sort((a,b) => (a.email ?? '').localeCompare(b.email ?? ''))) === JSON.stringify([...(payload.attendees ?? [])].sort((a,b) => a.email.localeCompare(b.email)))
          return JSON.stringify(existing![key as keyof GoogleEvent]) === JSON.stringify(value)
        })
        if (!unchanged) await google(token, `${path}/${link.event_id}?sendUpdates=all`, { method: 'PUT', headers: { 'If-Match': existing.etag }, body: JSON.stringify(payload) })
      }
      // A booking cancelled or a calendar disconnected while Google wrote the
      // event: the event that write left is deleted again.
      const afterSubject = await currentSubject(db, organizationId, link)
      if (!afterSubject) {
        await removeEvent(token, link)
        await execute(db, "UPDATE google_calendar_event_links SET state='deleted' WHERE id=?", [link.id])
      } else {
        await execute(db, 'UPDATE google_calendar_event_links SET state=?, synced_revision=?, last_synced_at=?, last_error=NULL WHERE id=?',
          [afterSubject.revision === revision ? 'synced' : 'pending', revision, new Date().toISOString(), link.id])
      }
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      await executeBatch(db, [
        { query: "UPDATE google_calendar_event_links SET state=CASE WHEN state='cleanup' THEN state ELSE 'error' END, last_error=?, updated_at=? WHERE id=?", params: [message, new Date().toISOString(), link.id] },
        { query: "UPDATE organization_integrations SET status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'error' END, last_error=? WHERE organization_id=? AND provider='google_calendar' AND revision=?", params: [message, organizationId, integration.revision] },
      ])
    }
  }
  const remaining = await queryFirst<{ n: number }>(db, "SELECT count(*) n FROM google_calendar_event_links WHERE organization_id=? AND state IN ('pending','cleanup','error')", [organizationId])
  if (!remaining?.n) await execute(db, "UPDATE organization_integrations SET status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'active' END, last_error=NULL WHERE organization_id=? AND provider='google_calendar' AND revision=?", [organizationId, integration.revision])
  return { checked, failed, remaining: remaining?.n ?? 0 }
}
/** Disable first, then clean managed identities. A failed cleanup stays visible. */
export async function disconnectCalendar(db: DbClient, organizationId: string) {
  await execute(db, "UPDATE organization_integrations SET status='disabled', updated_at=? WHERE organization_id=? AND provider='google_calendar' AND status <> 'setting_up'", [new Date().toISOString(), organizationId])
  await execute(db, "UPDATE google_calendar_event_links SET state='cleanup' WHERE organization_id=? AND state <> 'deleted'", [organizationId])
}
export async function storeCalendarSelection(db: DbClient, organizationId: string, selection: Pick<GoogleCalendarIntegration, 'account_id' | 'calendar_id' | 'calendar_name'>, expected?: { revision: string | null }) {
  const pending = await queryFirst<{ n: number }>(db, "SELECT count(*) n FROM google_calendar_event_links WHERE organization_id=? AND state <> 'deleted'", [organizationId])
  const revision = expected ? expected.revision : (await readCalendarIntegration(db, organizationId))?.revision ?? null
  if (pending?.n) throw new CalendarSelectionConflict('Disconnect and finish cleanup of the previous calendar before changing the selection.')
  const now = new Date().toISOString()
  const payload: GoogleCalendarIntegration = { ...selection, revision: crypto.randomUUID(), status: 'active', last_error: null, created_at: now, updated_at: now }
  const result = await execute(db, `INSERT INTO organization_integrations
    (id,organization_id,provider,account_id,target_id,target_name,status,last_error,revision,created_at,updated_at)
    SELECT ?,?,'google_calendar',?,?,?,'active',NULL,?,?,? FROM organization o WHERE o.id=?
    AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM organization_integrations i WHERE i.organization_id=o.id AND i.provider='google_calendar'))
      OR EXISTS(SELECT 1 FROM organization_integrations i WHERE i.organization_id=o.id AND i.provider='google_calendar' AND i.revision=?))
    AND NOT EXISTS(SELECT 1 FROM google_calendar_event_links WHERE organization_id=o.id AND state<>'deleted')
    AND NOT EXISTS(SELECT 1 FROM member_scheduling ms,json_each(ms.calendar_ids_json) calendar WHERE ms.organization_id=o.id AND ms.calendar_account_id IS NOT NULL AND calendar.value=?)
    ON CONFLICT(organization_id,provider) DO UPDATE SET account_id=excluded.account_id,target_id=excluded.target_id,target_name=excluded.target_name,
    status=excluded.status,last_error=NULL,
    revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at`,
  [crypto.randomUUID(),organizationId,payload.account_id,payload.calendar_id,payload.calendar_name,payload.revision,now,now,organizationId,revision,revision,payload.calendar_id])
  if (result.meta?.changes !== 1) throw new CalendarSelectionConflict('Calendar selection changed. Reload and try again.')
}

interface CleanupJob {
  id: string; organization_id: string; account_id: string; calendar_id: string; event_id: string
}
/** Common deletion hook: stage identities durably; no Google calls can block deletion. */
export async function stageCalendarOrganizationCleanup(db: DbClient, organizationId: string) {
  const now = new Date().toISOString()
  await executeBatch(db, [
    { query: `INSERT INTO google_calendar_cleanup_jobs
      (id, organization_id, account_id, calendar_id, event_id, created_at, updated_at)
      SELECT id, organization_id, account_id, calendar_id, event_id, ?, ?
      FROM google_calendar_event_links WHERE organization_id=? AND state <> 'deleted'
      ON CONFLICT(calendar_id, event_id) DO NOTHING`, params: [now, now, organizationId] },
    { query: "UPDATE organization_integrations SET status='disabled', updated_at=? WHERE organization_id=? AND provider='google_calendar' AND status <> 'setting_up'", params: [now, organizationId] },
    { query: "UPDATE google_calendar_event_links SET state='cleanup' WHERE organization_id=? AND state <> 'deleted'", params: [organizationId] },
  ], { operation: 'retain Google Calendar organization cleanup identities' })
}
/** Delete-only outbox. Orphan jobs cannot enroll, recreate, update or expose a tenant. */
export async function runCalendarCleanupJobs(env: CloudflareEnv, limit = 25, provider: CalendarProvider = {
  token: async accountId => (await linkedAccountAccessToken(env, accountId)).accessToken,
}) {
  const db = env.DB
  // A failure moves its job's updated_at on, so it waits behind the others rather than starving them.
  const jobs = await queryAll<CleanupJob>(db, `SELECT id, organization_id, account_id, calendar_id, event_id
    FROM google_calendar_cleanup_jobs WHERE state IN ('pending','error')
    AND NOT EXISTS (SELECT 1 FROM organization WHERE organization.id=google_calendar_cleanup_jobs.organization_id)
    ORDER BY updated_at, id LIMIT ?`, [limit])
  let checked = 0; let failed = 0
  for (const job of jobs) {
    checked++
    try {
      await removeEvent(await provider.token(job.account_id), job)
      await execute(db, "UPDATE google_calendar_cleanup_jobs SET state='deleted', last_error=NULL, completed_at=?, updated_at=? WHERE id=?",
        [new Date().toISOString(), new Date().toISOString(), job.id])
    } catch (error) {
      failed++
      await execute(db, "UPDATE google_calendar_cleanup_jobs SET state='error', last_error=?, updated_at=? WHERE id=?",
        [error instanceof Error ? error.message : String(error), new Date().toISOString(), job.id])
    }
  }
  return { checked, failed }
}
