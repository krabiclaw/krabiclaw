# Domain model

## Channex inventory

Each home has one Channex property, room type, and standard rate plan in
`product_channel_mappings`. `product_airbnb_listings` links each Airbnb listing
to that home and its Channex channel. A listing with independent rates has a
rate plan on the same room. Hosted channels use the same home inventory.

`channex_groups` holds the business’s Channex group, and each row in
`channex_connections` represents an Airbnb account authorization.
[Channel connection](../server/integrations/channex/channel-connection.ts)
provisions inventory and connects listings and accounts.
[Channex properties and inventory](https://docs.channex.io/api-v.1-documentation/hotels-collection)

## Reservation inventory

`stay_nights` stores each reservation’s nights, including when a channel has
already confirmed a conflicting reservation. `occupied_stay_nights` projects
those rows onto the assigned home and the original channel listing when a
guest has been moved. Host booking, guest checkout and the calendar all use
this inventory. A conflicting Blawby booking is refused in its write batch.

A host who records an early Airbnb checkout releases the remaining
`stay_nights`. The booking keeps its Airbnb dates in `starts_at` and
`ends_at`, and records the departure day in `bookings.actual_check_out_date`.
