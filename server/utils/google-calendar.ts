import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import type { GoogleCalendarIntegration } from '~/shared/organization-settings'
import { execute, executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { composeBuyerActivityUrl } from './dashboard-notification-links'
import { REQUEST_CURRENT_BUYER_SQL } from '~/server/domain/requests'
import { z } from 'zod'

export interface CalendarChoice { id: string; summary: string; accessRole: string; description?: string }
export class CalendarSelectionConflict extends Error {}
export interface CalendarSubject {
  booking_kind: 'booking' | 'reservation'
  operational_id: string
  request_id: string | null
  buyer_user_id: string | null
  status: string
  starts_at: string
  ends_at: string
  timezone: string
  guest_name: string | null
  /** Who delivers a booking; reservations have none. */
  member_name: string | null
  guest_email: string | null
  member_email: string | null
  assigned_member_id: string | null
  is_consultation: number
  revision: string
}
export interface GoogleEvent {
  id: string; etag?: string; status?: string; updated?: string
  summary?: string; description?: string; visibility?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  attendees?: Array<{ email?: string; responseStatus?: string; organizer?: boolean; resource?: boolean; additionalGuests?: number; optional?: boolean }>
  attendeesOmitted?: boolean
  guestsCanInviteOthers?: boolean; guestsCanModify?: boolean; guestsCanSeeOtherGuests?: boolean
}
export interface EventLink {
  id: string; organization_id: string; integration_revision: string; account_id: string
  calendar_id: string; event_id: string; booking_kind: CalendarSubject['booking_kind']; operational_id: string
  request_id: string | null; booking_revision: string; synced_revision: string | null
  state: string; updated_at: string
}
export class CalendarError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Google Calendar returned ${status}. Check the account grant and calendar writer access.`)
    this.status = status
  }
}
const BASE = 'https://www.googleapis.com/calendar/v3'
export async function google<T>(token: string, path: string, init?: RequestInit): Promise<T> {
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
  // Google holds this text as the calendar's identity; its spelling cannot change.
  const marker = `Krabiclaw bookings for organization ${organizationId}`
  const calendars = (await listWritableCalendars(token)).filter(item => item.description === marker)
  if (calendars.length > 1) throw new CalendarSelectionConflict('More than one booking calendar was found. Contact support.')
  let calendar = calendars[0]
  if (!calendar) {
    const claim = await execute(db, 'INSERT INTO google_calendar_setup(organization_id,account_id,started_at) VALUES(?,?,?) ON CONFLICT(organization_id) DO NOTHING', [organizationId, accountId, new Date().toISOString()])
    if (claim.meta?.changes !== 1) throw new CalendarSelectionConflict('Calendar setup has not finished. Retry to check its progress.')
    try {
      calendar = await google<CalendarChoice>(token, '/calendars', { method: 'POST', body: JSON.stringify({ summary: 'KrabiClaw', description: marker }) })
      if (!calendar?.id || !calendar.summary) throw new Error('Google did not return the new booking calendar.')
    } catch (error) {
      // A rejected request cannot have created a resource. A timeout or 5xx
      // can, so its durable attempt blocks duplicate creation on retry.
      if (error instanceof CalendarError && error.status >= 400 && error.status < 500) await execute(db, 'DELETE FROM google_calendar_setup WHERE organization_id=? AND account_id=?', [organizationId, accountId])
      throw error
    }
  }
  const attempt = await queryFirst<{ account_id: string }>(db, 'SELECT account_id FROM google_calendar_setup WHERE organization_id=?', [organizationId])
  if (attempt && attempt.account_id !== accountId) throw new CalendarSelectionConflict('Finish connecting the previous Google account first.')
  await storeCalendarSelection(db, organizationId, { account_id: accountId, calendar_id: calendar.id, calendar_name: calendar.summary })
  await execute(db, 'DELETE FROM google_calendar_setup WHERE organization_id=? AND account_id=?', [organizationId, accountId])
}
async function requireWriter(token: string, calendarId: string) {
  const calendar = await google<CalendarChoice>(token, `/users/me/calendarList/${encodeURIComponent(calendarId)}`)
  if (!['writer', 'owner'].includes(calendar.accessRole)) throw new Error('This account no longer has calendar writer access.')
  return calendar
}
export function calendarEvent(subject: CalendarSubject, managementUrl: string | null, previous?: GoogleEvent) {
  if (!Number.isFinite(Date.parse(subject.starts_at)) || !Number.isFinite(Date.parse(subject.ends_at)) || subject.ends_at <= subject.starts_at) throw new Error('Invalid canonical booking interval')
  new Intl.DateTimeFormat('en', { timeZone: subject.timezone }).format()
  const consultation = Boolean(subject.is_consultation)
  const noun = consultation ? 'Consultation' : subject.booking_kind === 'booking' ? 'Booking' : 'Reservation'
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
    start: { dateTime: subject.starts_at, timeZone: subject.timezone },
    end: { dateTime: subject.ends_at, timeZone: subject.timezone },
    visibility: 'private',
    // Stated, so that rewriting an event someone deleted in Google brings it back.
    status: consultation && subject.status === 'pending' ? 'tentative' : 'confirmed',
    ...(consultation ? { attendees, guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: false } : {}),
  }
}
export async function readCalendarIntegration(db: DbClient, organizationId: string): Promise<GoogleCalendarIntegration | null> {
  return (await queryFirst<GoogleCalendarIntegration>(db, "SELECT account_id, target_id AS calendar_id, target_name AS calendar_name, status, last_error, revision, created_at, updated_at FROM organization_integrations WHERE organization_id=? AND provider='google_calendar'", [organizationId])) ?? null
}
// The canonical subject query serves both changed-subject batches and one
// provider identity's lifecycle fences. The database bounds each result.
export async function calendarSubjects(db: DbClient, organizationId: string, integration: GoogleCalendarIntegration, identity?: Pick<EventLink, 'booking_kind' | 'operational_id'>): Promise<CalendarSubject[]> {
  const now = new Date().toISOString()
  return queryAll<CalendarSubject>(db, `WITH subjects AS (
    SELECT 'booking' booking_kind, b.id operational_id, b.request_id,
      CASE WHEN r.kind='booking' AND (${REQUEST_CURRENT_BUYER_SQL}) THEN r.user_id END buyer_user_id, b.status,
      s.starts_at, s.ends_at, s.timezone, json_extract(r.payload_json, '$.guest.name') guest_name, member.name member_name,
      json_extract(r.payload_json,'$.guest.email') guest_email, member.email member_email, c.assigned_member_id,
      EXISTS(SELECT 1 FROM products p WHERE p.id=b.product_id AND p.organization_id=b.organization_id AND p.kind='service') is_consultation,
      json_array(b.status, s.starts_at, s.ends_at, s.timezone, json_extract(r.payload_json,'$.guest.name'), member.name,
        json_extract(r.payload_json,'$.guest.email'), member.email, c.assigned_member_id, b.request_id,
        CASE WHEN r.kind='booking' AND (${REQUEST_CURRENT_BUYER_SQL}) THEN r.user_id END) revision
    FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
      JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id
      LEFT JOIN requests r ON r.id=b.request_id AND r.organization_id=b.organization_id
      LEFT JOIN (SELECT m.id, m.organizationId, ${MEMBER_NAME_SQL} name, CASE WHEN u.emailVerified=1 THEN u.email END email FROM member m JOIN user u ON u.id=m.userId
        LEFT JOIN member_scheduling ms ON ms.member_id=m.id) member ON member.id=c.assigned_member_id AND member.organizationId=b.organization_id
    WHERE b.organization_id=? AND b.status IN ('pending','confirmed')
      AND s.status='scheduled' AND s.ends_at>? AND (? IS NULL OR (?='booking' AND b.id=?))
    UNION ALL
    SELECT 'reservation', b.id, b.request_id,
      CASE WHEN r.kind='reservation' AND (${REQUEST_CURRENT_BUYER_SQL}) THEN r.user_id END, b.status, b.starts_at, b.ends_at, b.timezone,
      json_extract(r.payload_json,'$.guest.name'), NULL, NULL, NULL, NULL, 0,
      json_array(b.status, b.starts_at, b.ends_at, b.timezone, json_extract(r.payload_json,'$.guest.name'), b.request_id,
        CASE WHEN r.kind='reservation' AND (${REQUEST_CURRENT_BUYER_SQL}) THEN r.user_id END)
    FROM reservations b LEFT JOIN requests r ON r.id=b.request_id AND r.organization_id=b.organization_id
    WHERE b.organization_id=? AND b.status IN ('pending','confirmed') AND b.ends_at>?
      AND (? IS NULL OR (?='reservation' AND b.id=?))
  ) SELECT subjects.* FROM subjects
    LEFT JOIN google_calendar_event_links l ON l.organization_id=? AND l.integration_revision=?
      AND l.booking_kind=subjects.booking_kind AND l.operational_id=subjects.operational_id AND l.state<>'deleted'
    WHERE ? IS NOT NULL OR l.id IS NULL OR l.booking_revision<>subjects.revision
    ORDER BY COALESCE(l.updated_at,''), subjects.booking_kind, subjects.operational_id LIMIT ?`,
  [organizationId,now,identity?.operational_id??null,identity?.booking_kind??null,identity?.operational_id??null,
    organizationId,now,identity?.operational_id??null,identity?.booking_kind??null,identity?.operational_id??null,
    organizationId,integration.revision,identity?.operational_id??null,identity?1:25])
}
/** Persist intents before any provider I/O, including initial upcoming backfill. */
async function reconcileIntents(db: DbClient, organizationId: string, integration: GoogleCalendarIntegration) {
  const subjects = integration.status === 'disabled' ? [] : await calendarSubjects(db, organizationId, integration)
  const now = new Date().toISOString()
  for (const subject of subjects) {
    const revision = subject.revision
    const id = crypto.randomUUID()
    await execute(db, `INSERT INTO google_calendar_event_links
      (id, organization_id, integration_revision, account_id, calendar_id, event_id, booking_kind, operational_id, request_id, booking_revision, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM organization_integrations WHERE organization_id = ? AND provider='google_calendar' AND revision = ? AND status <> 'disabled'
      ON CONFLICT(organization_id, integration_revision, booking_kind, operational_id) WHERE state <> 'deleted' DO UPDATE SET
      request_id = excluded.request_id, booking_revision = excluded.booking_revision,
      state = CASE WHEN google_calendar_event_links.booking_revision <> excluded.booking_revision THEN 'pending' ELSE google_calendar_event_links.state END,
      updated_at = excluded.updated_at WHERE google_calendar_event_links.booking_revision <> excluded.booking_revision`,
    [id, organizationId, integration.revision, integration.account_id, integration.calendar_id, 'kc' + id.replaceAll('-', ''), subject.booking_kind, subject.operational_id, subject.request_id, revision, now, now, organizationId, integration.revision])
  }
  // Select only stale identities. Unchanged and historical successful events
  // receive no writes; cleanup also has a database batch limit.
  await execute(db, `UPDATE google_calendar_event_links SET state='cleanup'
    WHERE id IN (SELECT l.id FROM google_calendar_event_links l
      WHERE l.organization_id=? AND l.state NOT IN ('deleted','cleanup')
        AND (?='disabled' OR l.integration_revision<>? OR NOT (
          (l.booking_kind='booking' AND EXISTS (
            SELECT 1 FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
              JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id
            WHERE b.id=l.operational_id AND b.organization_id=l.organization_id AND s.status='scheduled'
              AND ((b.status IN ('pending','confirmed') AND s.ends_at>?)
                OR (b.status='confirmed' AND s.ends_at<=? AND l.state='synced'))))
          OR (l.booking_kind='reservation' AND EXISTS (
            SELECT 1 FROM reservations b WHERE b.id=l.operational_id AND b.organization_id=l.organization_id
              AND ((b.status IN ('pending','confirmed') AND b.ends_at>?)
                OR (b.status='confirmed' AND b.ends_at<=? AND l.state='synced'))))))
      ORDER BY l.updated_at,l.id LIMIT 25)`,
  [organizationId,integration.status,integration.revision,now,now,now,now])
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
export function defaultProvider(env: CloudflareEnv): CalendarProvider {
  return { token: async accountId => (await linkedAccountAccessToken(env, accountId)).accessToken }
}
export async function syncCalendarOrganization(env: CloudflareEnv, organizationId: string, limit = 25, provider: CalendarProvider = defaultProvider(env), eventLinkId?: string, expectedEtag?: string | null) {
  const db = env.DB
  const integration = await readCalendarIntegration(db, organizationId)
  if (!integration) return { checked: 0, failed: 0 }
  await reconcileIntents(db, organizationId, integration)
  // A failure moves its link's updated_at on, so it waits behind the others rather than starving them.
  const links = await queryAll<EventLink>(db, `SELECT * FROM google_calendar_event_links WHERE organization_id = ?
    AND state IN ('pending', 'cleanup', 'error') AND (? IS NULL OR id=?) ORDER BY updated_at, id LIMIT ?`, [organizationId, eventLinkId ?? null, eventLinkId ?? null, limit])
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
      const url = subject.request_id && subject.buyer_user_id ? composeBuyerActivityUrl(env, subject.booking_kind, subject.request_id) : null
      const path = `/calendars/${encodeURIComponent(link.calendar_id)}/events`
      let existing: GoogleEvent | undefined
      try { existing = await google<GoogleEvent>(token, `${path}/${link.event_id}`) }
      catch (error) { if (!(error instanceof CalendarError) || ![404, 410].includes(error.status)) throw error }
      if (expectedEtag !== undefined && (existing?.etag ?? null) !== expectedEtag) throw new Error('The Google event changed again before reconciliation. The newer change must be reviewed before restoring the appointment.')
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
  await execute(db, "UPDATE organization_integrations SET status='disabled', updated_at=? WHERE organization_id=? AND provider='google_calendar'", [new Date().toISOString(), organizationId])
  await execute(db, "UPDATE google_calendar_event_links SET state='cleanup' WHERE organization_id=? AND state <> 'deleted'", [organizationId])
}
export async function storeCalendarSelection(db: DbClient, organizationId: string, selection: Pick<GoogleCalendarIntegration, 'account_id' | 'calendar_id' | 'calendar_name'>) {
  const pending = await queryFirst<{ n: number }>(db, "SELECT count(*) n FROM google_calendar_event_links WHERE organization_id=? AND state <> 'deleted'", [organizationId])
  const existing = await readCalendarIntegration(db, organizationId)
  if (existing && pending?.n) throw new CalendarSelectionConflict('Disconnect and finish cleanup of the previous calendar before changing the selection.')
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
  [crypto.randomUUID(),organizationId,payload.account_id,payload.calendar_id,payload.calendar_name,payload.revision,now,now,organizationId,existing?.revision??null,existing?.revision??null,payload.calendar_id])
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
    { query: "UPDATE organization_integrations SET status='disabled', updated_at=? WHERE organization_id=? AND provider='google_calendar'", params: [now, organizationId] },
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
