# Google Calendar sync

Google Calendar sync is a Business plan feature (`calendar_sync` in
`server/utils/billing-entitlements.ts`). KrabiClaw owns scheduling and capacity.
Connect Google Calendar to create or reuse one **KrabiClaw** calendar for the
business. All upcoming pending and confirmed Bookings and Reservations are
included automatically. Calendar-group allocation rules govern booking
availability, not which bookings appear in Google. Cancelled records and
payment holds are excluded.

The sync runs one way. Bookings change in KrabiClaw and their events follow;
editing or deleting an event in Google does not change its booking. Each event
carries a **Manage** link where the booking has one (see [Privacy](#privacy)).

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
deleted provider identities as history. `request_id` is the thread identity, never the operational Booking ID. Foundation reschedules keep the
operational ID and therefore update the same mapped Google event.

The worker preallocates a Google-compatible event ID before provider I/O.
Google refuses a second insert of the same ID
([`events.insert`](https://developers.google.com/calendar/api/v3/reference/events/insert)),
so the next pass reads that event instead of creating another, and an update
carries the event's ETag
([conditional modification](https://developers.google.com/calendar/api/guides/version-resources)).
The source revision covers canonical status, interval, timezone, names,
assignment, participant emails, request identity and current buyer ownership
eligibility. Existing mapped events therefore gain or lose their management
link when those canonical facts change. Conversation messages and pending
proposals do not send redundant calendar invitations. Each pass re-reads
current booking and integration state, and an event written after its booking
was cancelled or its calendar disconnected is deleted again. A Google call that
fails leaves its link in `error` with `last_error` and the integration in
error; the next pass writes it again.

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
identities and receipt state, without guest content, Booking IDs or tokens.
No Google request blocks organization deletion. The orphan worker selects only
jobs whose organization is absent; staging alone cannot authorize deletion
if the subsequent Better Auth deletion aborts. These jobs can only delete their captured managed event;
they cannot re-enroll or project a deleted tenant, and no normal tenant API reads
them. Lost credentials retain `state=error` and `last_error`; the scheduled task
reports unresolved jobs instead of claiming successful external deletion.

Operator inspection after tenant removal uses the retained outbox:

```sql
SELECT organization_id, account_id, calendar_id, event_id, state,
       last_error, updated_at, completed_at
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
Google rejected the original single 94-day query as too long, so a read uses
contiguous 30-day requests across the span it needs. Nothing Google answers is
stored: availability asks Google for the span of the sessions being read, and a
window Google refuses fails that read with Google's status. Deleting the test event and
rechecking returned no busy intervals. Both
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
