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
