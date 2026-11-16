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

- `corepack yarn build`, then the built worker: `wrangler dev .output/server/index.mjs --env e2e --persist-to .wrangler/e2e-state-3478 --port 3478` (`yarn dev` fails with a D1 session-token error). Do not start a second worker if port 3478 is in use.
- Sign in by `POST /api/auth/sign-in/email` as `lodging-host@playwright.example` (owner of `e2e-stays-483c853d`) or `buyer@playwright.example` (guest), with the E2E fixtures' shared password.
- Local data: home "Assigned Cabin" (`b3d94a99-…`) has a flexible cancellation policy and a full arrival guide. Stay `1e79ee14-16bf-4a41-8eac-d3fba709b2f0`, conversation `d0792f73-7dff-4562-991a-a020380ce04a`, was made before the policy change, so make a new stay to see the policy. The buyer is invited to that conversation.
- Scripts: `.wrangler/setup.mjs` (fill home, create stay), `.wrangler/shots.mjs` (host and guest screenshots plus panel text).

## Done on the branch (seen locally unless marked)

- Range caps, Move guest, calendar city/"No upcoming stays" filters, "All activity" picker deleted; Insights charts are bars.
- Jobs always assigned; job card in the team conversation with Done; job reminders stored in the outbox (`scheduled_guest_messages.task_id`, migration 0011) and sent by the hub alarm; the 2-minute cron deleted.
- `jobs.changed` queue event replaces inline job posting in booking writes.
- Conversation in three panes with the reservation beside it (`reservation/:record_id` under the conversation); In this conversation sheet; ChannelMark on avatars.
- Reservation panel for a stay in Airbnb's order (`components/dashboard/BookingDetails.vue`, `v-if="stay && panel"`); Payment info wording; Change reservation and Record a payment step pages.
- No-show action deleted for every vertical (server, routes, MCP, UI).
- NOT YET BUILT OR SEEN (last commit): host and guest read one home shape (`BookingHome = GuestStay['home'] & …`), same "Hosted by", Wi-Fi, safety, checkout list; host-entered stays book under the home's cancellation policy; "Confirmed" badge and floating Message button removed for stays; title "Reservation" for the guest.

## Not done (all required in this branch)

Reservation panel parity
1. Rebuild, screenshot host and guest beside the Airbnb reference, compare line by line.
2. Text sizes are larger than Airbnb's (Airbnb: title 22px, section heading 18px, labels 14px, sub-lines 12px).
3. Add a home photo locally and check the photo block.
4. Guest: `/dashboard/account/messages/:conversation` redirects to `/dashboard/account/activity/stay/:id` and shows Past activity on the left. The guest must get the conversation with the reservation beside it, as the host does (mount in `build/booking-routes.ts`).
5. The line "This conversation is about a reservation. Show reservation" sits under the header; Airbnb's is a line in the thread.
6. Classes, consultations and tables still use the old card layout (`v-else` block). Move them onto the same panel block.
7. Gallery in In this conversation never seen rendered.
8. Calendar grid should use `ChannelMark`; remove the booking mount beside Today and point Today/Calendar/notification links at the conversation.
9. `bookings.no_show_at` column and its readers remain (dropping it rebuilds the bookings table).

Speed and events
10. The `jobs.changed` consumer re-reads the whole business; it should handle only the job that changed. Existing open jobs must be posted quietly on first pass.
11. A stay write still plans guest messages and pushes nights to Channex inline (`publishCreatedStay`). Move both to the queue; measure a booking write before and after.
12. Delete Vrbo iCal calendar links entirely (`stay_calendar_links`, calendar-link routes); Vrbo is Channex only.
13. Delete the Channex backup feed poll (`channex-revision-feed`) and the old `krabiclaw-guest-delivery*` queues.
14. Move to webhooks: Stripe fee report (report-run webhooks), Cloudflare custom-domain status (check Cloudflare for SaaS webhook docs), ad spend (Meta ad-account webhooks; verify Google Ads). Google ratings stay scheduled with a comment saying never to copy the method.
15. Remaining timers to replace with events or exact-time wakes: public-resource-cache-invalidation, google-calendar-sync, channex-ari-delivery, airbnb-sync, stay-checkout-holds, review-request-automation, domain-reconciliation, stripe-ga4-intent-retention, marketing-ad-spend-daily. Replace `waitUntil` handoffs with the queue.

Last
16. Tests are stale and have not been run since the queue change (`cleaner-jobs-d1`, `stays-d1`, `team-messages-d1`, `today-reservations-d1`, E2E `stays`, `dashboard-layout`, `native-consultations`; anything asserting no-show). Update once, after the code is finished.
17. iPhone branch `claude/unread-dot` in `~/Repos2026/bookyboo-ios-messages-release` compiles but has never been run; it ships with this change.
18. Production has 21 open jobs with no job conversation; nothing is written to production without the owner's instruction.
