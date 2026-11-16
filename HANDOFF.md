# Handoff: branch `claude/jobs-always-assigned` (draft PR, do not merge)

Checkout: `~/Repos2026/krabiclaw-today-speed`. Read `CLAUDE.md` first; it governs. Delete this file before the PR is marked ready.

## The owner's rules (all binding; each was stated after a failure)

**Speed**
- A screen reads stored rows. The write that changes something keeps the stored state current. Never recompute on a page view.
- Add no D1 round trips. Before/after any change to a read or write path, count statements and round trips and say the numbers.
- The revenue path (a booking write) does no notification, job, reminder or channel work inline. That work goes on the Cloudflare Queue `EVENTS` (`server/events.ts`, `server/plugins/cloudflare-queue.ts`).
- No polling, crons or timers. Provider webhooks and queue events only; a clock-time send uses the business hub's alarm at the exact due time (`sendDueOutbox`). `waitUntil` handoffs are not acceptable; use the queue.
- Parallelising or batching the same work is not a fix. Delete the work.

**Deletion and one path**
- Order: delete, reuse, modify, add. A refactor removes what it replaces in the same change.
- No fallbacks, guards, compatibility branches, range caps, retries or second implementations. One component and one reader per concept; a host/guest or per-vertical variant is a prop on the one component, never a second path.
- Every feature ships for stays, classes/experiences, consultations and restaurants together. A stay-only change is unfinished.
- A job is never unassigned: the default assignee is the owner, enforced at the write (`jobAssigneeSql`).
- Nothing is deferred. No follow-up PRs, no TODOs, no "later". Everything goes in this branch.

**Parity with Airbnb**
- Match Airbnb exactly: order, wording, dividers, sizes. Use Airbnb's words, never invented explanatory copy.
- Compare line by line yourself before showing anything. Screenshots go side by side with the reference: `~/Documents/krabiclaw-research/airbnb-messages-reference/` (reservation panel, In this conversation modal).
- Airbnb has no "Confirmed" badge, no "Mark as no-show", no "Move guest". Do not add what Airbnb lacks.

**How to work**
- Look in a local browser like a person. Tests are not evidence. Do not run, write or fix tests until all code is finished and seen locally; then update them once.
- Do not merge to staging and do not promote. The owner approves merges.
- Reports are lists only: Done / Not done / Questions / local screenshots (side by side) / where the work breaks the speed and deletion rules. No prose. Do not stop to report when there are no questions.
- A question from the owner is not a request to change code.

## Local run

- Build with `corepack yarn build`. Run the built Worker with `corepack yarn wrangler dev .output/server/index.mjs --env e2e --assets .output/public --persist-to .wrangler/e2e-state-3478 --port 3478`. Use the localhost URL overrides in `playwright.config.ts` for port 3478. The Better Auth, platform and media URL overrides are needed for this port.
- Use the existing `lodging-host@playwright.example` and `buyer@playwright.example` fixtures with the fixture password. The Assigned Cabin fixture has a cover image, Flexible cancellation and a full arrival guide.
- Use stay `a91eb383-eead-40b5-95e3-00a2bd04be35`, conversation `cb05c00c-9493-400e-99e1-5dac8234383e`. As host, open `/dashboard/e2e-stays-483c853d/messages/<conversation>/reservation/<stay>`. As guest, open `/dashboard/account/messages/<conversation>`. The guest can close the panel and reopen it from Show reservation in the thread. This thread contains a Gallery photo.

## Done

- Jobs default to the owner. The queue consumer receives task IDs from the write and loads only those jobs and the conversations they concern. A local booking produced one assigned turnover with a team message and two reminders. The same booking produced pending check-in instructions.
- Offline stay writes pass guest-message planning and Channex inventory publication to EVENTS. Matched three-night local dashboard POSTs returned 201 before and after. D1 statements fell from 54 to 33 and batch round trips from 7 to 4.
- Host and guest use the same stored home reader. Fixed the host detail query's missing-column error and removed the timed panel's live Google free/busy lookup. The shared layout rendered on both sides for the stay and on the host side for a class, a Family Law consultation and a table. The same guest stay read fell from 41 to 15 D1 statements and from 6 to 0 batch round trips. Both stay panels showed the cover, assigned host, Flexible policy and Wi-Fi. The conversation Gallery rendered and opened the uploaded photo.
- Today and Calendar links open the reservation's conversation for participants. Staff with reservation permission retain a standalone reservation route when they have no conversation seat. Calendar uses ChannelMark. A local calendar reservation link opened the conversation and its panel.
- Removed the Vrbo iCal storage, poll, calendar overlays and endpoints. Local upgrade applied migration 0012 and `PRAGMA foreign_key_check` returned no violations. Booking and checkout night claims survive the migration. Before applying this to a deployed database, verify that any future iCal-only claims have corresponding Vrbo reservations through Channex.
- Removed the scheduled Channex backup feed. The booking and `non_acked_booking` webhooks use the same revision reader and acknowledgement. Configured Channex targets need the updated event mask before deployment.
- Replaced the Stripe fee-report schedule with the platform `reporting.report_type.updated` webhook. The endpoint must explicitly subscribe before deployment and still needs signed availability and completion delivery verification.
- Replaced MCP and public-help `waitUntil` telemetry publication with redacted EVENTS messages. Queue diagnostic payloads use an explicit size budget. Confirmed that a local tools/list returned 167 tools and persisted its queued audit row. The E2E Worker lacks the Cloudflare AI Search binding, so the public help request returned 500 and persisted its queued error row. Checkout hold inventory publication and cancelled payment hold release also use EVENTS.
- The companion `claude/unread-dot` iOS branch now removes the retired iCal, no-show and Move guest paths and uses the timed change endpoints. Commit `a148d3b` is local in `~/Repos2026/bookyboo-ios-messages-release`. It built and opened the sign-in screen on an iPhone simulator.

## Open

- The Airbnb comparison still differs on features such as the listing-photo carousel, guest management, visa PDF, and business-trip and support actions. Signed-in iPhone Messages and physical-device verification are open.
- Complete the remaining event conversions for cache invalidation, Google Calendar, Channex ARI and Airbnb sync steps, checkout and pending-stay expiry, review invitations, Stripe GA4 and MCP retention, custom domains, and ad spend. Google Places ratings are the scheduled exception. Cloudflare documents certificate deployment events, and its readiness check separately requires hostname activation and customer DNS cutover. Google Ads and Meta document spend reporting reads, and equivalent delivered daily spend events have not been verified.
- Check Channex reservation revision recovery and Airbnb withdrawal behavior with provider fixtures. Channex ARI and Airbnb sync job state do not store an exact retry time today. The current schedules still run.
- The old deployed guest-delivery queues and quiet backfill for the 21 existing production jobs require owner-directed production operations. An existing-job backfill can use scoped `jobs.changed` messages with `task_ids` and `quiet: true`.
- The remaining no-show reads protect historical review eligibility. The booking column is still part of a CHECK on a referenced D1 parent table. Use the existing replacement-database workflow and validate that historical stamps have the matching `booking.no_show`, `stay.no_show` or `reservation.no_show` transcript event before dropping the column and changing the review reader.
- Timed visit notifications and some payment and provider notifications still run inline. Web checkout hold queueing, successful public-help delivery and telemetry redelivery need boundary verification. The draft's unit and E2E specs remain stale and have not been updated or run locally.
- The web build, quality checks, migration lint and schema drift check passed locally. Keep this PR in draft. Delete `HANDOFF.md` before marking it ready.

## Retired routes

- `GET`, `PUT` and `DELETE /api/dashboard/stay-homes/<product>/calendar-link` return 404. Vrbo uses Channex.
- `GET /api/public/stay-calendars/<token>.ics` returns 404. The iCal feed is retired.
