# Domain model

## Channex inventory

Each home has one Channex property, room type, and rate plan in
`product_channel_mappings`. Airbnb imports also store their Airbnb listing
and channel IDs in that row. Homes set up through Channex’s hosted mapping
form use the same inventory. Channex stores the hosted channel connection.

`channex_connections` holds the organization’s Channex group and Airbnb
authorization. [Channel connection](../server/integrations/channex/channel-connection.ts)
provisions the property, room, and rate for both flows.
[Channex properties and inventory](https://docs.channex.io/api-v.1-documentation/hotels-collection)

## Reservation inventory

`stay_nights` stores each reservation’s nights, including when a channel has
already confirmed a conflicting reservation. `occupied_stay_nights` projects
those rows onto the assigned home and the original channel listing when a
guest has been moved. Host booking, guest checkout and the calendar all use
this inventory. A conflicting Blawby booking is refused in its write batch.
