# Handoff: branch `claude/jobs-always-assigned` (draft PR, do not merge)

Checkout: `~/Repos2026/krabiclaw-today-speed`. Read the repository agent instructions and local development guide. Delete this file before the PR is marked ready.

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
- The owner stopped iPhone verification. The server owns booking and conversation data, permissions, and actions. The native client renders those records with SwiftUI layouts.

## Local runtime

- Guest Messages auto-opens the reservation in the thread. The correct guest route is `/dashboard/account/messages/<conversation>/reservation`. Host routes retain the booking ID as the final segment.
- Browser verified the two-photo carousel, reservation pane wheel scrolling with the outer page fixed, check-in Wi-Fi, checkout instructions, and opening a photo in Gallery. Opened the host stay, class, Family Law consultation and table panels.
- The same offline stay write returned 201 with 33 D1 statements and four batch round trips. Its queue delivery persisted one assigned turnover, one team post, two pending reminders, and one pending guest message. Local upgrade applied migration 0013. `PRAGMA foreign_key_check` returned no violations.
- Across targeted D1 runs, 124 cases passed after reruns. The optional live Resend transport test skipped. The table Calendar and buyer booking-change browser regressions passed.
- Use `--local` to turn off remote bindings for local verification. In a runner without the repository's dev variables, pass the local auth, Stripe test and email reply fixture bindings explicitly. Email and WhatsApp stay in log-only mode.

## Event cutover

- Booking creation and status changes, timed changes, stay changes, checkout expiry, and Stripe and Channex follow-up delivery use scoped events. Business wakes cover checkouts, review invitations, Google Calendar pending expiry, Channex ARI, managed ad spend, and retention.
- Cache and Calendar writes wake scoped consumers. Airbnb import jobs use their persisted job ID and queue continuation when Channex reports a provider step still pending. ARI retries the saved pending nights and schedules the next priced weekend date at the home's local midnight.
- After deploying a consumer, send `business.deadlines_backfill`, `site.cache_backfill`, `calendar.backfill`, and `ad_spend.backfill` once. The draft did not send these to any deployed queue.
- Before deployment, confirm Channex webhook event masks, Stripe platform report webhook subscription, and Vrbo reservations migrated from old iCal feeds. The old deployed queues and quiet backfill for the 21 existing production jobs require owner-directed operations.

## Follow-up on the draft

- The buyer can issue and revoke guest invitations from the shared reservation panel. A verified companion gets the conversation. Buyer removal uses the invitation ID, and hides the companion account ID. Host and co-host names, photos and bios use existing public member profiles and listing participants. A messaging-only member can still use the thread and roster. Opening a reservation requires the same booking access as the detail endpoint.
- A confirmed stay can print or save an itinerary PDF with the booking location, dates, reference, party size, host and optional traveler names. The reservation read and PDF use the same stored data, with no extra network request for the PDF.
- Local Chromium scrolled the entire guest and host stay panels and the host panels for a class, a Family Law consultation and a table. The buyer issued a link, the recipient accepted it, and buyer revocation removed the recipient’s conversation access. Browser output was checked as a one-page PDF.
- Custom domain setup uses the existing Queue. Connect, Check DNS, Retry and authenticated Cloudflare custom hostname certificate notifications check only the matching domains. For a hostname with a prevalidated certificate, the owner uses Check DNS after updating their records. Activate a domain only when DNS points to the SaaS destination and both provider statuses are active.
- Historical no-show review checks read the original booking conversation events. Migration 0014 verifies that the old stamps and the conversation events agree. The local v28 replacement transferred all 97 application tables and 20 media references, with an empty foreign-key check and no `no_show_at` column.

## Deployment verification still required

- Staging passed health and refused unsigned Stripe and Channex deliveries. Its deployed commit predates this draft. Channex needs the updated event mask. The Stripe staging test endpoint is missing `reporting.report_type.updated`, and its fee report type returned 404 in test mode. Replay signed provider deliveries on the intended configuration after the owner authorizes the staging merge.
- Configure the SSL for SaaS Custom Hostnames notification to POST to `/api/integrations/cloudflare/custom-hostnames/webhook`. Cloudflare’s webhook secret must match `CF_CUSTOM_HOSTNAMES_WEBHOOK_SECRET` and the sender must match `CF_ACCOUNT_ID` and `CF_ZONE_ID`. Configure the provider destination once the receiver is deployed.
- The draft still binds v27. Use the repository’s Western North America replacement workflow and run the historical preflight on the target environment before changing the binding.
- Keep the PR in draft. Delete this handoff before marking it ready.

## Retired routes

- `GET`, `PUT` and `DELETE /api/dashboard/stay-homes/<product>/calendar-link` return 404. Vrbo uses Channex.
- `GET /api/public/stay-calendars/<token>.ics` returns 404. The iCal feed is retired.
