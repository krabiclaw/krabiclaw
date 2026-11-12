# One conversation model and one bookings table

The plan (approved 2026-11-10) and the audit it is built on, in one place. The plan says what we're doing and in what order. The audit lists every current implementation with `file:line`, what replaces it, and the decisions taken.

## Plan

### Context
- **What the client asked for:** faster Messages, and marking conversations read or unread without opening them.
- **What went wrong:** #1814 (merged to staging) and #1819 (open) built on top of a model with many paths for one thing.
- **How unread works today:**
  - The Messages dot reads "alert" rows, not messages.
  - Bookings write a real opening message, but the dot never counts it.
  - Mark-as-unread deletes an alert acknowledgement, so it fails wherever no alert exists.
- **Duplication found in the audit:**
  - 5 copies of the unread SQL.
  - 3 conversation counts that disagree.
  - 2 inbox lists.
  - 2 team unread counters.
  - 3 read stores.
  - Two parallel conversation systems: guest (`requests` + `activity_entries`) and team (`team_threads` / `team_messages` / `team_thread_members`).
- **The same duplication is the speed problem.** The unread count reads 126k rows for 28 conversations, unread is computed 2–3 times per list load, and every thread open writes rows.

**Target (Slack/Discord):**
- **Conversations:** group conversations of users.
- **Messages:** one messages table.
- **Read state:** one per person per conversation.
- **Events:** messages from KrabiClaw in the conversation they belong to.
- **No alerts.**
- **Push, email and WhatsApp:** delivery of messages.
- **Billing and payouts:** CMS pages plus email.
- **Google Calendar:** write-only, Calendly style.

### Facts checked (not assumed)
- **Guest identity.** Better Auth anonymous users already exist for site checkouts. Production requests by guest identity:
  - anonymous: 73 (bookings + reservations + contacts)
  - no user: 65, mostly Airbnb stays (27), contacts (22), bookings (9) and reservations (7)
  - named: 12
- **Alerts written in production** (all time):
  - `submission_reply_airbnb` 76
  - `guest_thread_event` 35
  - `new_reservation` 34
  - `new_booking` 34
  - `new_contact_msg` 24
  - smaller counts of cancellations, change requests and payments
  - `calendar_sync.*` 2, both on 2026-10-27
- **Google Calendar:** 2 connections in production. Cedar Legal (demo) has 1 event; STRUT has 0.
- **Stripe Connect** (Express, `losses_collector: stripe`), from Settings → Connect → Emails:
  - Stripe sends 670 compliance and risk emails (payouts paused, link bank, verify identity, negative balance, high dispute rate). These are mandatory; only branding and recipients can change.
  - Stripe sends no routine "payout sent", "payout failed" or "new dispute" email.
- **KrabiClaw subscription.** Stripe Billing customer emails are all off: trial reminder, renewals, expiring card, card failed, debit failed. Successful-payment and refund receipts are off too. The sending domain is stripe.com. We send no subscription emails ourselves.
- **Subscription emails other services send** (ChatGPT, per Gmail): "Your new plan", "Your receipt from X #…" (Stripe's own receipt, sent in the merchant's name) and "Your plan will not renew".

### Order of work

#### 0. Stop (done 2026-11-10)
- Close #1819 without merging, and drop 79568f6 from krabiclaw-ios-app#59.
- Freeze further work on the alert-based read/unread from #1814.
- Keep `PRAGMA optimize` in deploys and the parallel reads in `detail.ts` and `inbox.ts`.

#### 1. Audit document (first deliverable, before code)
For each concept, list every current implementation with `file:line`, what replaces it, and the delete list:
- conversations
- messages
- read state
- unread SQL
- counts
- lists
- alerts
- Calendar inbound
- payment and billing notifications
- team threads
- MCP tools
- iOS endpoints

The three audit reports from this session are the starting inventory. Agreeing this list is the gate before any code.

#### 2. Schema epoch: one conversation model and one bookings table
Use the repository's epoch mechanism: a replacement D1 created `--location wnam`, the canonical baseline, then initial copy and final delta (`docs/operations/release-and-outage-prevention.md`).
- **`conversations`:** one table for guest conversations, team DMs and team groups. Each row is linked to its booking, reservation or stay where it has one. This replaces the `requests` conversation role and `team_threads`.
- **`conversation_participants`:** `(conversation_id, user_id, last_read_message_id)`. This is Discord's `read_states`: membership and read position on one row. It replaces `team_thread_members` and all three read stores.
- **`messages`:** one table. Author is a user, the guest (a Better Auth user, anonymous until verified) or KrabiClaw. It replaces message entries in `activity_entries` and `team_messages`.
- **Who can see a conversation:**
  - guest conversations: Better Auth role, team or assignment, as today
  - team conversations: participants
- **Every guest is a Better Auth user.** Airbnb, email and WhatsApp guests get an anonymous user when their conversation starts. Verified-email linking (`server/utils/guest-accounts.ts`) already merges them later.
- **Copy-time transform:**
  - existing guest and team conversations and messages map into the new tables
  - read positions are seeded so nothing reads newly unread
  - operation entries that were events become KrabiClaw messages: cancelled, change requested and accepted, payment captured or refunded, dispute
- What else in `activity_entries` survives (submissions, audit) is decided in the audit document, and moved or deleted there.

#### 3. One path on top
- **Unread:** a conversation is unread when it has a message from someone else newer than your `last_read_message_id`. One SQL, used by:
  - list rows
  - the Unread filter
  - filter-menu counts
  - the nav count
  - the app badge
  - MCP
- **Read state writes:** opening a conversation sends read-through with the newest message shown, as Slack does. Mark as read or unread moves the position, and works for any conversation with a message from someone else.
- **Live updates:** the `GuestInboxHub` Durable Object stays as the gateway. Message events are `MESSAGE_CREATE`; read changes are `MESSAGE_ACK` to the reader's other apps.
- **One list function** for the dashboard, iOS and MCP. Delete `listOrganizationGuestThreads` and the duplicate routes.

#### 4. Delete
- **Alerts entirely:**
  - `kind='notification'` / `acknowledgement` rows
  - `notification-center.ts` alert writes
  - `notification-acknowledgement.ts`
  - `unread.ts` alert counts
  - the bell (`NotificationList.vue`, `DashboardNotificationBell.vue`, `/api/dashboard/notifications/*`)
  - schedule-alert acknowledgement in booking and stay details
  - `publishAssignedConversationAlert`
  - task alerts (Today is the task list)
- **Calendar inbound:**
  - `google-calendar-inbound.ts`: watch channel, change pull, restore loop, change requests from Google, `calendar_sync.*`
  - the "reschedules" toggle
  - the related settings UI
  - **Keep:** writing events with the "Manage booking" link (`calendarEvent`, `server/utils/google-calendar.ts:113`) and the live free/busy read (#1798).
- **`stripe_account_attention`** (duplicates Stripe's mandatory compliance emails).
- **Every special case found:**
  - automatic team messages that "never count as unread"
  - `canMarkUnread`
  - the 1 ms read-position trick
  - the GET that writes acknowledgements
  - the guest per-entry acknowledgement rows

#### 5. Email (billing and money are CMS plus email, never messages)
- **KrabiClaw subscription.** Turn on Stripe Billing customer emails (trial ending, card failed, expiring card) and successful-payment and refund receipts. Add our sending domain in Stripe so they come from krabiclaw.com. We send only what Stripe doesn't: "your new plan" or plan changed, and "your plan will not renew". These come from Better Auth Stripe subscription hooks and go through the existing email delivery.
- **Business payouts.** We email "payout sent" and "payout failed" (Stripe sends neither).
- **Disputes.** A KrabiClaw message in the booking's conversation, plus email. Stripe requires the platform to send these.

#### 6. Clients
- **Web Messages:** one list for all conversation kinds, `MessageRowActions` swipe/menu/hover, and read-through on open.
- **iOS:** the same endpoints, one conversation screen for guest and team, swipe and long-press.
- **MCP:** one conversation toolset instead of separate guest and team tools. Regenerate the catalog and the ChatGPT submission.

### Verification
- **Before and after on production data:** list and count queries `rows_read`, against 28,037 / 125,666 today; thread-open round trips; rows written per open, which should be 0.
- **D1 tests on the new model:**
  - a booking's opening message is unread until opened
  - mark unread works on any conversation with a message from someone else
  - one count everywhere
  - KrabiClaw event messages count as unread
  - team and guest conversations behave identically
- **Epoch verification:** compare old and new databases directly (conversations, messages, read positions per user, unread counts per user), not through staging.
- **E2E:** Messages read/unread through the UI, read back through the count endpoint, and MCP list parity with the dashboard.
- **Staging check as the canary owner:**
  - new booking shows unread
  - swipe unread and read
  - Google event created with the Manage link
  - a Stripe test subscription triggers the receipt and trial emails
- **Process:**
  - iOS simulator build
  - CI Checks steps run locally
  - local CodeRabbit pass
  - one PR per repository

## Audit

Status: for agreement before any code (approved plan, step 1). Audited at staging `8d777e4ea`, 2026-11-10, plus iOS `krabiclaw-ios-app` at `312b086`.

### Target

We model messaging the way Slack and Discord do:

- **Conversation.** One concept with participants. A guest conversation, a team DM, a team group and a job conversation are all conversations.
- **Message.** One table. The author is a user, the guest (a Better Auth user, anonymous until verified) or KrabiClaw.
- **Read state.** One row per participant per conversation: `last_read_message_id`. Unread means a message from someone else is newer than that.
- **Events.** Things like a cancellation, a change request or a payment are KrabiClaw messages in the conversation they belong to.
- **Delivery.** Push, email and WhatsApp deliver messages. There are no alerts and no bell.
- **Billing and money.** These live in CMS pages and email, not in messages.
- **Google Calendar.** Write-only, as Calendly does it: events carry the Manage link, and we read free/busy.
- **Access.** Better Auth roles, teams and assignment decide who sees a guest conversation. Participants decide who sees the others. There is no shadow membership.

### 1. Conversations: two systems today

| | Guest | Team |
|---|---|---|
| Conversation | `requests` row, which is also the booking request: contact details, provenance, cancel token, answers (`schema.ts:80`) | `team_threads` (`schema.ts:2401`) |
| Messages | `activity_entries` with kind `message` (`schema.ts:153`) | `team_messages` (`schema.ts:2451`) |
| Read state | Members acknowledge alerts; guests acknowledge each entry | `team_thread_members.last_read_at` |
| Provider address | `channel_threads` | none |
| Domain | `server/domain/guest-threads/*` (18 files) | `server/domain/team-messages.ts` (its header claims nothing else touches the team tables, but 8 files do) |
| Routes | `organizations/[org]/guest-threads/**`, `dashboard/guest-threads` (duplicate list), `account/messages/**` | `dashboard/team/**` (no single-thread GET; clients list everything and filter) |
| Web | `GuestThreadList/Detail.vue`, `ConversationSheet.vue` | `TeamThreadList/Detail.vue`, `messages/new.vue`, `team/[id]/details*` |
| iOS | `InboxView`, `InboxConversationView`, `ConversationDetailsSheet`, `GuestInbox` | `TeamMessaging`, `TeamConversationDetails`, `TeamModels` |
| MCP | `list/get_guest_conversation`, `reply_to_guest`, `set_guest_conversation_archived/read` | `list/get/start_team_conversation`, `send_team_message`, `update_team_group`, `mark_team_conversation_read/unread` |

**Replaces it:** `conversations`, `conversation_participants` (with `last_read_message_id`), `messages`, one set of routes, one list, one conversation screen on web and iOS, and one MCP toolset.

The booking-request fields in `requests` stay with the booking: contact, provenance, cancel token and answers. `requests` stops being the conversation.

### 2. Messages and events (`activity_entries` today)

| Kind / event | Today | Becomes |
|---|---|---|
| `message` with no event name; `thread.guest_note` | Guest's own words (email, web, WhatsApp) | message by the guest |
| `thread.member_reply` | Member reply | message by the member |
| `thread.opening` | Booking's opening line, drawn on the guest's side | message, as today |
| `thread.scheduled_message` | Automatic template | message by KrabiClaw or the business |
| `channel.message_mirrored` | Airbnb message (guest, member echo, or Airbnb Support) | message; the member echo is not stored twice |
| `booking/reservation.confirm/reject/cancel`, `.no_show`, `stay.*_cancelled`, `booking_change.*`, `review.requested`, `payment.*`, `calendar_sync.*` | Operation entries drawn as sentences | KrabiClaw message; `calendar_sync` is deleted |
| `booking.created`, `reservation.created`, `channel.inquiry_received` | Silent bookkeeping | not a message; inquiry dates belong on the inquiry |
| `thread.archived/unarchived` | Shown as an event | conversation state (decision D2) |
| `internal_note.*` | Host "internal notes" stored as hidden conversation entries (`dashboard-booking-details.ts:471-480`); 0 in production | a host notes field on the booking, reservation or stay, edited on its details page (Airbnb's private notes); never in the conversation |
| `submission` | Delivery anchor; contact words live in `payload` | contact words become the guest's first message; the anchor goes away (section 5) |
| `notification`, `acknowledgement` | Alerts and read state | deleted (section 4) |
| `audit` | Organization log, idempotency receipts, team alert anchor | stays as the audit log; it stops anchoring messages |
| `assignment`, `resolution` | No writers | deleted |

Writers today: `appendEntry` (`entries.ts:61`) plus about 12 hand-written `INSERT … MAX(sequence)+1` copies:

- `operations.ts:185,563,854`
- `channel-messages.ts:362`
- `opening.ts:89`
- `booking-changes.ts:526,625`
- `requests.ts:314,366,504`
- `product-bookings.ts:324`
- `table-reservations.ts:265`
- `payments/events.ts:151`
- `repository.ts:814`

**Replaces it:** one message writer.

### 3. Unread and read state: 5 SQL copies and 3 stores today

**Readers:**

| Reader | Location |
|---|---|
| `UNREAD_FOR_MEMBER_SQL` | `repository.ts:267` |
| Verbatim copy | `repository.ts:486-495` |
| `memberThreadAlerts` | `repository.ts:584-593` |
| `listUnreadThreadIds` | `repository.ts:578` |
| `unreadNotifications().guestConversations` | `unread.ts:14` |
| `BUYER_UNREAD_THREAD_SQL` | `entries.ts:185`, used in 3 places |
| Team | `listTeamThreads` (`team-messages.ts:208`) and `unreadTeamConversations` (`unread.ts:34`). These disagree: the latter counts automatic messages, so job posts raise the badge but not the list. |

**Writers:**

| Writer | Location |
|---|---|
| `acknowledgeThreadNotifications` | via a GET that writes, `dashboard-guest-threads.ts:167` |
| `setConversationRead` / `unacknowledgeThreadNotifications` | `notification-acknowledgement.ts:78,101` |
| `acknowledgeBuyerThreadEntries` | `:154` |
| `markTeamThreadRead/Unread` | `team-messages.ts:826,843`; uses server time and a 1 ms trick |

**Counts that disagree:**

| Count | Location | Scope |
|---|---|---|
| Filter menu | `countUnreadInboxThreads` | Current mailbox |
| Nav badge | `unread-count.get.ts` | Includes archived |
| App icon | `unreadBadge` | Counts alerts, not conversations |

**Replaces it:** one unread SQL on `conversation_participants`, one read writer (read-through on open; mark read/unread from the list), and one count used by the list, filter, nav, app icon and MCP.

### 4. Alerts: deleted

**Writers** (templates written as `kind='notification'`):

- `notifyOwner` (`notifications.ts:776`), used for: `new_reservation`, `new_booking`, `new_stay`, cancellations, `new_contact_msg`, `channel_inquiry`, `channel_stay.*`, `*.change_*`, `calendar_sync.*`, `new_review`
- `notifyGuestThreadReply` direct insert (`:1953`)
- `notifyTaskPeople` (`:2349`)
- `notifyFinancialNotification` (`:929,963`)
- `notifyDomainLifecycle` (`domain-notifications.ts:53`)
- `notifyStripeAccountAttention` (`payments/notifications.ts:167`)
- `notifyBuyerThread` / `guest_thread_event`, `platform.user_signup`, auth email failures (`notification-center.ts:110,139`, `auth.ts:662,685`)

**Readers and UI:**

- Server:
  - `api/dashboard/notifications/*`
  - `notification-access.ts`
  - `notification-acknowledgement.ts`
  - `unread.ts`
- Booking and stay details: `unreadNotificationIds`
- Task read route
- Web:
  - `NotificationList.vue`, `DashboardNotificationBell.vue`
  - the bell in `DashboardMenuSlideover.vue` and both `menu.vue` pages
  - `pages/dashboard/{[org_slug],account}/notifications.vue`
  - `menuUnread` in `DashboardShell/TopNav`
- iOS: `DashboardActivity.swift` and the notification push target
- `docs/notification-testing.md`

**Must be re-anchored before the rows go.** Delivery receipts (`guest_thread_deliveries.entry_id`, cascading) hang off the notification row for events with no conversation entry:

- tasks
- `domain_update`
- `stripe_account_attention`
- payouts
- `new_review`
- `channel_stay.*`

Under the target model:

- Events about a booking become KrabiClaw messages and anchor on the message.
- Payouts, domains and billing anchor on their `audit` row, the existing `organizationEventQuery` pattern (`notifications.ts:2177`).
- Tasks anchor on the task.
- `cleaner-jobs.ts:135` dedupes by notification key; re-key it on the task.

**Kept:** the send pipeline (`notifyOwner` → `memberNotificationSends`), `guest_thread_deliveries`, all notification preferences and push subscriptions, the `server/notifications/*` builders, and the realtime gateway. `notification.read` is renamed to the read event; `notification.created` is deleted.

### 5. Delivery anchors and email reply addresses

Every reply-to address carries an `activity_entries.id` (`reply-address.ts:77`). Email already sitting in inboxes points at old ids. Inbound mail is parsed in `cloudflare-email.ts:55`.

Team alerts and replies find their message by cutting it out of the audit key `substr(dedupe_key,14)`:

- `deliveries.ts:107`
- `member-reply.ts:124`
- `team-messages.ts:536,656,751`

**Replaces it:** deliveries and reply-to addresses reference `messages.id`. Messages keep their ids when copied, so reply-to works as it does today.

### 6. Google Calendar inbound: deleted

**Deleted:**

- `server/utils/google-calendar-inbound.ts` (whole file)
- `api/integrations/google-calendar/webhook.post.ts`
- `.../google-calendar/settings.post.ts` (the reschedules toggle)
- the watch calls in `connect/disconnect.post.ts`
- the `sync:` field in `index.get.ts`
- the inbound block in `server/tasks/google-calendar-sync.ts`
- the `google_calendar_sync` table
- `notifyCalendarSyncOwner` and its catalog and message
- the `calendar_sync.move_refused` task (`repository.ts:750`, `tasks.ts:624`)
- `source:'google_calendar'` in `requestBookingChange`
- the inbound UI in `GoogleCalendarLeaf.vue`
- the inbound half of `docs/integrations/google-calendar.md`
- `google-calendar-inbound-d1.test.ts`

**Simplified:** `syncCalendarOrganization` loses its `expectedEtag/eventLinkId` restore parameters.

**Kept:** outbound events with the Manage link (`calendarEvent`, `google-calendar.ts:113`), the event-link, setup and cleanup tables, and free/busy (`member-scheduling.ts:176`).

**Behaviour change:** an event someone deletes or moves in Google stays as they left it. The booking is unchanged, and changes go through the Manage link.

Production usage is 2 connections: Cedar Legal (demo, 1 event) and STRUT (0 events).

### 7. Billing and money: email, not messages

Checked in Stripe's dashboard and in our code.

- **KrabiClaw subscription.**
  - Every Stripe Billing customer email is off today: trial-ending reminder, renewals, expiring card, card failed, debit failed. Receipts and refund receipts are off too.
  - We send none of our own.
  - Plan:
    - Turn Stripe's emails on.
    - Add our sending domain in Stripe.
    - Send our own only for "your new plan" and "will not renew", from Better Auth Stripe hooks.
- **Connect (Express).**
  - Stripe sends 670 mandatory compliance and risk emails (payouts paused, link bank, verify identity, negative balance, dispute rate).
  - `stripe_account_attention` duplicates those, so it is deleted.
  - Stripe sends no "payout sent", "payout failed" or "new dispute" emails, so ours stay. A dispute is also a KrabiClaw message in its booking's conversation.

### 8. Other duplicate or broken paths found

| Finding | Location | Status |
|---|---|---|
| Production WhatsApp guest messages saved with `channel = NULL`, so guest-visibility rules hide them from the guest | `whatsapp/webhook.post.ts:168` vs dev route `:42` | live bug |
| One guest cancellation writes two entries | `requests.ts:504` + `notifications.ts:712` | shown twice in the conversation |
| Airbnb replies stored twice and filtered at read time | `channel-messages.ts:362`, `:130`; `detail.ts:93` | |
| Two conversation reads | `getGuestThreadDetail` / `getInboxThread` | |
| Guest visibility defined twice | SQL `repository.ts:253` and TS `entries.ts:178` | |
| Change answers have two routes | `account/bookings/change.post.ts`, `public/booking-changes/[threadId]/[requestId].ts` | |
| Cancel has two routes | dashboard operations and editor `reservation-submissions/[id].patch.ts`; editor list routes have no callers | |
| Two pending-message systems | `send_later_messages` and `scheduled_guest_messages`, with two cancel routes | |
| Three writers each for `team_messages` and for team threads/seats | `closeTask` raw SQL at `tasks.ts:1058` | |
| Job key built twice | `cleaner-jobs.ts:44`, `tasks.ts:1053` | |
| Two "Message host" roster builders | iOS `Turnovers.swift:211`, server `cleaner-jobs.ts:46` | |
| Account merge does not re-point the guest's own message authorship | `guest-accounts.ts:24-42` | |
| Dead code | `getLatestEntry`, `getLatestEntryByKind`, `SILENT_EVENTS` `stay.created`, the inbox `complete` branch, `assignment`/`resolution` kinds, the `notifications` permission statement | |
| Misnamed columns | `review_requests.booking_id/booking_type`, which hold the request id and kind | |

### 9. Bookings: four tables today for one concept

"Someone booked something" lives in four tables:

| Table | Holds | Schema |
|---|---|---|
| `bookings` | Experiences, classes and consultations; times come from the session | `schema.ts:964` |
| `reservations` | Restaurant tables | `:1082` |
| `stays` | Homes | `:1407` |
| `requests` | The booking request (guest contact, notes, answers, provenance, cancel token) and the conversation | `:100` |

The same fact has a different name, or a different home, in each:

| Concept | Today |
|---|---|
| Time | session times / `starts_at` / `check_in_date` |
| Party | `party_size` / `adults`+`children`+`infants` |
| Guest | `requests.payload.guest` / guest columns on `stays` |
| Notes | three copies (see D3) |
| Optimistic lock | `updated_at` / `version` |
| Statuses | `pending|confirmed|cancelled`, `confirmed|cancelled`, and `pending` allowed on stays but never written |

Tables that point at "a booking" do it three ways:

- `payments.subject_type`
- `payment_checkout_holds.converted_{booking,reservation,stay}_id` (three columns)
- `tasks`, `scheduled_guest_messages` and `team_threads` `subject_type`
- `google_calendar_event_links.booking_kind` (stays excluded)
- `review_requests` and `reviews`, which key on the thread

**Duplicate implementations of one lifecycle:**

| Operation | Today, per kind |
|---|---|
| Read | 8 separate unions of the three tables: `BOOKED_RECORDS_SQL` (`requests.ts:189`), `OPERATIONAL_RECORDS_SQL` (`repository.ts:110`), `review-requests.ts:130`, `review-request-automation.ts:37`, `repository.ts:744`, `dashboard-booking-details.ts:196`, `calendarSubjects` (`google-calendar.ts:149`), `booking-change-state.ts:11`. Plus per-table EXISTS triples: `REQUEST_CURRENT_BUYER_SQL`, `CANCELLED_AFTER_SQL`, `HAS_CONVERSATION_SQL`, `buyer.ts:130`, `analytics-report.ts:314`, `guest-accounts.ts:24` |
| Create | `createProductBooking` / `createTableReservation` / `createStay` + `createStayBooking` + `applyChannelBooking` + `stayFromCheckoutQueries` |
| Paid conversion | `commitVisit` (ternary) / `commitStay` + `convertStayHold` |
| Host cancel | `operations.ts` `sourceUpdateQuery` / `cancelStay`. Routes: guest-thread operations, the editor `reservation-submissions/[id].patch.ts` and `stays/[id]/cancel` |
| Guest cancel | `cancelBookingRequest` / `cancelStayAsGuest` / `cancelStayPayment` |
| Change | `requestBookingChange` / `moveBooking` (booking and reservation sub-branches) / `updateStay` / `moveStay` |
| Confirm and reject | bookings only |
| No-show | one function dispatching through `NO_SHOW_TABLES` |
| Details | `loadDashboardBookingDetails` / `loadBuyerBookingDetails` / `getStay` / `readGuestStay`. Route pairs under dashboard, account and public. `BookingDetails.vue` (559 lines) / `StayDetails.vue` (517 lines) |
| Lists and calendar | three list paths; agenda reads visits and stays with two queries; two calendar feeds merged in `CalendarGrid.vue:246` |
| Notifications | created and cancelled triples in `notifications.ts` |
| MCP | 13 lifecycle tools across `product_booking`, `table_reservation` and `stay` |
| Access | `assertAssignedBookingAccess` / `assignedGuestThreadScope` / `stayAccessFor` |
| iOS | only stays are first-class (`BookingDetailView` takes a stay). Bookings and reservations are read-only or sent to the web. Today does not decode reservation cards. |
| Web confirmation pages | three near-identical wrappers: `pages/bookings/confirmed.vue`, `pages/reservations/confirmed.vue`, `pages/bookings/stay.vue` |

Rough size: about 420 kind branches across `server/`, `pages/` and `components/`. Raw SQL against the three tables appears in 56 files.

**Replaces it:** one `bookings` table.

- **Identity:** `id`, `organization_id`, `kind` (`stay | experience | consultation | table`; stored, since a table has no product), `user_id`.
- **What and where:** `product_id`, `product_variant_id`, `product_session_id`, `location_id`, `assigned_member_id`.
- **When:** `starts_at` and `ends_at` (instants for every kind; a stay's are its check-in and check-out times), `timezone`.
- **Party:** `party_size`, the one count; `adults`, `children` and `infants` as an optional breakdown on any booking.
- **Status:** `pending | confirmed | cancelled`, with `cancelled_at`, `cancellation_reason`, `no_show_at`.
- **Guest:** guest name, email and phone; `answers`; `party_size_is_minimum`.
- **Notes:** `private_notes`, for the host.
- **Terms and money:** `policy_json`, `total_minor`, `currency`.
- **Bookkeeping:** `idempotency_key`, `version`, timestamps.
- **Channel, on every booking:** `channel` (not null, default `direct`), `owner`, `provider`, `external_booking_id`, `channel_booking_id`, `revision_id`, `provider_updated_at`, `overbooked`, and `booked_product_id` (the listing it was booked on).
- **No stay-only columns.** Check-in and check-out dates are `starts_at` and `ends_at` in the booking's timezone, so the separate date columns are deleted. Nights stay in `stay_nights`, which is inventory, just as sessions and table slots are for the other kinds.

Every reference becomes `booking_id`: payments, checkout holds, tasks, scheduled messages, conversations, calendar links (stays included), reviews, `stay_nights` and `stay_payments`. Each lifecycle step has one implementation (create, convert, confirm, cancel, change, no-show, details, list, notifications, MCP, access), and one detail screen on web and iOS for every kind.

**Stays per kind, because it really is different:**

- inventory and claim (seats in a session, table slot capacity, `stay_nights`)
- channel sync (Channex, Airbnb change requests)
- turnover and `stay_ready` tasks
- consultation provider reassignment

**Bugs and dead code found on the way:**

- Status comments list `completed`, but no CHECK allows it and nothing writes it.
- `bookings.completed_at` is referenced in a comment but does not exist.
- Stays allow `pending`, which is never written.
- `setBookingStatus` (`availability.ts:1121`) is called only by tests.
- Google Calendar never writes stays.
- iOS Today ignores reservation cards.

### Decisions (taken 2026-11-10)

- **D1 – guests without an account.** Create a Better Auth anonymous user when an Airbnb, email or WhatsApp conversation starts, so every participant is a user. Verified-email linking (`guest-accounts.ts`) merges them later. Recommended: yes.
- **D2 – archive.** Per participant, which is Slack's "hide" and Airbnb's archive. Or per business, as today. Recommended: per participant.
- **D3 – notes. Decided.**
  - **Guest's note:** one source, the guest's message in the conversation. Today the same text is copied into `requests.payload.notes`, the `thread.guest_note` message and, for checkout stays, `stays.notes`. Delete the payload and column copies.
  - **Host's note:** one source, a host-notes field on the booking, reservation or stay, like Airbnb's private notes. Today host notes are hidden `internal_note.*` conversation entries, plus `stays.notes` when the host created the stay (`create_stay`), so one column holds two different things. Delete both.
- **D5 – two pending-message systems. Decided: merge** into one scheduled message in this epoch.

Owner agreed with D1, D2 and D5 as recommended (2026-11-10).

For the bookings table:

- **D6 – no stay-only columns. Decided.** Every column means the same thing for every kind. Channel and provider fields apply to any booking (`direct` by default). Stay dates are `starts_at` and `ends_at` in the booking's timezone. The party breakdown is optional on any booking.
- **D7 – offline payments for every booking. Decided: yes.** `stay_payments` becomes offline payments recorded against any booking.
- **D8 – reviews keyed on the booking. Decided: yes.** `review_requests` and `reviews` reference `booking_id`.
