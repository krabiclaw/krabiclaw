# Native app contract: KrabiClaw identity and lodging for the KrabiClaw iOS app

The KrabiClaw iOS app (bundle id `com.krabiclaw.app`, source in the krabiclaw/krabiclaw-ios-app repository) talks to KrabiClaw and nothing else. KrabiClaw owns identity, organizations, membership and every piece of lodging data: homes, stays, nights, Channex/Airbnb, guest and team messaging, scheduled messages, device tokens and home assignments. The separate lodging Worker that held lodging data until #1381 is retired; KrabiClaw makes no call to it and exposes no route for it.

Decisions D3–D9 were recorded by the owner on 2026-10-14 (krabiclaw#1370); D1, D2 and D10 governed the lodging Worker and ended with it.

## 1. Boundary

| Concern | Authority |
|---|---|
| Users, Apple credentials, sessions, profile, account deletion | KrabiClaw Better Auth (`server/utils/auth.ts`) |
| Organizations, membership, roles, invite links, impersonation | KrabiClaw organization + admin plugins; `organization_invite_links` |
| Homes, stays, nights, Channex/Airbnb, guest and team messaging, scheduled messages, device tokens, home assignments | KrabiClaw D1 through its domain modules (`server/domain/stays.ts`, `server/domain/team-messages.ts`, `server/integrations/channex/*`, …) |

## 2. Authentication

- The app authenticates with a Better Auth bearer session only: `Authorization: Bearer <token>`, no cookies, no `Origin`, ephemeral `URLSession`. The one exception is stopping support impersonation (§3). The `bearer()` plugin maps the header onto the session; a bearer caller sends no `session_data` cookie, so every request reads the session from D1 and revocation is immediate. `set-auth-token` on a response is the same token with a later expiry; the app stores whatever it receives.
- Membership is never cached: `resolveMembership` reads the `member` row on every request.
- Dashboard routes name their organization explicitly with the `org` query parameter (the organization slug); `session.activeOrganizationId` is a last resort the app does not rely on. The live socket is `GET /api/dashboard/guest-inbox/socket?org=<slug>` and re-reads the session and membership for every event it carries, so a revoked session or removed member is closed at the next event.

## 3. Operation map

| Native action | Endpoint | Notes |
|---|---|---|
| Sign in with Apple | `POST /api/auth/sign-in/social` `{provider:"apple", idToken:{token, nonce}}` | `set-auth-token` is the bearer. |
| Existing account entry (and Debug builds) | `POST /api/auth/sign-in/email` | D3, D9. |
| Link Apple to an existing account | `POST /api/auth/link-social` `{provider:"apple", idToken}` | `apple` stays out of `trustedProviders` (D3). |
| Profile | `GET /api/auth/get-session`, `POST /api/auth/update-user`, `POST /api/user/avatar` | D7. |
| Sessions | `POST /api/auth/revoke-other-sessions`, `POST /api/auth/sign-out` | Sign-out order: `DELETE /api/dashboard/devices` → sign-out → clear Keychain. |
| Organizations | `GET /api/auth/organization/list`, `get-active-member-role`, `list-members`, `set-active` | |
| Create organization | `POST /api/auth/organization/create` `{name, slug, default_currency, timezone}`, then `POST /api/organizations` `{organizationId, name, subdomain, vertical:"lodging", sourceLocale}` | The same two calls web onboarding makes; publishes the Saya site on the system subdomain. |
| Invite a member | `POST /api/organizations/:id/invite-links` `{role}` → 201 `{id, token, role, expiresAt}`; `GET /api/organizations/:id/invite-links`; `DELETE /api/organizations/:id/invite-links/:linkId` → 204 | Single use, seven days, only the token's SHA-256 is stored. The app shares `<KrabiClaw origin>/invite/<token>` (D4). |
| Open an invite | Public page `/invite/:token` reads `GET /api/invite-links/:token` → `{organization:{name}, role, expiresAt}` | No session needed; it names nothing about members. 404 `INVITE_LINK_NOT_FOUND` (unknown or withdrawn), 410 `INVITE_LINK_USED` / `INVITE_LINK_EXPIRED`, each with `field: "token"`. The page lets a signed-in person join, offers Google, email sign-in and sign-up first, and offers `krabiclaw://invite?token=` to the app. KrabiClaw serves no `apple-app-site-association`, so the https link opens the page rather than the app. |
| Accept an invite | `POST /api/invite-links/:token/accept` → 200 `{organization:{id, name}, role, memberId}` | 401 `AUTHENTICATION_REQUIRED`, 404/410 as above, 409 `ALREADY_MEMBER`; membership is written only by `auth.api.addMember`. |
| Change role / remove member / leave | `POST /api/auth/organization/update-member-role`, `/remove-member`, `/leave` | Admin may invite or promote an admin (D4). |
| Team | `/api/dashboard/team/members`, `/api/dashboard/team/threads[/:threadId/messages\|/read\|/operations]` | Each thread seat references a Better Auth membership and is deleted when that membership ends. Resource responsibility uses each canonical location, offering or home write. |
| Homes, stays, nights | `/api/dashboard/stay-homes[/:productId]`, `/api/dashboard/stays[/:stayId]` | A home's check-in window: §3.2. Every home carries `live`: §3.4. A stay's `channel` is `airbnb`, `vrbo`, `booking_com` or `direct`; `booking_com` arrives with database v21. Owners and admins (`manage: true`) read the whole stay. A member responsible for a home (`manage: false`) reads each of its stays, here, in the calendars and over MCP, as its turnover (`StayTurnover`): exactly `id`, `product_id`, `location_id`, `timezone`, `status`, `check_in_date`, `check_out_date`, `arrival_time`, `adults`, `children`, `infants`, `guest_name`, `no_show_at`. A stay's guest conversation and scheduled messages are not in a member's scope, and stay changes and payments are 403 `STAY_ROLE_REQUIRED`. |
| Today | `GET /api/dashboard/today` with `range=today` or `range=upcoming&from=…&to=…` | The same permissioned action feed as the dashboard. Every card carries required nullable `productId`, from its actual offering association, and `stayChannel`, from its actual stay; neither is inferred from a location or a home's connected channel. Native home filters use the product ID and home photos use the canonical resource image. Managers also see in-house stays; departure cards retain actual same-day turnover warnings. |
| Notification history | `GET /api/dashboard/notifications`, `PATCH /api/dashboard/notifications/:id/read`, `PATCH /api/dashboard/notifications/read-all` | Cursor-paginated workspace history, independent of device push permission. A general notification opens its history record and canonical destination. |
| Online stay payment | `stay.online_payment` from stay detail, then `GET /api/dashboard/payments?payment_id=…` | Online payment details and Stripe refunds are separate from the manual payment ledger. `POST /api/dashboard/payments/refund` prepares an actor-bound authorization; its read and explicit approval are shared by browser and native Better Auth sessions. |
| Guest messaging | `/api/dashboard/guest-threads`, `/api/dashboard/message-templates`, `/api/dashboard/scheduled-guest-messages` | Airbnb conversations through Channex. |
| Airbnb connection | `/api/organizations/:id/integrations/airbnb/*` | Disconnect is separate from account and organization deletion. Importing a listing: §3.3; syncing listings in the background, edits sent to Airbnb and what stays Airbnb's: §3.5. |
| Homes quote | `GET /api/organizations/:id/billing/homes?adding=N` | What making homes live costs before they go live; §3.1. The write that then makes them live answers by the same rule, so a quote that allows them is one the write allows. A refused write is 402 `HOME_LIMIT` with `homes: {used, covered}`; the app offers Business there. |
| Payouts | `POST /api/dashboard/connect`, `POST /api/dashboard/connect/status`, `GET /api/dashboard/connect` | Stripe-hosted payouts onboarding from the app with `returnTo: "app"`; §3.6. |
| Push | `POST/DELETE /api/dashboard/devices`, `/api/user/notification-preferences` | A device belongs to a Better Auth session (the app's bearer, the dashboard's cookie) and cascades with it: the app sends `{deviceToken, environment}` (APNs), a browser `{endpoint, p256dh, auth}` (Web Push); DELETE names `deviceToken` or `endpoint`. Preferences answer `{preferences, labels}`: `labels` names every category in the words of the person's businesses (a law practice reads Consultation requests and Client messages). |
| Support impersonation | `POST /api/auth/admin/impersonate-user`, `/stop-impersonating` | Platform `admin` only, 900 s (D8). `impersonate-user` answers the impersonated bearer in `set-auth-token` and Better Auth's signed `admin_session` cookie in `Set-Cookie`; the app keeps that cookie value. `stop-impersonating` sends the impersonated bearer, `Cookie: <admin_session name>=<value>` and `Origin: <KrabiClaw origin>` (Better Auth refuses a cookie without an origin, 403 `MISSING_OR_NULL_ORIGIN`), and answers the administrator's own bearer in `set-auth-token`. Without the cookie it is 401 `ADMIN_SESSION_REQUIRED`. This is the one request that carries a cookie. |
| Delete account | `POST /api/auth/delete-user` with `x-apple-authorization-code` when Apple is linked | §4. |
| Delete organization | `POST /api/auth/organization/delete` | Owner only; §4. |
| Report and block | Guest: `POST /api/dashboard/organizations/:id/guest-threads/:threadId/operations/{report,block,unblock}` `{idempotencyKey, reason}` (`reason` for report and block). Team: `POST /api/dashboard/team/threads/:threadId/messages/:messageId/report` `{reason, idempotencyKey}` → 201 `{report:{id, status}}` | App Store guideline 1.2; §4.1. |

### Team group lifecycle

Team-thread responses carry required `name` (nullable), `isGroup`,
`createdByUserId` (nullable), `canManage` and `canLeave`. Clients render controls
from these server capabilities. A current participant who created a manual
group, or is a workspace owner/admin, may rename it and add/remove others; all
participants may leave. Direct, stay/location, buyer and guest conversations are
protected. Leaving/removing revokes access without deleting history. Newly added
members can read the complete history. Manual groups retain their identity even
after their roster shrinks.

Creation of a manual group requires a stable `idempotencyKey`; optional `name`
is at most 100 trimmed characters. There are at most 50 participants including
the sender. Reusing the creation key replays that exact request; another key
creates a distinct group. Direct and stay/location conversations retain their
existing participant/context reuse.

`POST /api/dashboard/team/threads/:threadId/operations` takes
`{action:"rename"|"add"|"remove"|"leave", idempotencyKey, name?, memberIds?, userId?}`
and returns `{status:"updated"|"left", threadId}`. Rename takes a name or null;
add takes current workspace user IDs; remove takes another participant's user
ID. Its receipt and mutation commit together, and the same request can repair a
failed realtime publication after the caller has left.

The socket emits `team_thread.access_ended` with `teamThreadId` and
`targetUserId` to the affected member after a removal/leave, without message
content. Both apps clear that thread's cached transcript and close its open
view. Current participants receive the normal `team_thread.changed` event.

The iOS Message host action continues to include all workspace owners/admins
in a protected stay conversation. No assignment, invite, or Better Auth Team
change automatically enrolls someone in another conversation.

Assignment/member/team writes also emit content-free `access.changed` with only
the normal event/organization/time fields. Every currently authorized workspace
socket receives it and re-reads its permitted guest conversations. A denied
403/404 read clears the displayed conversation and draft. Group participation,
booking provider attribution and current resource responsibility remain
separate. Guest timelines retain and display canonical operation entries and
their actual payloads, including booking moves and financial summaries, across
all four verticals.

Locations, experience/legal offering configurations and homes use the same
`assigned_member_id` / `assigned_team_id` pair. The first names an actual
Better Auth membership in the organization; the second names an actual Better
Auth Team there. At most one is selected. All roles are eligible for explicit
responsibility, including owners and admins. The resource editor is the write
boundary; there is no alternate bulk member-to-homes operation. Better Auth
Team changes affect authorized work, without creating chat participation.

### 3.1 Homes quote

`GET /api/organizations/:id/billing/homes?adding=N`, owner or admin. `adding` is optional, default 1, an integer from 0 to 500: the homes about to go live (§3.4). Anything else is 422 `INVALID_QUERY` with `field: "adding"`. Every amount is read from Stripe: a paid plan's from the homes price on its own subscription (its graduated tiers: the ones at no charge are the included homes, the next is each further home), billed at the end of the period, never prorated; Basic's from the published homes price in the Stripe catalog. Basic includes 2 live homes and refuses a third. Drafts are free and unlimited on every plan. When a paid plan ends (Stripe deletes the subscription, or pauses it when a trial ends without a card), the organization is on Basic and its newest live homes and active locations past the 2 included go back to drafts: a home is taken off the site and its Airbnb sync stopped (a stop job with no requester, which the airbnb-sync task runs), and a location is turned off.

```json
{
  "plan": "growth",
  "currency": "USD",
  "homes": { "used": 2, "drafts": 1, "included": 2, "additional_price_minor": 900, "amount_minor": 0 },
  "adding": { "count": 1, "additional_homes": 1, "amount_minor": 900, "allowed": true },
  "billing": { "period_end": "2026-11-21T00:00:00.000Z", "trial_end": null, "prorated": false }
}
```

- `plan`: the plan id (`free`, `growth`, `business`), derived the way the capacity check derives it.
- `homes.used`: live homes now; `homes.drafts`: homes that are not live (integer, always present); `homes.included`: live homes the plan includes; `homes.additional_price_minor`: USD cents per month for each live home beyond those, the subscription's homes price (the published one on Basic), or `0` on a paid subscription from before homes were priced, which is charged nothing for them; `homes.amount_minor`: what the live homes add to the month, `max(0, used − included) × additional_price_minor`.
- `adding.count`: `N`; `adding.additional_homes`: the homes among the `N` that fall beyond the included ones; `adding.amount_minor`: `additional_homes × additional_price_minor`; `adding.allowed`: `false` only when the plan refuses, that is Basic with `used + N > included`.
- `billing.period_end`: ISO instant of the current subscription period's end, when the invoice bills the homes, or `null` on Basic; `billing.trial_end`: ISO instant a subscription's free trial ends, or `null` outside one. Stripe bills no usage during a trial, so the amounts above apply from the period that starts when it ends; `billing.prorated` is always `false`.

### 3.2 A home's check-in window

A home has Airbnb's check-in window: a start, an end, and a checkout time. All three are local 24-hour `HH:MM` in the home's time zone.

| Field | Type | Meaning |
|---|---|---|
| `check_in_time` | string, required | Start of the check-in window. Unchanged. |
| `check_in_end_time` | string or `null` | End of the check-in window. `null` is Airbnb's **Flexible** (no end). A time earlier than `check_in_time` is after midnight (`"01:00"` with a `"16:00"` start). It may not equal `check_in_time`. New. |
| `check_out_time` | string, required | Checkout. Unchanged. |

- **Read:** every home response (`GET /api/dashboard/stay-homes`, `GET /api/dashboard/stay-homes/:productId`, and the `home` in every write's answer) always carries `check_in_end_time`, `null` included.
- **Create:** `POST /api/dashboard/stay-homes` accepts `check_in_end_time` (string or `null`); left out, it is `null`.
- **Change:** `PATCH /api/dashboard/stay-homes/:productId` accepts `check_in_end_time` on its own or with the other fields. Sending `null` makes the end flexible; leaving the key out keeps it. A value that is not `HH:MM`, including a blank string, is 422 `INVALID_DETAIL` with `field: "check_in_end_time"`. A value equal to the home's `check_in_time` is 400 `INVALID_STAY_FIELD` with `field: "stay.check_in_end_time"`.
- The product API and MCP carry the same field as `stay.check_in_end_time`; the guest page shows "Check-in 4:00 PM – 9:00 PM", or "Check-in after 4:00 PM" when the end is `null`.

### 3.3 Importing an Airbnb listing

The import takes everything it can from Airbnb and asks only for what Airbnb leaves out.

1. `GET /api/organizations/:id/integrations/airbnb/listings/:listingId` returns the listing details:

   ```json
   {
     "id": "39313043", "title": "45B · …", "currency": "USD", "maxGuests": 4, "defaultOccupancy": 2, "nightlyRate": "109",
     "fields": { "timezone": "America/Denver", "country": "US", "state": "UT", "city": "Salt Lake City", "address": "45 …", "zipCode": "84103", "propertyType": "apartment" },
     "missingFields": ["email", "phone"],
     "checkInTime": "16:00", "checkInEndTime": null, "checkOutTime": "11:00"
   }
   ```

   `missingFields` lists only these keys: `timezone`, `email`, `phone`, `country`, `state`, `city`, `address`, `zipCode`, `propertyType`. `childBeds` and `infantCots` no longer exist; Airbnb counts neither, so Channex receives 0 for both. `checkInTime`, `checkInEndTime` and `checkOutTime` are Airbnb's `booking_settings.check_in_time_start`, `check_in_time_end` and `check_out_time` as `HH:MM`, for display only. `checkInEndTime` is `null` for Airbnb's `FLEXIBLE`. A start or checkout Airbnb has not set is `null`.
2. Request `POST /api/organizations/:id/integrations/airbnb/sync` with `{"sync": [{"listing_id": "39313043", "details": {…}}]}` (§3.5). Optional `details` holds only keys from `missingFields`, each a non-empty string; contact email and phone default to the organization's. The whole request's live-home allowance is checked before anything is queued. Success is 202 `{listings}`; KrabiClaw imports new homes and carries them through activation in the background. The home takes Airbnb's check-in window (§3.2). If its start or checkout is missing, the job fails with `MISSING_AIRBNB_FIELD`, naming `booking_settings.check_in_time_start` or `booking_settings.check_out_time`, before creating a home; the host sets the field on Airbnb and submits a new sync request.
3. Read `GET …/integrations/airbnb/sync` for each listing's progress and failure (§3.5); the app need not stay open. There is no separate client activation or advance call. Once the content stage finishes, its report is `import.content` in `GET …/listings`.
4. `POST …/imports/:productId/content` runs the content stage again on a completed import (owner or admin): 200 `{product_id, stage: "complete", content}`.

The content report:

| Key | Type | Meaning |
|---|---|---|
| `photos_imported` | string[] | Airbnb image ids stored this run, at 2560 px. |
| `photos_skipped` | string[] | Already stored at full size; kept as they are. |
| `photos_upgraded` | string[] | Stored by an earlier import at 450 px and fetched again at 2560 px into the same photo, keeping its place, caption and rooms. |
| `photos_removed` | string[] | Deleted by the host from the media library after an import; left out. |
| `photos_unplaced` | string[] | Past the home's 50-photo limit; not fetched. |
| `unmatched_amenities` | string[] | Airbnb amenity constants with no home amenity. |
| `unmapped_check_in_category` | string or `null` | Airbnb's check-in category when it has no verified home check-in method. |
| `truncated_fields` | `{field, limit, length}[]` | Texts cut to the home's limit. |
| `photo_rooms_skipped` | number | Airbnb rooms not made into photo rooms. |
| `kept_host_edits` | string[] | Fields edited in KrabiClaw since the last import and preserved by this refresh; absent from reports written before background sync. |

A photo Airbnb cannot serve at 2560 px stops the stage with 502 `PHOTO_FETCH_FAILED`, `image_id` and `url`; the retry keeps every photo already stored.

### 3.4 Live homes

A home is **live** when it is active at its active location and either published on the site (`product_publications.published = 1`) or synced with Airbnb (its Channex mapping is enabled). Any other home is a **draft**: free and unlimited on every plan. Billing (`homes.used`, the Stripe homes meter) and Basic's limit count live homes only.

- Adding a home (`POST /api/dashboard/stay-homes`) is never refused for the plan: the new home is a draft. An Airbnb sync request (§3.5), including one that imports a new home, checks the resulting live-home allowance before anything is queued.
- Publishing a home (`PATCH /api/dashboard/stay-homes/:productId` `{published: true}`, the product publication route, the MCP tool), syncing an Airbnb listing (§3.5), reconnecting a listing, turning a home or its location back on: each that makes one more home live past Basic's 2 is refused with 402:

```json
{ "error": "Basic includes 2 homes. Choose Growth or Business in Billing to add more.", "code": "HOME_LIMIT", "homes": { "used": 2, "covered": 2 } }
```

  On Growth and Business nothing is refused, and every change to the live count is reported to the Stripe homes meter.
- Every `home` and `homes[]` from `/api/dashboard/stay-homes…`, and the `stay` object of the product API (`/api/editor/organizations/:id/products…`), carries `"live": true | false`, always present. The public site's product projection does not carry it. No other field changed type.

### 3.5 Airbnb listings: sync in the background

Stages of a listing's import, in order: `property`, `room`, `rate`, `inventory`, `verify_inventory`, `content`, `draft`, `mapping`, `activate`, `reservations`, `messages`, `complete`. `draft` is new and `content` moved before it; each value appears in `import.stage` of `GET …/integrations/airbnb/listings`, in `stage` below and in every import response. A home at `draft` is built (calendar, content, Channex property) and syncs nothing. It is a free draft (`live: false`) only when it is not otherwise live through website publication (§3.4). From `mapping` on the listing syncs, and from `reservations` its mapping is enabled. Stopping a home forgets what Channex confirmed for its nights, so syncing it again sends its whole calendar ahead at `mapping`, before Channex maps the listing: a full sync of 500 nights in one restrictions and one availability call. A home just imported sends nothing there, having sent its calendar at `inventory`.

**Sync request.** `POST /api/organizations/:id/integrations/airbnb/sync`, owner or admin, bearer session:

```json
{ "sync": [{ "listing_id": "39313043" }, { "listing_id": "40112808", "details": { "zipCode": "84103", "propertyType": "apartment" } }], "stop": ["8d0c…"] }
```

`sync` names listings of the connected Airbnb account to import (if they are not homes yet) and make live, each with `details` (optional): values for the fields `GET …/listings/:listingId` reports in `missingFields`, each text, used when the home is made. Contact email and phone default to the organization's. `stop` names homes imported from the account to stop syncing; they become free drafts only when they are not otherwise live through website publication (§3.4). The plan is checked once for the whole request, before anything is queued: the live homes it leaves are the live homes now, plus each synced listing not live yet, less each stopped home that is not also published on the site. Past Basic's 2 it is 402, nothing queued:

```json
{ "error": "Basic includes 2 homes. Choose Growth or Business in Billing to add more.", "code": "HOME_LIMIT", "homes": { "used": 2, "covered": 2 }, "quote": { "plan": "free", "currency": "USD", "homes": { "used": 2, "drafts": 0, "included": 2, "additional_price_minor": 900, "amount_minor": 0 }, "adding": { "count": 1, "additional_homes": 1, "amount_minor": 900, "allowed": false }, "billing": { "period_end": null, "trial_end": null, "prorated": false } } }
```

`quote` is the homes quote (§3.1) with `adding` the increase. Otherwise 202 with the named listings as `GET` returns them; each replaces any earlier request for that listing. 422 `VALIDATION_ERROR` when it names nothing or names a listing in both; 404 `LISTING_NOT_FOUND` (`listing_id`) for a listing not on the account, 404 `IMPORT_NOT_FOUND` (`product_id`) for a home not imported from it.

**Progress.** `GET /api/organizations/:id/integrations/airbnb/sync`, owner or admin:

```json
{ "listings": [
  { "listing_id": "39313043", "product_id": "8d0c…", "action": "sync", "status": "running", "stage": "content", "error": null, "attempts": 0, "next_attempt_at": null, "updated_at": "2026-10-23T07:20:00.000Z" },
  { "listing_id": "40112808", "product_id": null, "action": "sync", "status": "failed", "stage": null, "error": { "code": "MISSING_DETAIL", "message": "zipCode is required" }, "attempts": 1, "next_attempt_at": null, "updated_at": "…" }
] }
```

- `status`: `queued` (waiting its turn), `running` (being worked on, or its import is between stages; `stage` says where), `done`, `failed` (needs a new request). `product_id` is the home once it exists; `stage` is its import stage, `null` before the home exists.
- `error` is the last failure's code and message. A transient failure (the network, a provider answering 5xx or 429, or `AIRBNB_UNAVAILABLE`: Airbnb failing behind Channex) is retried on its own, after 30 s doubling up to an hour, 8 attempts in all: meanwhile the listing stays `queued` or `running` with that `error`, its `attempts` and `next_attempt_at` (the next retry; `null` when none is due). Any other failure is `failed` until a new request names the listing: `MISSING_DETAIL` (a field Airbnb leaves out that the request's `details` and the organization's contact do not fill; send it in `details`), `ONLY_MISSING_DETAILS`, `INVALID_DETAIL`, `CURRENCY_MISMATCH`, `MISSING_AIRBNB_FIELD`, `LISTING_NOT_FOUND`, `LISTING_LINKED_ELSEWHERE`, `HOME_LIMIT`, `PROVIDER_VERIFICATION_FAILED`, `CONNECTION_NEEDS_REVIEW`, `REQUESTER_REMOVED`.
- A listing's home found partway (an import or activation that stopped at any stage) is carried on from that stage.
- The work runs on KrabiClaw: the request queues it, and a task every two minutes picks it up and carries it on, a few photos per step, until each listing is `done` or `failed`. The app needs to stay open for none of it, and can show progress by reading `GET`. `GET …/integrations/airbnb/listings` and listing details stay readable while the sync runs.

`GET …/integrations/airbnb/listings/:listingId` stays: the listing's details and `missingFields`, for the app's review before a sync. The step-by-step routes (`…/listings/:listingId/import`, `…/imports/:productId/advance`, `activate`, `deactivate`) are removed: the sync request replaces them.

**Channex failures.** Every Airbnb route answers a failed Channex call with the coded error: 502 (504 when a background slice ended first) with `message` and `data` `{ code, field, uncertain, provider_status }`, where `provider_status` is Channex's own status. `AIRBNB_UNAVAILABLE` is Airbnb failing behind Channex (Channex answers 422 with Airbnb's own 5xx, "Airbnb may be undergoing maintenance … Please try again"); `CHANNEX_REQUEST_FAILED` is any other answer Channex refused; `INVALID_PROVIDER_RESPONSE` is an answer KrabiClaw cannot read.

**Listing rows.** Each `GET …/integrations/airbnb/listings` row is `{id, title, city, country_code, import}`, with `import` either `{"status": "not_imported"}` or:

```json
{ "status": "imported", "product_id": "8d0c…", "stage": "complete", "syncing": true, "content": { "photos_imported": ["…"], "photos_skipped": [], "photos_upgraded": [], "photos_removed": [], "photos_unplaced": [], "unmatched_amenities": [], "unmapped_check_in_category": null, "truncated_fields": [], "photo_rooms_skipped": 0, "kept_host_edits": [] } }
```

`syncing` is whether the listing syncs with Airbnb now (its mapping is enabled): `false` at `draft`, `true` at `complete`, either while in progress. `content` is `null` until the content stage has finished. `kept_host_edits` (new, absent from reports written before it) lists fields the host changed in KrabiClaw since Airbnb's value was last written, which a content refresh kept as the host has them.

**Stopping a listing** (a `stop`) removes this listing's rate plan mapping from the Airbnb channel (`DELETE /channels/{channel}/mappings/{mapping}`, which Channex passes on to Airbnb), uninstalls the property's Channex Messages app, and moves the import back to `draft` with the mapping disabled. The channel stays active for the account's other listings; the home, its photos, texts, rates, calendar and stays are kept, and a later `sync` makes it live again.

**One stay per reservation.** A channel booking lands on the stay with its Channex booking id or, failing that, the stay with the same channel reservation code (Airbnb's confirmation code: Channex `ota_reservation_code`, stored as `channel_booking_id`). Re-importing a listing, as after moving to another Channex account, therefore updates the existing stays: each keeps its `id` and conversation and takes the new booking id, instead of a second, overbooked copy. The database refuses two stays of one organization with the same channel and reservation code. Its Airbnb conversation follows it, whether the new account's thread or booking arrives first: the conversation keeps its request id and timeline and takes the new thread as its address (the old account's thread id is kept as `moved_from_thread_id` on `channel_threads`). The history the new account delivers again under its own message ids is not recorded twice: on a moved conversation, a message with the same sender, Airbnb timestamp, text and attachment count as one already mirrored is that message. Replies go to the new thread.

### 3.5.1 What an edit sends to Airbnb

Editing a home that syncs with Airbnb (`PATCH /api/dashboard/stay-homes/:productId`, the product editor, MCP) sends what Airbnb takes through Channex, right after the save:

| KrabiClaw field | Airbnb (through Channex) |
|---|---|
| `check_in_time` | booking settings `check_in_time_start`, whole hours "8"–"26" (a start from 00:00 to 02:00 is the next day, "24"–"26") |
| `check_in_end_time` | `check_in_time_end`: `null` is "FLEXIBLE"; an end earlier than the start is the next day (up to "27") |
| `check_out_time` | `check_out_time`, the hour |
| `pets_allowed`, `smoking_allowed`, `events_allowed` | `guest_controls` `allows_pets_as_host`, `allows_smoking_as_host`, `allows_events_as_host`, when set |
| `cancellation_policy` | `cancellation_policy_category`: flexible → `flexible`, moderate → `moderate`, limited → `firm_14`, firm → `better_strict_with_grace_period` (Airbnb's options of the same title and wording). Airbnb offers no Strict: setting `strict` on a home syncing with Airbnb is refused before it is saved, 422 `AIRBNB_UNSUPPORTED_VALUE` with `field: "cancellation_policy"`. |
| `long_term_cancellation_policy` | `lts_cancellation_policy_id`: firm → `CANCEL_LONG_TERM_FAIR`, strict → `CANCEL_LONG_TERM_WITH_GRACE_PERIOD` |
| `min_nights` | availability settings `default_min_nights` (each night's own minimum goes with the nightly calendar, as before) |

A value Airbnb cannot take (a time with minutes, a start before 08:00 that is not after midnight) is saved and not sent: 503 `CHANNEL_PUSH_FAILED` with `committed: true` and the reason, as a calendar push failure is. Prices are not sent as listing settings: every night's price (the base price for nights without their own) already reaches Airbnb with the nightly calendar, and Airbnb's default nightly price takes whole amounts only. KrabiClaw has no field for weekend price, extra-guest price, fees, maximum nights by default, booking lead time, instant book, children, infants or pet count, or Airbnb's listed/unlisted state, so none of them is sent; `published` is the home on the KrabiClaw site, not on Airbnb.

**Nightly calendar delivery.** A save that changes nights of a home synced through Channex answers `channel_push` as one of: `null` (nothing to send), `{ "state": "pushed", "detail": null }` (Channex confirmed it), or `{ "state": "pending", "detail": "…" }`: the change is saved and queued in the delivery outbox, and `detail` says why it has not gone yet. Each night's `channel` on the calendar (`GET …/stay-homes/:productId/calendar`, `PUT …/nights`) reads `pending` with the same reason until Channex confirms it, then `pushed`. A pending night's `detail` may be `null` for a moment while another delivery for the home is sending; every other `pending` and every `needs_review` carries one.

- **Why a night waits.** One delivery runs per Channex property at a time. Channex takes 10 restrictions and 10 availability calls per property per minute; a night whose call would exceed that waits for the window. A 429, or a call Channex did not confirm (5xx, the network, an unreadable answer), pauses the property for a minute, then 2, 4, 8 … up to an hour per further attempt. Such a night stays `pending` with the attempt and the time it goes next, until Channex confirms it or the night passes; a further change to it while it waits keeps that time and goes with the retry. The `channex-ari-delivery` task sends due pending nights every two minutes and publishes `nights.changed`, so the calendar and the iOS app refresh when a pending night lands.
- **`needs_review`.** Only a refusal that a retry would not change: Channex answering 4xx (other than 429) to the call, or a 200 whose `meta.warnings` names the night (by its echoed `date` or `date_from`/`date_to`; a warning that names no dates covers every night of the call), with Channex's reason in `detail`; a night that has no nightly price (its availability and rules are still sent); or a pending night that passed before Channex confirmed it. A refusal during the save is 503 `CHANNEL_PUSH_FAILED` with `committed: true`. A later change to the night queues it again.
- **What is sent.** Only the values that differ from what Channex last confirmed for each night, contiguous nights with the same change as one `date_from`/`date_to` range, in at most one restrictions and one availability call per home. A booking, checkout hold or linked calendar changes availability alone (0 while the night is taken, 1 when free). A host closing a night sends `stop_sell: true` alone, and opening it `stop_sell: false` alone, in one restrictions call; availability does not move for a closed night. A price or stay-rule change sends restrictions alone. Airbnb has one arrival minimum: a nightly override or the home's required `min_nights`, sent as `min_stay_arrival`. The home default is imported from the live listing's `availability_rules.default_min_nights`, never from the first calendar day. Full delivery verifies Channex's arrival mode and configures the rate plan's rolling defaults from the canonical home minimum and price; no guest quote reads Channex. Nothing is sent on a timer; a full calendar sync (500 nights, one call of each kind) happens when a listing is imported, when a stopped home syncs again, or when a host requests a resync. An enabled home's resync first refreshes protected imported content, preserving fields whose current value differs from the previous imported value, then pushes the canonical calendar. A legacy minimum without an import fingerprint is preserved.


### 3.5.2 What stays Airbnb's

Channex cannot write a listing's title, description, photos, amenities, guest count, check-in method, wifi, directions or house manual. They stay editable in KrabiClaw for the KrabiClaw site. A save that changes one of them on a home syncing with Airbnb answers which, with where to make the same change on Airbnb; `airbnb_unsynced` is always present, `[]` when nothing applies:

```json
{ "home": { "…": "…" }, "channel_push": null, "airbnb_unsynced": [
  { "field": "description", "airbnb_url": "https://www.airbnb.com/hosting/listings/editor/39313043/details/description" },
  { "field": "wifi", "airbnb_url": "https://www.airbnb.com/hosting/listings/editor/39313043/arrival/wifi-details" }
] }
```

`field` is one of `name` (`/details/title`), `description` (`/details/description`), `photos` (`/details/photo-tour`), `amenities` (`/details/amenities`, from `amenities` or `amenity_answers`), `max_guests` (`/details/number-of-guests`), `check_in_method` (`/arrival/check-in-method`, from `check_in_method` or `check_in_instructions`), `wifi` (`/arrival/wifi-details`, from `wifi_network` or `wifi_password`), `directions` (`/arrival/directions`), `house_manual` (`/arrival/house-manual`). Routes that carry it: `PATCH /api/dashboard/stay-homes/:productId` (`{home, channel_push, airbnb_unsynced}`), and `POST`/`PUT …/photos`, `PATCH`/`DELETE …/photos/:photoId` and `PUT …/photos/move` (`{home, airbnb_unsynced}`). Every home carries `airbnb_listing_id` and `airbnb_editor_url` (`https://www.airbnb.com/hosting/listings/editor/<id>/details`), both `null` for a home not imported from Airbnb. A content refresh from Airbnb never overwrites a field the host changed here: it writes only fields still holding what the last import wrote, and lists the others in `kept_host_edits`.

### 3.6 Payouts

Stripe Connect payouts onboarding from the app, after the host chooses Business, on the dashboard's own Connect routes. Each names the organization with `?org=<slug>` and needs an owner or admin with the payments integration permission. Refusals carry a code at `data.code`, e.g. `{"status": 409, "statusText": "Stripe onboarding has not started", "message": "Stripe onboarding has not started", "data": {"code": "CONNECT_NOT_STARTED"}}`.

- `POST /api/dashboard/connect?org=<slug>` `{"country"?: "US", "returnTo"?: "app"}` creates the organization's connected account on first use and answers 200 `{success: true, account, onboardingUrl}` (`account` is the `StripeConnectedAccount` below; `onboardingUrl` is Stripe's hosted link). A cookie session must be a same-origin browser request; the app's bearer session (an `Authorization: Bearer` header and no cookie) needs no `Origin`. `country` is optional: Stripe's hosted onboarding asks for it when it is absent. With `returnTo: "app"` Stripe returns to `https://<platform>/app/return/payouts?outcome=done` when the host finishes and `…?outcome=refresh` when the link expired; Stripe takes only https return addresses, so that page redirects at once to `krabiclaw://payouts/done` or `krabiclaw://payouts/refresh` and shows a "Return to the KrabiClaw app" link. On `refresh` the app asks for a new link. Without `returnTo` the dashboard's Payments return applies. Codes: 503 `CONNECT_NOT_CONFIGURED`, 409 `ACCOUNT_EMAIL_REQUIRED`, 422 `VALIDATION_ERROR` (`field: "returnTo"`), 502 `STRIPE_ONBOARDING_FAILED` (Stripe's own message).
- `POST /api/dashboard/connect/status?org=<slug>` refreshes the account from Stripe and answers 200 `{success: true, account}`; 409 `CONNECT_NOT_STARTED` before onboarding, 502 `STRIPE_STATUS_FAILED`.
- `GET /api/dashboard/connect?org=<slug>` answers `{success: true, account, payout}`: `account` is `null` before onboarding; `payout` is `{bankName, last4, currency, schedule: {interval, delayDays}}` once the account is `ready` and has a bank, else `null`.
- `GET /api/dashboard/connect/countries?org=<slug>` answers `{success: true, countries}`, the countries Stripe can create the business's account in, for the country choice before onboarding. Stripe answers it slowly, so read it only where a country is chosen.

```json
{
  "id": "…", "organizationId": "…", "stripeAccountId": "acct_…", "country": "US", "livemode": false,
  "status": "action_required", "cardPaymentsStatus": "pending", "surchargeBasisPoints": null,
  "requirements": [{ "awaitingActionFrom": "user", "deadlineStatus": "currently_due", "description": "Provide a bank account for payouts", "errors": [] }],
  "stripeRefreshedAt": "2026-10-23T03:00:00.000Z", "lastError": null, "createdAt": "…", "updatedAt": "…"
}
```

`status` is one of `creating`, `creation_failed`, `action_required`, `pending_review`, `restricted`, `ready`; `cardPaymentsStatus` one of `active`, `pending`, `restricted`, `unsupported` or `null`.

### 3.7 Plans

`GET /api/billing/plans` lists `free` (no prices), `growth` and `business`, each paid plan with exactly one price `{id, amount, currency: "usd", interval: "month"}`. Every plan is monthly; there is no annual price and no `annual` checkout.

## 4. Deletion and membership changes

Every step fails the operation visibly; nothing is skipped.

- **Organization deletion** (`beforeDeleteOrganization`, after Better Auth Stripe's subscription guard; `cleanupOrganizationBeforeDelete` in `server/utils/tenant-deletion.ts`): Payments servicing links are retained; the Airbnb connection is released in Channex (`AirbnbConnection.deleteForOrganization`: rate-plan mappings removed one at a time and verified, the channel deactivated and deleted, every property in the organization's dedicated group deleted with `force=true`, then the group, each verified gone by a 404); Google Calendar cleanup is staged; custom domains and Cloudflare Images the organization alone holds (home, guest and team message photos) are deleted. Every lodging row — stays, nights, channel mappings and threads, guest threads, scheduled messages, message templates, team threads, seats and messages — cascades with the organization row.
- **Account deletion** (`user.deleteUser.beforeDelete`; `/api/auth/admin/remove-user` is disabled because it bypassed this): sole-owner guard (400 `SOLE_ORGANIZATION_OWNER`); Apple code exchange and immediate revocation (`APPLE_REAUTHENTICATION_REQUIRED`, `APPLE_ACCOUNT_MISMATCH`, `APPLE_CODE_EXCHANGE_FAILED`, `APPLE_NOT_CONFIGURED`, `APPLE_REVOCATION_FAILED`) (D6). Then, in the user delete hook after Stripe buyer customers are removed, the homes the account's members looked after are released. Sessions, device tokens, member rows and their thread seats cascade with the user; team messages the user sent keep their text with the sender set to null.
- **Member removed or left, or Team deleted**: dangling location, offering and home responsibility is cleared through the shared reconciliation and published to open views; thread seats cascade with the member row. **Role changed to owner or admin**: explicit responsibility remains. Recorded booked providers remain historical attribution. `reconcileResponsibilities` reconciles departed targets across the organization on membership changes.

### 4.1 Reports and blocked guests

A member reports a guest conversation or another member's team message with a reason of 1 to 1000 characters (422 `INVALID_REPORT_REASON`, `field: "reason"`); their own message is 422 `OWN_MESSAGE`. Blocking a guest files the same report with `blocked` and sets the thread's `blocked_at`: the thread leaves Current and Past (and every list sent without `mailbox`) for `mailbox=blocked`, its detail and rows carry `mailbox: "blocked"` and `blockedAt`, and new messages from the guest are still recorded but alert nobody. `unblock` clears `blocked_at` (409 `INVALID_TRANSITION` when not blocked); the report stays filed. The guest's own view never shows the block.

Each report is emailed to `PLATFORM_OWNER_EMAILS` before the request succeeds; a failed send is 502 `CONTENT_REPORT_EMAIL_FAILED` with `committed: true`, and the retry with the same key files nothing new. Platform staff decide reports at `/dashboard/<platform>/platform-reports` (Better Auth admin with `platform:support` and `user:ban`; `GET /api/dashboard/platform-reports?status=open|removed|dismissed`, `POST /api/dashboard/platform-reports/:reportId/resolve` `{decision: "remove"|"dismiss"}`). Remove deletes a team message and its photo placements, or blocks a guest conversation, and bans the author's KrabiClaw account through `auth.api.banUser`; an Airbnb guest has no account to ban.

## 5. Decisions

- **D3 Existing-account entry and linking.** Native email+password for existing accounts, then explicit Apple linking. `apple` is not a trusted provider; no email auto-linking.
- **D4 Invitations.** KrabiClaw invite links under KrabiClaw's permission model, because Better Auth email invitations cannot target an Apple private-relay address the inviter does not know.
- **D5 Vertical and site.** `lodging` is in `ALL_VERTICALS` and the Saya template; `vertical` is written only by `provisionOrganization`.
- **D6 Deletion semantics.** Owned-organization guard and Apple token revocation in `user.deleteUser.beforeDelete`, using a fresh authorization code the app sends; Better Auth's Apple provider has no `revokeToken` and the idToken sign-in stores no Apple tokens.
- **D7 Profile photo.** `POST /api/user/avatar`.
- **D8 Support impersonation.** Platform `admin` only, 900 s.
- **D9 Local development identity.** Debug builds sign in to KrabiClaw staging with email and password using the staging development accounts the owner created; agent sessions do not create accounts or enter passwords.

### Native payment settings and payout history

The iOS app and dashboard share the organization-scoped payment routes. `POST /api/dashboard/connect/dashboard` and `POST /api/dashboard/connect/surcharge` accept the existing cookie-free Better Auth bearer session through `requireFinancialBrowserOrAppRequest`; cookie sessions still require the same origin. Both retain `payments:integration` authorization and tenant scope. The dashboard operation returns a fresh HTTPS `{url}` for the connected account's Express Dashboard; iOS opens it in a system browser and re-reads account state when dismissed. No provider secret is returned.

`GET /api/dashboard/connect` additionally returns `surchargePolicy: {surcharge, minimumBasisPoints, maximumBasisPoints}` from shared platform policy. The payout bank is the sole bank Stripe marks `default_for_currency` for the Stripe account's explicit default currency. No banks means the optional payout method is null; nonempty banks without exactly one matching default produce `PAYOUT_BANK_INVALID` with field context. Invalid schedule data produces `PAYOUT_METHOD_INVALID`. Historical payout details use only that payout's actual destination, never the current default bank; missing destinations produce `PAYOUT_DESTINATION_MISSING`.

`POST /api/dashboard/connect/surcharge` requires an explicit `basis_points` (integer within the returned bounds, or null to turn off); omission/invalid input produces `VALIDATION_ERROR` with field `basis_points`. The provider continues to determine per-card eligibility and the actual surcharge.

`GET /api/dashboard/payments/billing` is readable by `payments:integration` roles and adds `terms: {fee, source: "offer" | "subscription", stripe, billing, surcharge, minimumBasisPoints, maximumBasisPoints}`. A workspace without Business gets the published offer, explicitly marked `offer`; Business gets its actual subscription's captured-volume rate. Missing Business subscription or metered prices fails with `PAYMENT_PRICING_UNAVAILABLE`/`PAYMENT_PRICING_INVALID`, never the offered rate. `GET /api/billing/plans` adds `paymentFee` (the canonical published fee for Business; null otherwise), also used by native upgrade copy.

`GET /api/dashboard/payments?view=payouts&org=<slug>&after=<optional cursor>` is the canonical paginated payout history, including configured state, balance, Stripe payout rows and nullable `next_cursor`. `view=payout&payout_id=<id>` returns its actual destination and attributable platform payments. Automatic payout transactions are fully paginated at Stripe; an unmatched required transaction/source errors instead of substituting the recorded gross amount. iOS shows upcoming, sent, failed and cancelled rows, separates currency totals, exports loaded paid rows and opens the canonical payment detail for each attributed payment.
