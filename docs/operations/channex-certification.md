# Channex PMS certification

Authority: [PMS certification tests](https://docs.channex.io/api-v.1-documentation/pms-certification-tests.md).
Channex issues production credentials only after the tests, the form and a
recorded demonstration or live screenshare review pass. Run the tests from
the staging dashboard (`https://staging.krabiclaw.com`) or the iOS app connected
to staging, never from a script: Channex rejects scripts, Postman collections and
certification-only screens.

## How KrabiClaw maps onto Channex

KrabiClaw sells single-unit homes. Each home is its own Channex property with
one room type (inventory 1) and one rate plan, created by the Airbnb import
(`server/integrations/channex/airbnb-connection.ts`, stages `property`, `room`,
`rate`). Channex's test property instead has two room types and four rate
plans. The form's single-unit allowance applies: tests 4 to 8 run on two homes,
each standing in for one room type, and the Bed & Breakfast rate plans are not
modelled; test 3 (several rate plans on one date) is reported as not
applicable, since a home has one room type and one rate plan. Availability is
0 or 1 and follows bookings, checkout holds and linked calendars alone. A host
closing a night is `stop_sell: true` on the rate plan, one restrictions call
and nothing else; opening it is `stop_sell: false` alone. The property is
created with `min_stay_type: arrival`, and its Airbnb channel uses `Arrival`.
Airbnb minimum stays apply to the arrival date. A date without its own
override uses the actual listing default imported from live
`listing_details.availability_rules.default_min_nights`; missing or invalid
defaults stop the import. KrabiClaw has no independent through-stay rule.
The rate plan's rolling default minimum and primary rate follow the canonical
home's minimum and base price, so new dates agree with the direct calendar.
Actual optional weekday minima and the actual Friday/Saturday weekend amount
are stored in `calendar_rules`; an absent provider field stays absent. Imported
effective min/price values equal to the actual source policy inherit it (`NULL`)
instead of becoming 500 explicit exceptions. Differing dated values remain
explicit. Channex rolls the weekday minimums forward itself; the normal ARI
task delivers differing weekend prices as their dates enter the window. Nonempty
`seasonal_min_nights` is rejected visibly: its endpoint/collision semantics have
not been established, and no seasonal rule feature is offered.

Provider evidence (2026-10-30): the current
[create](https://docs.channex.io/api-v.1-documentation/rate-plans-collection/create-rate-plan-api.md)
and [update](https://docs.channex.io/api-v.1-documentation/rate-plans-collection/update-rate-plan-api.md)
OpenAPI schemas explicitly define seven Monday-first minimum values. Their
occupancy option accepts only a scalar rate, so weekend prices require dated
ARI delivery. Airbnb's live listing schema also reports its weekday minimum
array Monday-first, and Airbnb identifies
[weekend pricing as Friday and Saturday](https://www.airbnb.com/help/article/512).


Channex checks every submitted task against the exact dates and values in
its specification, so the dates below are mandatory, not examples. Delivery
sends only what differs from the values Channex last confirmed for a night
(`channel_night_pushes.sent_json`): before each test save, the night must not
already hold the test value, or the save sends nothing and creates no task.

The write path Channex will ask to see:

| Step | Code |
| --- | --- |
| Calendar save | `PUT /api/dashboard/stay-homes/:productId/nights` → `setStayNights` (`server/domain/stays.ts`) |
| Change detection | the save marks the changed nights pending in `channel_night_pushes`, the outbox |
| Delivery | `deliverStayNights` in `server/integrations/channex/ari.ts`; the `channex-ari-delivery` task delivers what comes due |
| `POST /restrictions`, `POST /availability` | `ari.ts`, one call each per home per delivery, contiguous equal nights as one date range |
| Rate limit | 10 restrictions and 10 availability calls per property per minute, counted from `channel_sync_log` |
| 429 and 5xx | the property pauses 1 minute, doubling to 1 hour; nights stay pending until Channex confirms them |
| Mapping | `product_channel_mappings` (property, room type, rate plan per home) |
| Task IDs | `channel_sync_log.task_id` on every ARI call |
| Bookings | webhook `POST /api/integrations/channex/webhook` → `applyBookingRevision` (`booking-revisions.ts`) → `GET /booking_revisions/:id` is the booking, landed as a stay, then `POST /booking_revisions/:id/ack`; `channex-revision-feed` reads unacknowledged revisions every 10 minutes. Nothing reads `GET /bookings/:id`: Channex counts that as `booking_received_via_booking_find` and refuses it |
| Airbnb change requests | webhook event `alteration_request` (or the same `channex-revision-feed` run) → `runAlterationRequestFeed` (`server/domain/guest-threads/stay-change-requests.ts`) reads `GET /live_feed?filter[event]=alteration_request` and records each waiting request in the stay's conversation, alerting the owners; the host's Accept or Decline there sends `POST /live_feed/:id/resolve` with `{"resolution":{"accept":"accept"|"decline"}}` and reads the event back. The stay changes only when Airbnb's confirmed `modified` revision lands as above. A request resolved on Airbnb (declined, or withdrawn by the guest, which sends no webhook) is reconciled from the feed |
| Full sync again | In the iOS app's Airbnb listing chooser, **Full sync** beside the selected syncing home → `POST /api/organizations/:organizationId/integrations/airbnb/imports/:productId/calendar` (empty request). The existing outbox resends the home's actual 500 future nights in two Channex ARI requests: one `POST /restrictions` and one `POST /availability`, preserving its channel mapping and Messages installation |

## Before the run

1. On Channex staging, connect two Airbnb test listings to one staging
   organization with **Connect Airbnb** in the dashboard. The import creates
   each home's property, room type and rate plan and sends its full sync.
   Import, reactivation and explicit full sync verify the channel's arrival
   mode, the property's arrival mode, and the rate plan's default minimum and
   primary rate. Existing `through` or `both` property modes are changed to
   `arrival`; metadata writes are read back before delivery. The import also
   verifies all dated arrival minimums against Channex inventory before it
   completes. Unknown or missing provider values fail visibly.

   Redo test 1 for an existing syncing home in the iOS app: open the Airbnb
   listing chooser and tap **Full sync** beside that home's name. It requires
   an owner or admin with channel sync access. It verifies canonical defaults,
   repairs differing metadata if needed, then sends one restrictions and one
   availability task. It does not reimport Airbnb content. Wait for its result;
   if delivery is pending, read the reason and let the existing outbox retry.
   Do this before tests 2 to 10: full sync records what Channex holds for every
   night, so each later save sends only the field the test changes. The home's
   existing connection and mapping stay in place throughout.

   A requested **Sync** of an already connected listing uses the existing
   `airbnb_sync_jobs` processor to refresh source content, then sync its
   canonical calendar. Content changes only fields whose saved import hash
   still matches the home. Minimum correction additionally requires an
   explicit `import_written.min_nights` hash: new imports record the actual
   source minimum; legacy repair may seed one only for a proven unchanged
   original import. A missing hash or a host edit preserves the canonical
   minimum. The entire actual rule JSON has the same host-edit hash guard.
   Legacy correction reads a fresh source calendar and changes only min/price
   cells on untouched `source='import'` rows. Existing NULL inheritance and all
   host rows remain canonical; other night values and confirmations are preserved.
   Source read failures remain visible on the job and prevent the
   calendar push. Job status reads do not process jobs; an environment without
   the normal cron must invoke the existing `airbnb-sync` task processor.

2. Register the webhook for the staging account, then check it again without
   `--apply`; it must report `unchanged`:

   ```sh
   CHANNEX_API_KEY=<staging key> CHANNEX_WEBHOOK_SECRET=<staging Worker secret> \
     corepack yarn channex:webhook --env staging --apply
   ```

   A property webhook replaces the global one for its property. Run it again
   with `--property <uuid>` for every property that has its own webhook.
3. Read each test's task ID back afterwards:

   ```sql
   SELECT created_at, product_id, external_id AS property_id, kind, status, task_id
   FROM channel_sync_log WHERE provider = 'channex' AND direction = 'outbound'
   ORDER BY created_at DESC LIMIT 20;
   ```

   Open those exact tasks in the property's Channex **Logs**. For test 1,
   inspect every restriction object: each must contain `min_stay_arrival`, and the date ranges must cover all 500 nights.
   Check the availability task covers the same dates. For test 5, verify
   the arrival minimum carries the requested value on the exact test
   date. A `pushed` row and `sent_json` alone do not prove Channex retained
   the fields.

Home A stands in for Twin Room, home B for Double Room. Dates are in 2026
unless stated. Every action is in **Calendar** for that home: **Select nights**,
choose the start and end night, **Edit selected nights**.

## The tests

| # | Test | Action in KrabiClaw | Calls |
| --- | --- | --- | --- |
| 1 | Full sync, 500 days | **Connect Airbnb** imports the home and sends its 500 nights (import stage `inventory`); for an existing syncing home, choose its **Full sync** action as described above. Every night carries rate, arrival minimum, max stay, closed to arrival, closed to departure and stop sell. Set varied prices and rules on Airbnb first: Channex refuses uniform data. | 1 restrictions, 1 availability per home |
| 2 | Single date, single rate | Home A, 22 Nov: **Nightly price** 333 | 1 restrictions |
| 3 | Single date, several rates | Not applicable: one room type and one rate plan per home. Say so on the form | — |
| 4 | Several dates, several rates | Home A, 1–10 Nov: 241. Home B, 10–16 Nov: 312.66. B&B: not modelled | 1 per home, one date range each |
| 5 | Min stay | Home A, 23 Nov: **Custom settings → Minimum nights**: 3 on arrival. Home B, 25 Nov: 2 on arrival. B&B: not modelled | 1 per home, `min_stay_arrival` |
| 6 | Stop sell | Home A, 14 Nov: **Block selected nights**. Home B, 16 Nov: block. The night sends `stop_sell: true` and nothing else | 1 restrictions per home, no availability call |
| 7 | Several restrictions | Home A, 1–10 Nov: **Allow check-in** not allowed, **Allow checkout** allowed, **Maximum nights** 4, minimum 1. Home B, 10–16 Nov: check-in not allowed, minimum 2. B&B ranges: not modelled | 1 per home |
| 8 | Half-year update | Home A, 1 Dec 2026–1 May 2027: price 432, check-in and checkout allowed, minimum 2. Home B, same range: price 342, minimum 3 | 1 per home |
| 9 | Single date availability | Add a host stay (iOS **Add stay**) on home A for 21 Nov and home B for 25 Nov: each night's availability goes to 0. Then cancel each stay: availability returns to 1. Submit the cancel's task: Channex expects a positive availability, and a single unit has no 7 or 8 | 1 availability per home per action |
| 10 | Several dates availability | Add a host stay on home A for 10–16 Nov and home B for 17–24 Nov, then cancel each; submit the cancel's task (availability 1 over the range) | 1 availability per home per action |
| 11 | Booking receiving | Create, modify and cancel a booking on a Booking.com test channel launched on home A's property. Each revision arrives by webhook, is landed from the revision itself and acknowledged; the stay appears, moves and cancels in the dashboard | revision, ack |
| 12 | Rate limits | Show the outbox and the per-property count above; save 11 changes to one home within a minute and show the 11th leaving its nights pending with their retry time | — |
| 13 | Update logic | Only changed values are sent: delivery compares each night with what Channex last confirmed (`sent_json`). There is no timed full sync. A full sync happens at import, reactivation or an explicit **Full sync** request | — |
| 14 | Extra notes | See the answers below | — |

A Booking CRS (`Offline`) booking is not a channel KrabiClaw accepts
(`booking-revisions.ts` `CHANNELS`), so test 11 uses a Booking.com test
account.

## Answers for the form

- **Min stay:** min stay on arrival, matching Airbnb. Independent through-stay minimums are not supported.
- **Restrictions:** stop sell, closed to arrival, closed to departure, min stay
  on arrival and max stay are supported.
- **Room types and rate plans:** one room type and one rate plan per property:
  every home is a single unit. Bed & Breakfast rate plans are skipped.
- **Credit cards:** not needed. Channel bookings are paid on the channel;
  direct bookings pay through Stripe.
- **PCI:** KrabiClaw stores no card data; card payments go through Stripe
  Checkout and Elements.

## Review video

Record all three PMS actions in the iOS app, and show the same property's
Channex staging web **Logs** after each action, continuously or in clearly
separated sections. Show the selected home and its
mapped property, room type and rate plan so each request can be tied to the
action. Choose an available future night with no other inventory claim for
the booking scenarios; preserve existing stays and rules.

| Scenario | PMS action | Evidence in Channex Logs |
| --- | --- | --- |
| Create a booking | In iOS, **Add stay** for one night, then show it on the home's calendar | One availability update for that night, from 1 to 0; no restrictions update or unrelated dates |
| Move the booking | In iOS, edit that same stay to one week later, keeping it one night; show its new dates | One availability batch reopening the old night to 1 and closing the new night to 0; no restrictions update or unrelated dates |
| Full sync | In the iOS Airbnb listing chooser, tap **Full sync** beside that same home | Verified canonical metadata, then two Channex ARI requests producing one restrictions task and one availability task covering the same 500 future nights, with actual varied calendar values and the arrival minimum in every restriction object |

Open the requests and returned task IDs, not just their success labels. Equal
consecutive nights may be compressed into date ranges; expand the ranges when
checking 500-night coverage. A full sync preserves the same property and
channel mapping. After recording, cancel the test stay through the PMS and
verify its occupied night reopens in Channex.

## Submitting

1. Collect each test's task IDs from `channel_sync_log`.
2. Send the [certification form](https://forms.gle/xA8F3eSYBPBd8apYA) with the
   task IDs, the answers above, test 3 as not applicable and the single-unit
   adaptation for tests 4–10 (tests 9 and 10 submit the cancel's task).
3. After the form passes, record the three review scenarios above. Once the
   owner approves the video, upload it with access for anyone with the link
   and send that link with the Channex staging property ID to
   `evan@channex.io`. Channex can also review the same actions in a live
   screenshare.

## After certification: production cutover

1. Disconnect every host while `CHANNEX_BASE_URL` still names staging:
   `disconnect()` calls the current base URL, and staging IDs 404 against
   production.
2. Set `CHANNEX_BASE_URL` to `https://app.channex.io/api/v1` in the top-level
   `wrangler.toml` vars only. `[env.staging.vars]` keeps
   `https://staging.channex.io/api/v1`: staging runs on a copy of production
   data and must never write to production Channex properties.
3. Set production's `CHANNEX_API_KEY` and `CHANNEX_WEBHOOK_SECRET` to the
   production account's with `wrangler secret put`. Staging keeps its staging
   key and secret.
4. Register the webhook: `corepack yarn channex:webhook --env production --apply`.
5. Hosts reconnect Airbnb. This creates new properties and mappings and a
   500-day full sync. Re-imported reservations match their stays on
   `ota_reservation_code`; a conversation that names a re-imported booking
   before its revision landed lands that revision from the feed first.

