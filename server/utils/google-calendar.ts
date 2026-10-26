import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import type { GoogleCalendarIntegration } from '~/shared/organization-settings'
import { HTTPError } from 'nitro'
import { timingSafeEqual } from 'node:crypto'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { listSessions } from '~/server/utils/availability'
import { moveBooking } from '~/server/domain/guest-threads/booking-changes'
import { appendEntry, findEntryByDedupeKey } from '~/server/domain/guest-threads/entries'
import { updateThreadProjectionIfLatestEntry } from '~/server/domain/guest-threads/repository'
import { getGuestRequest } from '~/server/domain/requests'
import type { GuestThreadRow } from '~/server/domain/guest-threads/types'
import { notifyCalendarSyncOwner } from '~/server/utils/notifications'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { localPartsAt } from '~/utils/timezone'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'
import { execute, executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { composeOwnerThreadInboxUrl } from './dashboard-notification-links'

export interface CalendarChoice { id: string; summary: string; accessRole: string; description?: string }
export class CalendarSelectionConflict extends Error {}
export interface CalendarSubject {
  booking_kind: 'booking' | 'reservation'
  operational_id: string
  request_id: string | null
  status: string
  starts_at: string
  ends_at: string
  timezone: string
  guest_name: string | null
  /** Who delivers a booking; reservations have none. */
  member_name: string | null
  revision: string
}
interface EventLink {
  id: string; organization_id: string; integration_revision: string; account_id: string
  calendar_id: string; event_id: string; booking_kind: CalendarSubject['booking_kind']; operational_id: string
  request_id: string | null; booking_revision: string; synced_revision: string | null
  state: string; attempts: number; lease_token: string | null; updated_at: string
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
export function calendarEvent(subject: CalendarSubject, dashboardUrl: string | null) {
  if (!Number.isFinite(Date.parse(subject.starts_at)) || !Number.isFinite(Date.parse(subject.ends_at)) || subject.ends_at <= subject.starts_at) throw new Error('Invalid canonical booking interval')
  new Intl.DateTimeFormat('en', { timeZone: subject.timezone }).format()
  const noun = subject.booking_kind === 'booking' ? 'Booking' : 'Reservation'
  return {
    summary: `${subject.status === 'pending' ? 'Pending ' + noun.toLowerCase() : noun}${subject.guest_name ? ' — ' + subject.guest_name : ''}`,
    description: `Status: ${subject.status}${subject.member_name ? `\nTeam member: ${subject.member_name}` : ''}${dashboardUrl ? `\n${dashboardUrl}` : ''}`,
    start: { dateTime: subject.starts_at, timeZone: subject.timezone },
    end: { dateTime: subject.ends_at, timeZone: subject.timezone },
    visibility: 'private',
    // Stated, so that rewriting an event someone deleted in Google brings it back.
    status: 'confirmed',
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
    SELECT 'booking' booking_kind, b.id operational_id, b.request_id, b.status,
      s.starts_at, s.ends_at, s.timezone, json_extract(r.payload_json, '$.guest.name') guest_name, member.name member_name,
      json_array(b.updated_at, s.updated_at, r.updated_at, c.updated_at,
        (SELECT MAX(a.sequence) FROM activity_entries a WHERE a.request_id=b.request_id),
        b.status, s.starts_at, s.ends_at, s.timezone, json_extract(r.payload_json,'$.guest.name'), member.name) revision
    FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
      JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id
      LEFT JOIN requests r ON r.id=b.request_id AND r.organization_id=b.organization_id
      LEFT JOIN (SELECT m.id, m.organizationId, ${MEMBER_NAME_SQL} name FROM member m JOIN user u ON u.id=m.userId
        LEFT JOIN member_scheduling ms ON ms.member_id=m.id) member ON member.id=b.assigned_member_id AND member.organizationId=b.organization_id
    WHERE b.organization_id=? AND b.status IN ('pending','confirmed')
      AND s.status='scheduled' AND s.ends_at>? AND (? IS NULL OR (?='booking' AND b.id=?))
    UNION ALL
    SELECT 'reservation', b.id, b.request_id, b.status, b.starts_at, b.ends_at, b.timezone,
      json_extract(r.payload_json,'$.guest.name'), NULL,
      json_array(b.updated_at, r.updated_at,
        (SELECT MAX(a.sequence) FROM activity_entries a WHERE a.request_id=b.request_id),
        b.status, b.starts_at, b.ends_at, b.timezone, json_extract(r.payload_json,'$.guest.name'))
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
      next_attempt_at = CASE WHEN google_calendar_event_links.booking_revision <> excluded.booking_revision THEN NULL ELSE google_calendar_event_links.next_attempt_at END,
      updated_at = excluded.updated_at WHERE google_calendar_event_links.booking_revision <> excluded.booking_revision`,
    [id, organizationId, integration.revision, integration.account_id, integration.calendar_id, 'kc' + id.replaceAll('-', ''), subject.booking_kind, subject.operational_id, subject.request_id, revision, now, now, organizationId, integration.revision])
  }
  // Select only stale identities. Unchanged and historical successful events
  // receive no writes; cleanup also has a database batch limit.
  await execute(db, `UPDATE google_calendar_event_links SET state='cleanup', next_attempt_at=NULL
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
  try { await google(token, `${path}?sendUpdates=none`, { method: 'DELETE' }) }
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
async function ownsMutation(db: DbClient, link: EventLink, lease: string, revision: string) {
  return Boolean(await queryFirst<{ id: string }>(db, `SELECT id FROM google_calendar_event_links WHERE id=?
    AND lease_token=? AND lease_until>? AND booking_revision=? AND state IN ('pending','error')`,
  [link.id, lease, new Date(Date.now() + 30_000).toISOString(), revision]))
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
  const now = new Date().toISOString()
  const links = await queryAll<EventLink>(db, `SELECT * FROM google_calendar_event_links WHERE organization_id = ?
    AND state IN ('pending', 'cleanup', 'error') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    AND (lease_until IS NULL OR lease_until <= ?) ORDER BY COALESCE(next_attempt_at, created_at), updated_at, id LIMIT ?`, [organizationId, now, now, limit])
  let checked = 0; let failed = 0
  for (const link of links) {
    const lease = crypto.randomUUID()
    const claim = await execute(db, 'UPDATE google_calendar_event_links SET lease_token=?, lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?)',
      [lease, new Date(Date.now() + 120_000).toISOString(), link.id, now])
    if (claim.meta?.changes !== 1) continue
    checked++
    try {
      const token = await provider.token(link.account_id)
      const subject = await currentSubject(db, organizationId, link)
      if (!subject || link.state === 'cleanup') {
        await removeEvent(token, link)
        await execute(db, "UPDATE google_calendar_event_links SET state='deleted', last_error=NULL, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_token=?", [new Date().toISOString(), link.id, lease])
        continue
      }
      const revision = subject.revision
      if (revision !== link.booking_revision) {
        await execute(db, "UPDATE google_calendar_event_links SET state='pending', lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?", [link.id, lease])
        continue
      }
      await requireWriter(token, link.calendar_id)
      const org = await queryFirst<{ slug: string }>(db, 'SELECT slug FROM organization WHERE id=?', [organizationId])
      if (!org) throw new Error('Organization disappeared')
      const url = subject.request_id ? composeOwnerThreadInboxUrl(env, { orgSlug: org.slug, locationSlug: null }, subject.request_id) : null
      const payload = calendarEvent(subject, url)
      const path = `/calendars/${encodeURIComponent(link.calendar_id)}/events`
      if (!await ownsMutation(db, link, lease, revision)) {
        await execute(db, 'UPDATE google_calendar_event_links SET lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?', [link.id, lease])
        continue
      }
      if (!link.synced_revision) {
        try { await google(token, `${path}?sendUpdates=none`, { method: 'POST', body: JSON.stringify({ id: link.event_id, ...payload }) }) }
        catch (error) { if (!(error instanceof CalendarError) || error.status !== 409) throw error }
      }
      const beforeUpdate = await currentSubject(db, organizationId, link)
      if (!beforeUpdate) {
        await removeEvent(token, link)
        await execute(db, "UPDATE google_calendar_event_links SET state='deleted', lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?", [link.id, lease])
        continue
      }
      if (beforeUpdate.revision !== revision || !await ownsMutation(db, link, lease, revision)) {
        await execute(db, "UPDATE google_calendar_event_links SET state=CASE WHEN state='cleanup' THEN state ELSE 'pending' END, lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?", [link.id, lease])
        continue
      }
      await google(token, `${path}/${link.event_id}?sendUpdates=none`, { method: 'PUT', body: JSON.stringify(payload) })
      // Fence late provider results against committed cancellation/disconnect.
      // Compensating deletion uses the same durable identity and retains errors.
      const afterSubject = await currentSubject(db, organizationId, link)
      if (!afterSubject) {
        await removeEvent(token, link)
        await execute(db, "UPDATE google_calendar_event_links SET state='deleted', lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?", [link.id, lease])
      } else {
        await execute(db, `UPDATE google_calendar_event_links SET state=?, synced_revision=?, last_synced_at=?, last_error=NULL, attempts=0,
          lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?`,
        [afterSubject.revision === revision ? 'synced' : 'pending', revision, new Date().toISOString(), link.id, lease])
      }
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      await executeBatch(db, [
        { query: "UPDATE google_calendar_event_links SET state=CASE WHEN state='cleanup' THEN state ELSE 'error' END, last_error=?, attempts=attempts+1, next_attempt_at=?, lease_token=NULL, lease_until=NULL WHERE id=? AND lease_token=?", params: [message, new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(link.attempts, 7))).toISOString(), link.id, lease] },
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
  await execute(db, "UPDATE google_calendar_event_links SET state='cleanup', next_attempt_at=NULL WHERE organization_id=? AND state <> 'deleted'", [organizationId])
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
  id: string; organization_id: string; account_id: string; calendar_id: string; event_id: string; attempts: number
}
/** Common deletion hook: stage identities durably; no Google calls can block deletion. */
export async function stageCalendarOrganizationCleanup(db: DbClient, organizationId: string) {
  const now = new Date().toISOString()
  await executeBatch(db, [
    { query: `INSERT INTO google_calendar_cleanup_jobs
      (id, organization_id, account_id, calendar_id, event_id, next_attempt_at, created_at, updated_at)
      SELECT id, organization_id, account_id, calendar_id, event_id,
        CASE WHEN lease_until > ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', lease_until, '+30 seconds') ELSE ? END, ?, ?
      FROM google_calendar_event_links WHERE organization_id=? AND state <> 'deleted'
      ON CONFLICT(calendar_id, event_id) DO NOTHING`, params: [now, now, now, now, organizationId] },
    { query: "UPDATE organization_integrations SET status='disabled', updated_at=? WHERE organization_id=? AND provider='google_calendar'", params: [now, organizationId] },
    { query: "UPDATE google_calendar_event_links SET state='cleanup', next_attempt_at=NULL WHERE organization_id=? AND state <> 'deleted'", params: [organizationId] },
  ], { operation: 'retain Google Calendar organization cleanup identities' })
}
/** Delete-only outbox. Orphan jobs cannot enroll, recreate, update or expose a tenant. */
export async function runCalendarCleanupJobs(env: CloudflareEnv, limit = 25, provider: CalendarProvider = {
  token: async accountId => (await linkedAccountAccessToken(env, accountId)).accessToken,
}) {
  const db = env.DB
  const now = new Date().toISOString()
  const jobs = await queryAll<CleanupJob>(db, `SELECT id, organization_id, account_id, calendar_id, event_id, attempts
    FROM google_calendar_cleanup_jobs WHERE state IN ('pending','error')
    AND NOT EXISTS (SELECT 1 FROM organization WHERE organization.id=google_calendar_cleanup_jobs.organization_id)
    AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (lease_until IS NULL OR lease_until <= ?)
    ORDER BY COALESCE(next_attempt_at, created_at), id LIMIT ?`, [now, now, limit])
  let checked = 0; let failed = 0
  for (const job of jobs) {
    const lease = crypto.randomUUID()
    const claimed = await execute(db, `UPDATE google_calendar_cleanup_jobs SET lease_token=?, lease_until=?
      WHERE id=? AND state IN ('pending','error') AND (lease_until IS NULL OR lease_until <= ?)
      AND NOT EXISTS (SELECT 1 FROM organization WHERE organization.id=google_calendar_cleanup_jobs.organization_id)`,
    [lease, new Date(Date.now() + 120_000).toISOString(), job.id, now])
    if (claimed.meta?.changes !== 1) continue
    checked++
    try {
      await removeEvent(await provider.token(job.account_id), job)
      await execute(db, `UPDATE google_calendar_cleanup_jobs SET state='deleted', last_error=NULL, next_attempt_at=NULL,
        lease_token=NULL, lease_until=NULL, completed_at=?, updated_at=? WHERE id=? AND lease_token=?`,
      [new Date().toISOString(), new Date().toISOString(), job.id, lease])
    } catch (error) {
      failed++
      await execute(db, `UPDATE google_calendar_cleanup_jobs SET state='error', last_error=?, attempts=attempts+1,
        next_attempt_at=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_token=?`,
      [error instanceof Error ? error.message : String(error), new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 7))).toISOString(), new Date().toISOString(), job.id, lease])
    }
  }
  return { checked, failed }
}

/*
 * The inbound side. Google's push channel on the business calendar says
 * "look now"; its change list (`syncToken`) is the feed that is read, on a
 * notification and on the five-minute task alike, so nothing a notification
 * missed is lost. Only events KrabiClaw created are read: an event the
 * business put on the calendar itself is never touched.
 *
 * An event moved in Google moves its booking through the one booking-move
 * operation, with its availability checks and its guest email. A move the
 * booking cannot follow, and any deletion, leaves the booking as it is: the
 * event is written back, the booking's conversation needs attention on
 * Today, and the owners are told. channel_sync_log records each outcome.
 */
interface CalendarSync {
  organization_id: string; integration_revision: string; channel_id: string; channel_token: string; resource_id: string | null
  channel_expires_at: string | null; sync_token: string | null; reschedules: number; last_pulled_at: string | null; last_error: string | null
}
interface GoogleEvent { id: string; status?: string; updated?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }

export async function readCalendarSync(db: DbClient, organizationId: string) {
  const row = await queryFirst<CalendarSync>(db, 'SELECT * FROM google_calendar_sync WHERE organization_id=?', [organizationId])
  return row ? { reschedules: Boolean(row.reschedules), watch_expires_at: row.channel_expires_at, last_pulled_at: row.last_pulled_at, last_error: row.last_error } : null
}
export async function setCalendarReschedules(db: DbClient, organizationId: string, reschedules: boolean) {
  const result = await execute(db, 'UPDATE google_calendar_sync SET reschedules=?, updated_at=? WHERE organization_id=?', [reschedules ? 1 : 0, new Date().toISOString(), organizationId])
  if (result.meta?.changes !== 1) throw new HTTPError({ statusCode: 409, message: 'Connect Google Calendar before choosing how it syncs' })
}
/** The organization a notification is for: the channel it names, proven by the token Google echoes back. */
export async function resolveCalendarChannel(db: DbClient, channelId: string, token: string): Promise<string | null> {
  const row = await queryFirst<{ organization_id: string; channel_token: string }>(db, 'SELECT organization_id, channel_token FROM google_calendar_sync WHERE channel_id=?', [channelId])
  if (!row) return null
  const expected = Buffer.from(row.channel_token); const given = Buffer.from(token)
  return expected.length === given.length && timingSafeEqual(expected, given) ? row.organization_id : null
}
// Google delivers only to HTTPS with a certificate it trusts; a local Worker reads the change list on the task instead.
function watchAddress(env: CloudflareEnv): string | null {
  const domain = env.NUXT_PUBLIC_PLATFORM_DOMAIN
  return domain?.startsWith('https://') ? `${domain.replace(/\/$/, '')}/api/integrations/google-calendar/webhook` : null
}
async function stopChannel(token: string, channelId: string, resourceId: string) {
  try { await google(token, '/channels/stop', { method: 'POST', body: JSON.stringify({ id: channelId, resourceId }) }) }
  catch (error) { if (!(error instanceof CalendarError) || ![404, 410].includes(error.status)) throw error }
}
/** Google's channel on the business calendar, opened or renewed, and the change-list position taken once. */
export async function ensureCalendarWatch(env: CloudflareEnv, organizationId: string, provider: CalendarProvider = defaultProvider(env)) {
  const db = env.DB
  const integration = await readCalendarIntegration(db, organizationId)
  if (!integration || integration.status === 'disabled') return
  const existing = await queryFirst<CalendarSync>(db, 'SELECT * FROM google_calendar_sync WHERE organization_id=?', [organizationId])
  const current = existing && existing.integration_revision === integration.revision ? existing : null
  const address = watchAddress(env)
  // Google does not renew a channel; a new one is opened within a day of expiry.
  if (!current || (address && (!current.channel_expires_at || Date.parse(current.channel_expires_at) - Date.now() < 86_400_000))) {
    const token = await provider.token(integration.account_id)
    const channelId = crypto.randomUUID(); const channelToken = crypto.randomUUID()
    let resourceId: string | null = null; let expiresAt: string | null = null
    if (address) {
      const watch = await google<{ resourceId?: string; expiration?: string }>(token, `/calendars/${encodeURIComponent(integration.calendar_id)}/events/watch`,
        { method: 'POST', body: JSON.stringify({ id: channelId, type: 'web_hook', address, token: channelToken }) })
      resourceId = watch.resourceId ?? null
      expiresAt = watch.expiration ? new Date(Number(watch.expiration)).toISOString() : null
    }
    const now = new Date().toISOString()
    await execute(db, `INSERT INTO google_calendar_sync (organization_id, integration_revision, channel_id, channel_token, resource_id, channel_expires_at, sync_token, reschedules, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      ON CONFLICT(organization_id) DO UPDATE SET integration_revision=excluded.integration_revision, channel_id=excluded.channel_id, channel_token=excluded.channel_token,
        resource_id=excluded.resource_id, channel_expires_at=excluded.channel_expires_at,
        sync_token=CASE WHEN google_calendar_sync.integration_revision=excluded.integration_revision THEN google_calendar_sync.sync_token ELSE NULL END, updated_at=excluded.updated_at`,
    [organizationId, integration.revision, channelId, channelToken, resourceId, expiresAt, now, now])
    // The replaced channel would keep delivering under a token nobody holds.
    if (existing?.resource_id && address) await stopChannel(token, existing.channel_id, existing.resource_id)
  }
  const position = await queryFirst<{ sync_token: string | null }>(db, 'SELECT sync_token FROM google_calendar_sync WHERE organization_id=?', [organizationId])
  if (!position?.sync_token) await pullCalendarChanges(env, organizationId, provider)
}
export async function stopCalendarWatch(env: CloudflareEnv, organizationId: string, provider: CalendarProvider = defaultProvider(env)) {
  const db = env.DB
  const sync = await queryFirst<CalendarSync>(db, 'SELECT * FROM google_calendar_sync WHERE organization_id=?', [organizationId])
  if (!sync) return
  const integration = await readCalendarIntegration(db, organizationId)
  if (sync.resource_id && integration) await stopChannel(await provider.token(integration.account_id), sync.channel_id, sync.resource_id)
  await execute(db, 'DELETE FROM google_calendar_sync WHERE organization_id=?', [organizationId])
}
async function logInbound(db: DbClient, entry: { organizationId: string; externalId: string; status: 'applied' | 'needs_review' | 'failed'; detail?: string }) {
  await execute(db, `INSERT INTO channel_sync_log (id, organization_id, product_id, provider, direction, kind, external_id, status, detail)
    VALUES (?, ?, NULL, 'google_calendar', 'inbound', 'calendar_event', ?, ?, ?)`, [crypto.randomUUID(), entry.organizationId, entry.externalId, entry.status, entry.detail ?? null])
}
/** Read the change list from where it was last read, apply what touches a managed event, and keep the new position. */
export async function pullCalendarChanges(env: CloudflareEnv, organizationId: string, provider: CalendarProvider = defaultProvider(env)): Promise<{ events: number; applied: number; reviewed: number }> {
  const db = env.DB
  const outcome = { events: 0, applied: 0, reviewed: 0 }
  const integration = await readCalendarIntegration(db, organizationId)
  const sync = await queryFirst<CalendarSync>(db, 'SELECT * FROM google_calendar_sync WHERE organization_id=?', [organizationId])
  if (!integration || integration.status === 'disabled' || !sync || sync.integration_revision !== integration.revision) return outcome
  if (!await hasOrganizationEntitlement(env, organizationId, 'calendar_sync')) return outcome
  try {
    const token = await provider.token(integration.account_id)
    const path = `/calendars/${encodeURIComponent(integration.calendar_id)}/events`
    let syncToken = sync.sync_token
    let pageToken: string | undefined
    let nextSyncToken: string | undefined
    const events: GoogleEvent[] = []
    for (;;) {
      // Every call carries the same parameters: Google's rule for a position to stay valid.
      const params = new URLSearchParams({ maxResults: '250', showDeleted: 'true', singleEvents: 'true' })
      if (syncToken) params.set('syncToken', syncToken)
      if (pageToken) params.set('pageToken', pageToken)
      let page: { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }
      try { page = await google(token, `${path}?${params}`) }
      catch (error) {
        // Google forgot this position: the whole calendar is read again, and the new position kept.
        if (error instanceof CalendarError && error.status === 410 && syncToken) { syncToken = null; pageToken = undefined; events.length = 0; continue }
        throw error
      }
      events.push(...(page.items ?? []))
      if (page.nextPageToken) { pageToken = page.nextPageToken; continue }
      nextSyncToken = page.nextSyncToken
      break
    }
    if (!nextSyncToken) throw new Error('Google returned no position for the calendar change list')
    for (const item of events) {
      outcome.events++
      const result = await applyCalendarEvent(env, organizationId, integration, sync, item)
      if (result === 'applied') outcome.applied++
      else if (result === 'needs_review') outcome.reviewed++
    }
    const now = new Date().toISOString()
    await execute(db, 'UPDATE google_calendar_sync SET sync_token=?, last_pulled_at=?, last_error=NULL, updated_at=? WHERE organization_id=? AND integration_revision=?', [nextSyncToken, now, now, organizationId, integration.revision])
    return outcome
  } catch (error) {
    await execute(db, 'UPDATE google_calendar_sync SET last_error=?, updated_at=? WHERE organization_id=?', [describeErrorForTelemetry(error), new Date().toISOString(), organizationId])
    throw error
  }
}
/** The destination a Google event's new interval names: the same product's session that starts then, or the reservation's new date and time. */
async function moveFieldsFor(db: DbClient, organizationId: string, subject: CalendarSubject, startsAt: string, endsAt: string) {
  const record = await queryFirst<{ party_size: number; product_id: string | null; location_id: string | null; timezone: string }>(db, subject.booking_kind === 'booking'
    ? 'SELECT b.party_size, b.product_id, s.location_id, s.timezone FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id WHERE b.id=? AND b.organization_id=?'
    : 'SELECT party_size, NULL AS product_id, location_id, timezone FROM reservations WHERE id=? AND organization_id=?', [subject.operational_id, organizationId])
  if (!record) throw new HTTPError({ statusCode: 409, message: 'The booking behind this event is gone' })
  const when = new Intl.DateTimeFormat('en-US', { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(startsAt))
  if (subject.booking_kind === 'booking') {
    const sessions = await listSessions(db, { organizationId, productId: record.product_id!, fromInstant: new Date(Date.parse(startsAt) - 60_000).toISOString(), toInstant: new Date(Date.parse(startsAt) + 60_000).toISOString() })
    const exact = sessions.filter(session => Date.parse(session.starts_at) === Date.parse(startsAt))
    const target = exact.find(session => session.location_id === record.location_id) ?? exact[0]
    if (!target) throw new HTTPError({ statusCode: 409, message: `Nothing can be booked at ${when}; the website offers the times that can` })
    if (Date.parse(target.ends_at) !== Date.parse(endsAt)) throw new HTTPError({ statusCode: 409, message: 'Only the start can move; the booking keeps its length' })
    return { kind: 'booking' as const, sessionId: target.id, partySize: record.party_size }
  }
  if (!record.location_id) throw new HTTPError({ statusCode: 409, message: 'The reservation has no location to move within' })
  const parts = localPartsAt(new Date(startsAt), record.timezone)
  const pad = (value: number) => String(value).padStart(2, '0')
  return { kind: 'reservation' as const, locationId: record.location_id, bookingDate: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, bookingTime: `${pad(parts.hour)}:${pad(parts.minute)}`, partySize: record.party_size }
}
/** The booking won over its event: its conversation needs attention on Today, and the owners are told once per Google change. */
async function flagForReview(env: CloudflareEnv, organizationId: string, link: EventLink, subject: CalendarSubject, kind: 'event_deleted' | 'move_refused', reason: string | null, change: string) {
  const db = env.DB
  if (!subject.request_id) return
  const dedupeKey = `calendar-sync:${change}`
  if (await findEntryByDedupeKey(db, dedupeKey)) return
  const organization = await queryFirst<{ name: string | null; vertical: string | null }>(db, 'SELECT name, vertical FROM organization WHERE id=?', [organizationId])
  const noun = resolveBookingPresentation(subject.booking_kind, organization?.vertical).noun
  const whenLabel = new Intl.DateTimeFormat('en-US', { timeZone: subject.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(subject.starts_at))
  const entry = await appendEntry(db, { threadId: subject.request_id, kind: 'operation', actorKind: 'system', eventName: `calendar_sync.${kind}`, dedupeKey,
    body: kind === 'event_deleted'
      ? `The ${noun}'s event was deleted in Google Calendar. The ${noun} is still booked for ${whenLabel}, and the event has been put back.`
      : `The ${noun}'s event was moved in Google Calendar, but the ${noun} could not follow${reason ? `: ${reason}` : ''}. It stays at ${whenLabel}, and the event has been moved back.`,
    payloadJson: { kind, reason, event_id: link.event_id, operational_booking_id: subject.operational_id } })
  await updateThreadProjectionIfLatestEntry(db, subject.request_id, entry.id, { conversationState: 'needs_attention' })
  const request = await queryFirst<{ location_id: string | null }>(db, 'SELECT location_id FROM requests WHERE id=?', [subject.request_id])
  await notifyCalendarSyncOwner(env, db, { organizationId, organizationName: organization?.name, kind, threadId: subject.request_id, submissionType: subject.booking_kind, sourceEntryId: entry.id,
    locationId: request?.location_id ?? null, guestName: subject.guest_name ?? 'The guest', noun, whenLabel, reason })
}
type InboundOutcome = 'unmanaged' | 'unchanged' | 'applied' | 'needs_review'
async function applyCalendarEvent(env: CloudflareEnv, organizationId: string, integration: GoogleCalendarIntegration, sync: CalendarSync, item: GoogleEvent): Promise<InboundOutcome> {
  const db = env.DB
  const link = await queryFirst<EventLink>(db, "SELECT * FROM google_calendar_event_links WHERE calendar_id=? AND event_id=? AND state<>'deleted'", [integration.calendar_id, item.id])
  if (!link || link.integration_revision !== integration.revision) return 'unmanaged'
  // Not yet written to Google, or its booking is gone or over: the outbound pass owns both.
  if (!link.synced_revision) return 'unchanged'
  const subject = (await calendarSubjects(db, organizationId, integration, link))[0] ?? null
  if (!subject) return 'unchanged'
  const deleted = item.status === 'cancelled'
  const start = item.start?.dateTime ? Date.parse(item.start.dateTime) : Number.NaN
  const end = item.end?.dateTime ? Date.parse(item.end.dateTime) : Number.NaN
  if (!deleted && start === Date.parse(subject.starts_at) && end === Date.parse(subject.ends_at)) return 'unchanged'
  // The booking decides what the event says; writing it back is the outbound pass's job, asked for here.
  const restore = () => execute(db, "UPDATE google_calendar_event_links SET state='pending', synced_revision=NULL, next_attempt_at=NULL, updated_at=? WHERE id=? AND state<>'deleted'", [new Date().toISOString(), link.id])
  const change = `${item.id}:${item.updated ?? new Date().toISOString()}`
  if (deleted) {
    await restore()
    await flagForReview(env, organizationId, link, subject, 'event_deleted', null, `deleted:${change}`)
    await logInbound(db, { organizationId, externalId: item.id, status: 'needs_review', detail: 'deleted in Google Calendar; the booking is kept and the event put back' })
    return 'needs_review'
  }
  if (!sync.reschedules) {
    await restore()
    await logInbound(db, { organizationId, externalId: item.id, status: 'applied', detail: 'moved in Google Calendar; reschedules are off, so the event is put back' })
    return 'applied'
  }
  const thread = subject.request_id ? await getGuestRequest(db, subject.request_id, organizationId) : null
  try {
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new HTTPError({ statusCode: 409, message: 'The event lost its start or end time' })
    if (!thread) throw new HTTPError({ statusCode: 409, message: 'The booking has no guest conversation to move it through' })
    const fields = await moveFieldsFor(db, organizationId, subject, new Date(start).toISOString(), new Date(end).toISOString())
    await moveBooking(db, env, thread as GuestThreadRow, { source: 'google_calendar' }, fields, `google-calendar:${change}`)
    await logInbound(db, { organizationId, externalId: item.id, status: 'applied', detail: `moved to ${new Date(start).toISOString()}` })
    return 'applied'
  } catch (error) {
    // A refusal names its reason; a provider, configuration or database failure is not one and stops the pull.
    if (!(error instanceof HTTPError) || ![400, 409].includes(error.status)) throw error
    const reason = error.message || 'The booking could not be moved'
    await restore()
    await flagForReview(env, organizationId, link, subject, 'move_refused', reason, `refused:${change}`)
    await logInbound(db, { organizationId, externalId: item.id, status: 'needs_review', detail: reason })
    return 'needs_review'
  }
}
