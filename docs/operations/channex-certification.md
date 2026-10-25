# Channex PMS certification

Authority: [PMS certification tests](https://docs.channex.io/api-v.1-documentation/pms-certification-tests.md).
Channex issues production credentials only after the 14 tests, the form and a
live screenshare review pass. Every test is run from the staging dashboard
(`https://staging.krabiclaw.com`), never from a script: Channex rejects
scripts, Postman collections and certification-only screens.

## How KrabiClaw maps onto Channex

KrabiClaw sells single-unit homes. Each home is its own Channex property with
one room type (inventory 1) and one rate plan, created by the Airbnb import
(`server/integrations/channex/airbnb-connection.ts`, stages `property`, `room`,
`rate`). Channex's test property instead has two room types and four rate
plans. The form's single-unit allowance applies: tests 3 to 8 run on two homes,
each standing in for one room type, and the Bed & Breakfast rate plans are not
modelled. Availability is 0 or 1: it follows bookings and checkout holds, and
a host closing a night is `stop_sell` on the rate plan.

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
| Bookings | webhook `POST /api/integrations/channex/webhook` → `applyBookingRevision` (`booking-revisions.ts`) → revision, booking, `POST /booking_revisions/:id/ack`; `channex-revision-feed` reads unacknowledged revisions every 10 minutes |

## Before the run

1. On Channex staging, connect two Airbnb test listings to one staging
   organization with **Connect Airbnb** in the dashboard. The import creates
   each home's property, room type and rate plan and sends its full sync.
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

Home A stands in for Twin Room, home B for Double Room. Dates are in 2026
unless stated. Every action is in **Calendar** for that home: **Select nights**,
choose the start and end night, **Edit selected nights**.

## The tests

| # | Test | Action in KrabiClaw | Calls |
| --- | --- | --- | --- |
| 1 | Full sync, 500 days | **Connect Airbnb** imports the home and sends its 500 nights (import stage `inventory`). Set varied prices and rules on Airbnb first: Channex refuses uniform data. | 1 restrictions, 1 availability per home |
| 2 | Single date, single rate | Home A, 22 Nov: **Nightly price** 333 | 1 restrictions |
| 3 | Single date, several rates | Home A, 21 Nov: price 333. Home B, 25 Nov: price 444. B&B 29 Nov: not modelled | 1 per home |
| 4 | Several dates, several rates | Home A, 1–10 Nov: 241. Home B, 10–16 Nov: 312.66. B&B: not modelled | 1 per home, one date range each |
| 5 | Min stay | Home A, 23 Nov: **Minimum nights on arrival** 3. Home B, 25 Nov: 2. B&B: not modelled | 1 per home |
| 6 | Stop sell | Home A, 14 Nov: **Block selected nights**. Home B, 16 Nov: block | 1 per home |
| 7 | Several restrictions | Home A, 1–10 Nov: **Allow check-in** not allowed, **Allow checkout** allowed, **Maximum nights** 4, minimum 1. Home B, 10–16 Nov: check-in not allowed, minimum 2. B&B ranges: not modelled | 1 per home |
| 8 | Half-year update | Home A, 1 Dec 2026–1 May 2027: price 432, check-in and checkout allowed, minimum 2. Home B, same range: price 342, minimum 3 | 1 per home |
| 9 | Single date availability | Book home A for 21 Nov and home B for 25 Nov on the staging site; each night's availability goes to 0. Inventory 8 and 1 do not exist for a single unit | 1 availability per home |
| 10 | Several dates availability | Book home A for 10–16 Nov and home B for 17–24 Nov; cancel one to show availability returning to 1 | 1 availability per home |
| 11 | Booking receiving | Create, modify and cancel a booking on a Booking.com test channel launched on home A's property. Each revision arrives by webhook, is applied and acknowledged; the stay appears, moves and cancels in the dashboard | revision, booking, ack |
| 12 | Rate limits | Show the outbox and the per-property count above; save 11 changes to one home within a minute and show the 11th leaving its nights pending with their retry time | — |
| 13 | Update logic | Only changed nights are sent: delivery compares each night with what Channex last confirmed (`sent_json`). There is no timed full sync. A full sync happens once, when a home is imported | — |
| 14 | Extra notes | See the answers below | — |

A Booking CRS (`Offline`) booking is not a channel KrabiClaw accepts
(`booking-revisions.ts` `CHANNELS`), so test 11 uses a Booking.com test
account.

## Answers for the form

- **Min stay:** both min stay on arrival and min stay through.
- **Restrictions:** stop sell, closed to arrival, closed to departure, min stay
  on arrival, min stay through and max stay are all supported.
- **Room types and rate plans:** one room type and one rate plan per property:
  every home is a single unit. Bed & Breakfast rate plans are skipped.
- **Credit cards:** not needed. Channel bookings are paid on the channel;
  direct bookings pay through Stripe.
- **PCI:** KrabiClaw stores no card data; card payments go through Stripe
  Checkout and Elements.

## Submitting

1. Collect each test's task IDs from `channel_sync_log`.
2. Send the [certification form](https://forms.gle/xA8F3eSYBPBd8apYA) with the
   task IDs, the answers above and the single-unit adaptation for tests 3–10.
3. In the screenshare, repeat any test from the dashboard while Channex
   watches the calls.

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
   `ota_reservation_code`.
