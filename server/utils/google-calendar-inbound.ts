import { timingSafeEqual } from 'node:crypto'
import { HTTPError } from 'nitro'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { readLinkedAccount, type CloudflareEnv } from '~/server/utils/auth'
import type { GoogleCalendarIntegration } from '~/shared/organization-settings'
import { CalendarError, calendarEvent, calendarSubjects, defaultProvider, google, readCalendarIntegration, syncCalendarOrganization, type GoogleEvent, type CalendarProvider, type CalendarSubject, type EventLink } from './google-calendar'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { listSessions } from '~/server/utils/availability'
import { bookingChangeViews, requestBookingChange } from '~/server/domain/guest-threads/booking-changes'
import { appendEntry, findEntryByDedupeKey } from '~/server/domain/guest-threads/entries'
import { updateThreadProjectionIfLatestEntry } from '~/server/domain/guest-threads/repository'
import { getGuestRequest } from '~/server/domain/requests'
import type { GuestThreadEntryRow, GuestThreadRow } from '~/server/domain/guest-threads/types'
import { notifyCalendarSyncOwner } from '~/server/utils/notifications'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { localPartsAt } from '~/utils/timezone'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'

/*
 * The inbound side. Google's push channel on the business calendar says
 * "look now"; its change list (`syncToken`) is the feed that is read, on a
 * notification and on the five-minute task alike, so nothing a notification
 * missed is lost. Only events KrabiClaw created are read: an event the
 * business put on the calendar itself is never touched.
 *
 * A time or exact attorney replacement on the managed calendar proposes the
 * canonical booking change in its client conversation. The committed booking
 * and Google event keep the original appointment until the client accepts.
 * Google exposes no last editor: creator/organizer and RSVP are never used as
 * editor identity, assignment, or consent. channel_sync_log records outcomes.
 */
interface CalendarSync {
  organization_id: string; integration_revision: string; channel_id: string; channel_token: string; resource_id: string | null
  channel_expires_at: string | null; sync_token: string | null; reschedules: number; last_pulled_at: string | null; last_error: string | null
}

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
/**
 * Forget the channel first: a notification for it is then ignored whatever
 * Google does next. Telling Google to stop can fail when the grant is gone;
 * that is reported, and the channel expires on its own within a week.
 */
export async function stopCalendarWatch(env: CloudflareEnv, organizationId: string, provider: CalendarProvider = defaultProvider(env)) {
  const db = env.DB
  const sync = await queryFirst<CalendarSync>(db, 'SELECT * FROM google_calendar_sync WHERE organization_id=?', [organizationId])
  if (!sync) return
  const integration = await readCalendarIntegration(db, organizationId)
  await execute(db, 'DELETE FROM google_calendar_sync WHERE organization_id=?', [organizationId])
  if (!sync.resource_id || !integration) return
  try { await stopChannel(await provider.token(integration.account_id), sync.channel_id, sync.resource_id) }
  catch (error) { throw new Error(`Google Calendar is disconnected, but Google could not be told to stop its notifications; they stop by themselves within a week. ${describeErrorForTelemetry(error)}`, { cause: error }) }
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
      const result = await applyCalendarEvent(env, organizationId, integration, sync, item, token, provider)
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
async function moveFieldsFor(db: DbClient, organizationId: string, subject: CalendarSubject, startsAt: string, endsAt: string, assignedMemberId: string | null) {
  const record = await queryFirst<{ party_size: number; product_id: string | null; location_id: string | null; timezone: string; assigned_member_id: string | null }>(db, subject.booking_kind === 'booking'
    ? 'SELECT b.party_size, b.product_id, s.location_id, s.timezone, b.assigned_member_id FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id WHERE b.id=? AND b.organization_id=?'
    : 'SELECT party_size, NULL AS product_id, location_id, timezone, NULL AS assigned_member_id FROM reservations WHERE id=? AND organization_id=?', [subject.operational_id, organizationId])
  if (!record) throw new HTTPError({ statusCode: 409, message: 'The booking behind this event is gone' })
  const when = new Intl.DateTimeFormat('en-US', { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(startsAt))
  if (subject.booking_kind === 'booking') {
    const sessions = await listSessions(db, { organizationId, productId: record.product_id!, fromInstant: new Date(Date.parse(startsAt) - 60_000).toISOString(), toInstant: new Date(Date.parse(startsAt) + 60_000).toISOString() })
    const exact = sessions.filter(session => Date.parse(session.starts_at) === Date.parse(startsAt) && session.assigned_member_id === assignedMemberId && session.location_id === record.location_id)
    if (exact.length > 1) throw new HTTPError({ statusCode: 409, message: 'More than one consultation matches this change. Choose the exact consultation in KrabiClaw.' })
    const target = exact[0]
    if (!target) throw new HTTPError({ statusCode: 409, message: `Nothing can be booked at ${when}${assignedMemberId ? ' with the selected attorney' : ''}; the website offers the times that can` })
    if (Date.parse(target.ends_at) !== Date.parse(endsAt)) throw new HTTPError({ statusCode: 409, message: 'Only the start can move; the booking keeps its length' })
    return { kind: 'booking' as const, sessionId: target.id, partySize: record.party_size, ...(assignedMemberId ? { assignedMemberId } : {}) }
  }
  if (!record.location_id) throw new HTTPError({ statusCode: 409, message: 'The reservation has no location to move within' })
  const parts = localPartsAt(new Date(startsAt), record.timezone)
  const pad = (value: number) => String(value).padStart(2, '0')
  return { kind: 'reservation' as const, locationId: record.location_id, bookingDate: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, bookingTime: `${pad(parts.hour)}:${pad(parts.minute)}`, partySize: record.party_size }
}
/** Only replacing the assigned attorney while retaining the client names an assignment. */
async function attendeeAssignment(db: DbClient, organizationId: string, subject: CalendarSubject, item: GoogleEvent): Promise<{ memberId: string | null; changed: boolean }> {
  if (!subject.is_consultation || !subject.request_id) return { memberId: subject.assigned_member_id, changed: false }
  if (item.guestsCanModify || item.guestsCanInviteOthers || item.guestsCanSeeOtherGuests) throw new HTTPError({ statusCode: 409, message: 'The managed consultation must keep guest editing, guest invitations and guest-list visibility off. Guest-enabled edits cannot be treated as staff-originated changes.' })
  if (item.attendeesOmitted) throw new HTTPError({ statusCode: 409, message: 'Google omitted attendees; no attorney change can be determined from an incomplete event.' })
  if (item.attendees?.some(attendee => attendee.resource || attendee.additionalGuests || attendee.optional)) throw new HTTPError({ statusCode: 409, message: 'Consultation invitations require the client and assigned attorney, without resources, optional or additional guests.' })
  if (!subject.guest_email || !subject.member_email || !subject.assigned_member_id) throw new HTTPError({ statusCode: 409, message: 'The consultation is missing its client or verified assigned attorney email.' })
  const client = subject.guest_email.toLowerCase(); const attorney = subject.member_email.toLowerCase()
  const emails = [...new Set((item.attendees ?? []).map(attendee => attendee.email?.toLowerCase()))]
  const expected = [...new Set([client, attorney])]
  if (emails.length === expected.length && expected.every(email => emails.includes(email))) return { memberId: subject.assigned_member_id, changed: false }
  if (client === attorney || emails.length !== 2 || !emails.includes(client) || emails.includes(attorney) || emails.includes(undefined)) throw new HTTPError({ statusCode: 409, message: 'Calendar attendees must remain the client and one assigned attorney. Additions, removals and RSVP changes do not reassign a consultation.' })
  const replacement = emails.find(email => email !== client)!
  const members = await queryAll<{ id: string }>(db, 'SELECT m.id FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND lower(u.email)=? AND u.emailVerified=1', [organizationId, replacement])
  if (members.length !== 1) throw new HTTPError({ statusCode: 409, message: 'The replacement attendee is not one verified attorney identity in this business. Choose an available attorney in KrabiClaw.' })
  return { memberId: members[0]!.id, changed: true }
}
/** The booking won over its event: its conversation needs attention on Today, and the owners are told once per Google change. */
async function flagForReview(env: CloudflareEnv, organizationId: string, link: EventLink, subject: CalendarSubject, kind: 'event_deleted' | 'move_refused', reason: string | null, change: string) {
  const db = env.DB
  if (!subject.request_id) return
  const dedupeKey = `calendar-sync:${change}`
  const existing = await findEntryByDedupeKey(db, dedupeKey)
  const organization = await queryFirst<{ name: string | null; vertical: string | null }>(db, 'SELECT name, vertical FROM organization WHERE id=?', [organizationId])
  const noun = resolveBookingPresentation(subject.booking_kind, organization?.vertical).noun
  const whenLabel = new Intl.DateTimeFormat('en-US', { timeZone: subject.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(subject.starts_at))
  const entry = existing ?? await appendEntry(db, { threadId: subject.request_id, kind: 'operation', actorKind: 'system', eventName: `calendar_sync.${kind}`, dedupeKey,
    body: kind === 'event_deleted'
      ? `The ${noun}'s event was deleted in Google Calendar. The ${noun} is still booked for ${whenLabel}, and the event has been put back.`
      : `The ${noun}'s event was moved in Google Calendar, but the ${noun} could not follow${reason ? `: ${reason}` : ''}. It stays at ${whenLabel}, and the event has been moved back.`,
    payloadJson: { kind, reason, event_id: link.event_id, operational_booking_id: subject.operational_id } })
  if (!existing) await updateThreadProjectionIfLatestEntry(db, subject.request_id, entry.id, { conversationState: 'needs_attention' })
  const request = await queryFirst<{ location_id: string | null }>(db, 'SELECT location_id FROM requests WHERE id=?', [subject.request_id])
  await notifyCalendarSyncOwner(env, db, { organizationId, organizationName: organization?.name, kind, threadId: subject.request_id, submissionType: subject.booking_kind, sourceEntryId: entry.id,
    locationId: request?.location_id ?? null, guestName: subject.guest_name ?? 'The guest', noun, whenLabel, reason })
}
type InboundOutcome = 'unmanaged' | 'unchanged' | 'applied' | 'needs_review'
async function applyCalendarEvent(env: CloudflareEnv, organizationId: string, integration: GoogleCalendarIntegration, sync: CalendarSync, item: GoogleEvent, token: string, provider: CalendarProvider): Promise<InboundOutcome> {
  const db = env.DB
  const link = await queryFirst<EventLink>(db, "SELECT * FROM google_calendar_event_links WHERE organization_id=? AND calendar_id=? AND event_id=? AND state<>'deleted'", [organizationId, integration.calendar_id, item.id])
  if (!link || link.integration_revision !== integration.revision) return 'unmanaged'
  // Not yet written to Google, or its booking is gone or over: the outbound pass owns both.
  if (!link.synced_revision) return 'unchanged'
  const subject = (await calendarSubjects(db, organizationId, integration, link))[0] ?? null
  if (!subject) return 'unchanged'
  // The list may be behind another edit. Act on the complete current event and
  // reconcile only the same ETag; a newer edit must return through this feed.
  let expectedEtag: string | null | undefined
  try {
    item = await google<GoogleEvent>(token, `/calendars/${encodeURIComponent(integration.calendar_id)}/events/${encodeURIComponent(item.id)}`)
    expectedEtag = item.etag
  } catch (error) {
    if (item.status !== 'cancelled' || !(error instanceof CalendarError) || ![404, 410].includes(error.status)) throw error
    expectedEtag = null
  }
  const deleted = item.status === 'cancelled'
  const start = item.start?.dateTime ? Date.parse(item.start.dateTime) : Number.NaN
  const end = item.end?.dateTime ? Date.parse(item.end.dateTime) : Number.NaN
  // The event is behind a booking that already changed: what the feed shows is the old
  // event, not a move. The outbound pass owns it until it has written the booking back.
  if (!deleted && (subject.revision !== link.booking_revision || link.booking_revision !== link.synced_revision)) return 'unchanged'
  // The booking decides what the event says; writing it back is the outbound pass's job, asked for here.
  const restore = () => execute(db, "UPDATE google_calendar_event_links SET state='pending', next_attempt_at=NULL, updated_at=? WHERE id=? AND state<>'deleted'", [new Date().toISOString(), link.id])
  const change = `${item.id}:${item.etag ?? item.updated ?? 'deleted'}`
  const thread = subject.request_id ? await getGuestRequest(db, subject.request_id, organizationId) : null
  let restoring = false
  const recordChange = async (): Promise<InboundOutcome> => {
    if (deleted) {
      restoring = true
      await restore()
      await flagForReview(env, organizationId, link, subject, 'event_deleted', null, `deleted:${change}`)
      await logInbound(db, { organizationId, externalId: item.id, status: 'needs_review', detail: 'deleted in Google Calendar; the booking is kept and the event put back' })
      return 'needs_review'
    }
    try {
      const assignment = await attendeeAssignment(db, organizationId, subject, item)
      if (start === Date.parse(subject.starts_at) && end === Date.parse(subject.ends_at) && !assignment.changed) {
        if (link.state === 'error' || item.status !== calendarEvent(subject, null).status) { restoring = true; await restore() }
        // Google's sync feed returns current resources, not edit history. The
        // restoration has a new ETag, so a failed client delivery resumes from
        // the latest canonical proposal, never from that new provider revision.
        if (thread) {
          const latest = await queryFirst<GuestThreadEntryRow>(db, "SELECT * FROM activity_entries WHERE request_id=? AND event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1", [thread.id])
          const prefix = `booking-change-request:${thread.id}:`
          if (latest?.dedupe_key?.startsWith(`${prefix}google-calendar:${link.event_id}:`) && (await bookingChangeViews(db, thread as GuestThreadRow, [latest])).get(latest.id)?.status === 'pending') {
            const account = await readLinkedAccount(env, integration.account_id)
            if (!account || account.providerId !== 'google') throw new HTTPError({ statusCode: 409, message: 'The Calendar integration account is no longer linked.' })
            const recorded = JSON.parse(latest.payload_json!) as { after: Record<string, unknown>; updatedAt: string }
            await requestBookingChange(db, env, thread as GuestThreadRow, { source: 'google_calendar', userId: account.userId }, { ...recorded.after, expectedUpdatedAt: recorded.updatedAt }, latest.dedupe_key.slice(prefix.length))
          }
        }
        return 'unchanged'
      }
      restoring = true
      await restore()
      if (!sync.reschedules) {
        await logInbound(db, { organizationId, externalId: item.id, status: 'applied', detail: 'changed in Google Calendar; change requests are off, so the event is put back' })
        return 'applied'
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new HTTPError({ statusCode: 409, message: 'The event lost its start or end time' })
      if (!thread) throw new HTTPError({ statusCode: 409, message: 'The booking has no guest conversation to move it through' })
      if (!item.etag || !item.updated) throw new HTTPError({ statusCode: 409, message: 'Google returned no event revision; the change cannot be proposed safely.' })
      const fields = await moveFieldsFor(db, organizationId, subject, new Date(start).toISOString(), new Date(end).toISOString(), assignment.memberId)
      const account = await readLinkedAccount(env, integration.account_id)
      if (!account || account.providerId !== 'google') throw new HTTPError({ statusCode: 409, message: 'The Calendar integration account is no longer linked.' })
      const connection = await readCalendarIntegration(db, organizationId)
      if (connection?.revision !== integration.revision || connection.status === 'disabled') throw new HTTPError({ statusCode: 409, message: 'The Calendar connection changed before this request could be proposed.' })
      const idempotencyKey = `google-calendar:${change}`
      const previous = await findEntryByDedupeKey(db, `booking-change-request:${thread.id}:${idempotencyKey}`)
      const expectedUpdatedAt = previous ? JSON.parse(previous.payload_json!).updatedAt as string : thread.updated_at
      await requestBookingChange(db, env, thread as GuestThreadRow, { source: 'google_calendar', userId: account.userId }, { ...fields, expectedUpdatedAt }, idempotencyKey)
      await logInbound(db, { organizationId, externalId: item.id, status: 'applied', detail: `client approval requested for ${new Date(start).toISOString()}${assignment.changed ? ' and an attorney replacement' : ''}; the original appointment is retained` })
      return 'applied'
    } catch (error) {
      // A refusal names its reason; a provider, configuration or database failure is not one and stops the pull.
      if (!(error instanceof HTTPError) || ![400, 403, 409, 410].includes(error.status)) throw error
      const reason = error.message || 'The booking could not be moved'
      restoring = true
      await restore()
      await flagForReview(env, organizationId, link, subject, 'move_refused', reason, `refused:${change}`)
      await logInbound(db, { organizationId, externalId: item.id, status: 'needs_review', detail: reason })
      return 'needs_review'
    }
  }
  let failure: { reason: unknown } | undefined
  let outcome: InboundOutcome | undefined
  try { outcome = await recordChange() }
  catch (error) { failure = { reason: error } }
  if (restoring) {
    const result = await syncCalendarOrganization(env, organizationId, 1, provider, link.id, expectedEtag)
    if (result.failed) throw new Error('The Google event could not be restored to the committed appointment; inspect the Calendar integration error.', { cause: failure?.reason })
  }
  if (failure) throw failure.reason
  if (!outcome) throw new Error('Calendar change processing returned no outcome.')
  return outcome
}
