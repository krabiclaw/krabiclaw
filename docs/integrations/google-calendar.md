# Google Calendar sync

Google Calendar sync is a Business plan feature (`calendar_sync` in
`server/utils/billing-entitlements.ts`). KrabiClaw owns scheduling and capacity.
Connect Google Calendar to create or reuse one **KrabiClaw** calendar for the
business. All upcoming pending and confirmed Bookings and Reservations are
included automatically. Calendar-group allocation rules govern booking
availability, not which bookings appear in Google. Cancelled records and
payment holds are excluded.

The sync runs both ways. A time or supported assigned-attorney change in Google
requests client approval through `requestBookingChange` in
`server/domain/guest-threads/booking-changes.ts`, shared with dashboard and
ChatGPT consultation changes. The conversation shows the before/after details
and Accept/Decline actions, and the canonical delivery path emails a signed
review link. The appointment stays unchanged until the client accepts. An event deleted
in Google never cancels or refunds a booking: the event is written back, the
booking's conversation needs attention on Today and the owners are emailed.
See [Inbound sync](#inbound-sync).

Personal conflict checking is separate: each member connects their own Google
account and turns **Check my calendar for conflicts** on under **Google
Calendar sync** in My account to check their primary calendar. Turning it on
needs the Business plan; turning it off never does, and retains the linked
account. A selection kept after the plan lapses fails closed and says so in
booking details rather than treating unknown time as free. The CMS shows no
calendar picker, group picker, or reservation opt-in.

## Committed lifecycle contract

Payments, MCP and dashboard operations commit the canonical Booking/Reservation
and activity through the foundation. The projection worker reads those committed
rows and canonical Session instants/timezone and participant identities.
It never calls MCP and never participates in a guest booking transaction. A
provider failure cannot roll back a booking or alter the guest response.
The scheduled task runs on the existing five-minute cron; the contextual **Retry** action also reconciles immediately. SQL selects at most 25 missing or changed
subjects per invocation. Unchanged subjects receive no intent writes. Cleanup
selects at most 25 stale identities at the database boundary, and each lifecycle
fence reads only its operational identity. Later passes resume through the
persisted intent rows without an in-memory cursor.

`google_calendar_event_links` is the durable projection intent and provider
mapping. Its subject is `(organization_id, integration_revision, booking_kind,
operational_id)`; `operational_id` means `bookings.id` or `reservations.id`.
A partial unique index permits one live intent per subject while retaining
deleted provider identities as history. `request_id` is the thread identity, never the operational Booking ID (including
legacy public responses named `booking_id`). Foundation reschedules keep the
operational ID and therefore update the same mapped Google event.

The worker preallocates a Google-compatible event ID before provider I/O. A
create that times out after Google commits retries the same ID; a conflict
reads that identity before deciding whether an update is necessary. The source
revision covers canonical status, interval, timezone, names, assignment,
participant emails, request identity and current buyer ownership eligibility.
Existing mapped events therefore gain or lose their management link when
those canonical facts change. Conversation messages and pending proposals do not send
redundant calendar invitations. Leases fence concurrent
processors, and each attempt re-reads current booking/integration state. A late
result after cancellation/disconnect is compensated by deleting that exact
managed identity; if compensation fails, the persisted intent is retried. A
process killed between the provider write and local receipt is also reconciled
from the same durable mapping. Cross-provider atomicity is impossible: a late
in-flight event can be briefly visible until compensation/retry completes.

## Inbound sync

Modelled on the Channex booking feed: a change arrives, its current state is
read, it is applied through the canonical domain operation, and every outcome
is recorded in `channel_sync_log` (`provider='google_calendar'`,
`kind='calendar_event'`, `external_id` = the Google event id).

- **Feed.** Google's change list (`events.list` with `syncToken`,
  `showDeleted=true`) is the feed. `google_calendar_sync` holds one row per
  connection revision: the push channel and the position in the list. The
  position is read on every push notification and on the five-minute
  `google-calendar-sync` task alike, so a notification that never arrived
  loses nothing. A `410 Gone` position reads the whole calendar again and
  keeps the new position.
- **Push.** `events.watch` on the KrabiClaw calendar, under the already
  verified `calendar.app.created` scope (Google's reference lists it for both
  `events.watch` and `events.list`), delivers to
  `/api/integrations/google-calendar/webhook`. A notification carries no event
  data; it names its channel and echoes the random token stored with it, which
  the route checks before reading the feed. Channels are renewed by the task
  within a day of expiry; the replaced channel is stopped. Google delivers only
  to HTTPS, so a local Worker runs on the task alone.
- **Only managed events.** An item is matched to `google_calendar_event_links`
  by organization, calendar and event id; anything else on the calendar is the business's
  own and is never read. An item is compared with the canonical booking's
  instants; an unchanged one does nothing.
- **Change requests.** With **Reschedules** on (the default), a moved event's new start
  names the same product's session that starts then (sessions are
  materialized for provider-held consultations, so every bookable time is
  one), or a reservation's new date and time in its own timezone. Its current
  location is retained; ambiguous destinations are refused. The canonical
  proposal operation validates availability and the connected account owner's
  Better Auth membership/access, records a system-originated proposal, and
  notifies the client. Google does not expose the last editor: neither the
  organizer nor the creator is treated as that person. A move the booking cannot
  follow — no session starts then, the session is full, the time is outside
  working hours, a paid reservation outside its policy — is refused: the
  event is written back, the conversation gets a
  `calendar_sync.move_refused` entry and needs attention, and the owners are
  emailed the reason. With Reschedules off, the event is written back and the
  row is logged `applied`.
- **Assigned attorney.** The consultation model assigns one canonical Better
  Auth member per booking. Replacing exactly that attorney's email in Google
  while retaining the client can propose a replacement, including at the same
  time. The new email must identify exactly one verified member of this
  business and an available session for that attorney, same practice area,
  time and location. Additional attendees, removals, external members, calendar
  organizer changes and RSVP changes never become staff assignment or client
  consent. RSVP-only edits are left alone; unsupported attendee edits are
  reported and the canonical participants restored. Changes from an event with
  guest editing/invitations or guest-list visibility enabled are refused and
  those permissions restored; the API cannot identify its last editor safely.
- **Deletions.** A cancelled event is never a cancellation. The event is
  written back from the committed status, the
  conversation gets a `calendar_sync.event_deleted` entry and needs attention,
  and the owners are emailed that the booking is still booked and how to
  cancel it properly. One Google change raises one entry and one email: the
  dedupe key includes the event id and Google's revision.
- **Writing back.** Inbound durably requests restoration before delivering a
  proposal and invokes the existing outbound operation for that event, even if
  proposal delivery fails. The Google event shows the committed time and
  attorney while pending or declined. Only accepting the proposal changes the
  booking and subsequent projection. Expired, stale, superseded and unavailable
  proposals cannot change the booking. Current events are read before update;
  `If-Match` protects Google's ETag. A newer concurrent edit leaves a visible
  integration error and returns through the feed instead of being overwritten.
  The scheduled task reads inbound changes before outbound reconciliation.
  Staff can send Google's own update emails while editing in Google, before a
  webhook reaches KrabiClaw. Google provides no appointment-consent interceptor.
  Reconciliation sends the corrective committed appointment to participants;
  a Google email or RSVP never changes the canonical booking or accepts the
  proposal. Cross-provider visibility and notification timing are not atomic.

## Settings and cleanup

### Public scope qualification

On 2026-10-04 the owner's Google Cloud project `kikuzuki-business-api`
(number `799728932262`, display name **krabiclaw**) listed an unused, unverified
sensitive `calendar.events` scope. The implementation never requests it. It was
removed and the implemented `calendar.app.created` scope added. The Console
classifies all three implemented Calendar scopes as non-sensitive. Verification
Center now reports **Your branding has been verified** and **Your app's data
access has been verified**. The existing verified `analytics.readonly` grant
was preserved. No new scope-verification video is required for this scope set.

Google requires the narrowest permissions needed by the features:
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

| Calendar scope | Implemented access |
| --- | --- |
| `calendar.app.created` | Create the business's secondary calendar and project, update or remove its managed booking events. No event access to unrelated calendars is requested. |
| `calendar.calendarlist.readonly` | Identify the primary personal calendar, verify business-calendar writer access and recover the exact marked calendar after an uncertain creation. Google does not permit Calendar List enumeration with `calendar.app.created` alone. |
| `calendar.events.freebusy` | Read busy intervals from the primary calendar in the CMS or explicitly selected accessible calendars through MCP. No event names, descriptions or content are returned. |

The dashboard requests personal free/busy consent separately from business output.
MCP supports explicit busy-calendar selection on an already-linked account,
including calendars the user can access. `calendar.freebusy` describes the user's
own calendar availability, while `calendar.events.freebusy` covers accessible
calendars; the latter matches that supported selection contract. Neither personal
event content nor unrelated event writes are part of this integration.

Better Auth owns account identity, encrypted credentials, refresh and incremental
consent through the existing `useIntegrationConnection` / `linkedAccountAccessToken`
boundary. `organization_integrations` holds only account/calendar identity,
revision/status and a readable failure. The Google account and Analytics/Search
Console grants are retained on Calendar disconnect.

Connection creates a secondary calendar through Google’s `calendars.insert` with
`calendar.app.created`, retaining Calendar List read access for identity recovery
and permission checks. A durable `google_calendar_setup` attempt prevents a second
create after an ambiguous response. Retry discovers the exact business marker,
including hidden calendars; it never guesses from the calendar name. An uncertain
creation attempt does not expire automatically: Google provides no idempotency
key or documented list-propagation deadline that would make another create safe.
Reconnect reuses the stored target.
Changing accounts requires completed cleanup first. Disconnect disables projection immediately; the worker removes
only mapped managed events from the old calendar. Failed cleanup remains
visible with its original account/calendar/event identity and retry action.
The calendar identity remains after cleanup so reconnect uses the same calendar.
A 404/410 event delete is accepted only after writer access to its calendar is
verified again; a lost calendar grant is not treated as completed cleanup.
Synced confirmed historical consultation events remain only while their
Session is scheduled and ended; Reservation history behavior is unchanged.
During ordinary reconciliation those successful events remain; explicit
disconnect removes all locally managed event identities, including history.
Unrelated Google events are never searched, changed or deleted.

The existing `cleanupOrganizationBeforeDelete` hook stages minimal
`google_calendar_cleanup_jobs` before Better Auth physically deletes an
organization. The outbox retains only original tenant/account/calendar/event
identities and retry/receipt state, without guest content, Booking IDs or tokens.
It delays cleanup past any in-flight projection lease. No Google request blocks
organization deletion. The orphan worker requires the organization to be absent
both when selecting and claiming work; staging alone cannot authorize deletion
if the subsequent Better Auth deletion aborts. These jobs can only delete their captured managed event;
they cannot re-enroll or project a deleted tenant, and no normal tenant API reads
them. Lost credentials retain `state=error` and `last_error`; the scheduled task
reports unresolved jobs instead of claiming successful external deletion.

Operator inspection after tenant removal uses the retained outbox:

```sql
SELECT organization_id, account_id, calendar_id, event_id, state, attempts,
       last_error, next_attempt_at, completed_at
FROM google_calendar_cleanup_jobs WHERE state <> 'deleted';
```

Restore the owning linked account grant or perform separately authorized manual
cleanup when credentials are lost. No receipt is marked complete merely because
a calendar becomes inaccessible.

## Privacy

Consultation payloads contain a generic consultation title, status, canonical
start/end/timezone and the assigned attorney's public name. Only the actual
client's recorded contact email and assigned attorney's verified Better Auth
account email are attendees; other organization members are not invited. Legal
matter, notes, conversation bodies and internal dashboard links are omitted.
Consultations, experience bookings and dining reservations include a **Manage**
link to their existing account activity detail when the request and commitment
have the same canonical buyer. Opening it requires the ordinary authenticated
owner; the URL grants no access and contains no cancellation or review token.
Imported/unowned records and ownership mismatches have no invented management
destination. Staff use their own existing dashboard links in staff notifications.
Account Manage menus for consultations, experiences, reservations and direct stays
offer **Send a change request**. This opens the existing buyer conversation: the
customer describes the requested change, the business is notified, and the
conversation needs attention. Sending the message leaves booked dates, time,
guests and assignment unchanged. Channel-owned stays direct the customer to the
booking channel for changes.
Visibility is private; pending consultation requests are tentative events.
Guests cannot edit, invite others or inspect the guest list. A pending allocation without its client conversation is a private hold
with no attendees. A confirmed consultation without its client conversation,
or a consultation missing required participant emails, reports an error rather
than claiming invitation success. Experiences and reservations retain their
minimal title, guest name, status and canonical interval. The Manage link does
not add Google attendees or invitations to those verticals.

Google's `source` URL is visible only to the event creator, so the shared Manage
link belongs in its description. Lodging does not gain a Google projection:
its buyer activity details and notifications provide management. Its existing
Vrbo iCal feed is an anonymous home-occupancy calendar grouping contiguous taken
nights, possibly across several stays or holds. It retains **Not available**
events without guest identities or per-stay account links.

Creates, meaningful updates and cancellations use `sendUpdates=all`, asking
Google to send invitations/updates to all actual participants. Retained
attendees keep their provider RSVP; a new attendee starts at `needsAction`.
No proposed replacement attorney is invited by KrabiClaw before acceptance.
An invitation does not grant Google calendar writer access. Guest edit
permission is event-wide, so it remains off; staff edit the managed calendar
through their existing writer/owner access. The app grants no blanket calendar
access to organization members. Google RSVP is
independent of KrabiClaw proposal consent. Google invitations originate from
the calendar organizer, and [recipient invitation settings](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events)
determine whether the event appears automatically or needs an email RSVP.
The API does not prove inbox delivery; local qualification records exact
recipient payloads and notification parameters without sending live invites.
Google documents [`sendUpdates=all`](https://developers.google.com/workspace/calendar/api/v3/reference/events/update)
for all guest notifications and warns against `none` for ordinary event creation.

## Deployment and owner setup

1. Keep this PR based on current `staging`, which includes the consultation
   foundation (#1211). Calendar is reviewed before the separate Payments PR.
   This PR uses `0001_calendar_member_scheduling` after the v11 foundation
   baseline, then `0002_calendar_member_integrity` and `0003_calendar_connection`. The separate Payments PR
   must generate its migration after this Calendar head when rebasing.
2. Apply the canonical release/migration checks and deployment process. On
   October 4, 2026 the owner authorized staging and production promotion, docs
   publication and marketing updates after qualification.
3. Enable Google Calendar API for the existing OAuth application and configure
   its consent screen/verification for `calendar.calendarlist.readonly` and
   `calendar.app.created`. Personal checking additionally requests
   `calendar.events.freebusy`; Better Auth owns these incremental grants.
4. Connect Google Calendar under Menu → Connections → Google Calendar sync. The
   business calendar is created automatically; no export policy is chosen. In
   My account → Profile & availability → Google Calendar sync, connect Google
   and turn on Check my calendar for conflicts.
5. Perform real consent/provider verification only against a separately
   authorized disposable Google calendar. Implementation tests intercept Google
   provider requests; they do not grant scopes or mutate real Google events.


## Review and validation

This Calendar-only change targets staging after the native consultation and typed
catalog foundation (#1211) landed. It includes member working hours, time off, selected Google
busy calendars and assignment through the canonical booking allocator.

Current checks are recorded in the replacement PR. Google provider requests in
D1 tests are intercepted; those checks do not grant scopes or mutate real Google
events. Owner-authorized live verification on October 4, 2026 used the separate
private “KrabiClaw PR 1240 verification” calendar and the built local Worker.
Better Auth consent and Calendar/member callback routing returned the linked
account and explicitly selected business. A guest-created Reservation projected
the exact canonical instants; a committed note revision updated the same Google
event without exposing the private note. The dashboard link opened its canonical
thread and retained the configured HTTP/HTTPS protocol. Guest cancellation
deleted its mapped event. Disconnect deleted all 13 managed identities while
preserving an independently created event.

Member free/busy reads returned that independent event's exact UTC interval.
Google rejected the original single 94-day query as too long. The canonical read
now uses contiguous 30-day requests, retaining the full 94-day horizon and
committing coverage only after every window succeeds. A rejected final window
retains the last complete cache and exposes Google's reason; availability fails
closed. Deleting the test event and rechecking returned no busy intervals. Both
domain connections were disconnected, test events removed, and the member's
test hours cleared. The Google linked account and existing grants were retained.

The redesigned CMS was then exercised through real Better Auth consent on the
built local Worker. Calendar → Settings → Availability → Google Calendar created
the business's **KrabiClaw** calendar automatically. Its identity was read back
from D1 and its presence verified independently in Google Calendar. Personal
checking selected the primary calendar automatically; switching off and back on
retained the linked account, required no further consent, and refreshed complete
94-day coverage without an error. Desktop and mobile checks covered hours,
Cancel restoring saved values, time-off create/edit/remove, and unpublished
profile edits. Temporary member test data was removed afterward; the empty
business calendar and connection remain available for local review.

The earlier unverified-app notice was traced to Cloud Console's unused sensitive
scope and resolved on October 4; see [Public scope qualification](#public-scope-qualification).
Historical review notes on superseded PRs do not qualify this replacement head
for deployment.
