# Outbound Google Calendar

KrabiClaw owns scheduling and capacity. Connect Google Calendar to create or reuse
one **KrabiClaw** calendar for the business. All upcoming pending and confirmed
Bookings and Reservations are included automatically. Calendar-group allocation
rules govern booking availability, not which bookings appear in Google.
Cancelled records and payment holds are excluded. Changes to Google events do
not change the canonical booking.

Personal conflict checking is separate: each member connects their own Google
account and turns **Avoid double bookings** on to check their primary calendar.
Turning it off retains the linked account and releases personal busy exclusions.
The CMS shows no calendar picker, group picker, or reservation opt-in.

## Committed lifecycle contract

Payments, MCP and dashboard operations commit the canonical Booking/Reservation
and activity through the foundation. The projection worker reads those committed
rows, canonical Session instants/timezone and the committed activity sequence.
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
updates that identity. The source revision covers canonical status, interval,
timezone, name and committed source/activity revision. Leases fence concurrent
processors, and each attempt re-reads current booking/integration state. A late
result after cancellation/disconnect is compensated by deleting that exact
managed identity; if compensation fails, the persisted intent is retried. A
process killed between the provider write and local receipt is also reconciled
from the same durable mapping. Cross-provider atomicity is impossible: a late
in-flight event can be briefly visible until compensation/retry completes.

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

Payloads contain a minimal consultation/reservation title and guest name,
status, canonical start/end/timezone and dashboard link. Visibility is private.
No email, notes, legal matter, thread body, attendees, invitations or office data
are sent. Provider mutations use `sendUpdates=none`.

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
4. Connect Google Calendar in Calendar → Settings → Availability. The business
   calendar is created automatically; no export policy is chosen. In My account
   → Profile & availability, connect Google and use Avoid double bookings for personal
   conflicts.
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
