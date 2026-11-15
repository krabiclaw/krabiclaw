# Insights

Insights is Airbnb's Performance for every kind of business: Quality, then
Occupancy & rates (a business with places to stay) or Bookings & rates, then
Conversion and Marketing. Each page is its own URL,
`/dashboard/:org/insights/<section>/<page>`, with its kind, location, range and
chosen number in the query, and one read, `GET /api/dashboard/insights/<section>/<page>`
(`server/domain/insights.ts`, `shared/insights.ts`). The web dashboard, the app
and MCP `get_organization_analytics` read the same pages. `GET /api/dashboard/insights`
names what the business books, its locations and the pages the member may open.
A member who does not read analytics reads Quality for the visits they look after.

Every number is read from the stored records it is about, in one D1 batch:

- Overall rating: the reviews written in the range: a booked visit's unless it
  was rejected, and one left without a visit once it is published.
- Bookings & rates: the bookings that start in the range, in each booking's
  own clock. Occupancy is booked nights over open nights (a home's nights from
  the day it was listed, less the nights its calendar closed or another site's
  calendar holds). The cancellation rate is cancelled over all bookings. A
  stay's nightly rate is its total over its nights; for other bookings, booking
  income is what was received for them (payments captured less refunds, and
  payments recorded by hand) and the average value is that over the bookings
  that were paid. Income by channel adds a channel reservation's amount.
- Conversion: the bookings made in the range (received live; a channel's
  imported history has no time it was made). Booking conversion is an
  offering's website bookings over its page views; beside them it counts the
  website's clicks to book (a consultation button, or an offering's external
  booking link), to call (a location's own number) and, at a restaurant, to
  order (an offering's external order link). A site without such a click does
  not show its number, and the clicks are counted under All. Lead time and returning
  guests read website bookings only: Channex does not send the time a guest
  booked on a channel (its revision's `inserted_at` is when Channex received
  it, https://docs.channex.io/api-v.1-documentation/bookings-collection), and a
  channel's guest is not a returning account.
- Sources: visits by the channel they arrived from and the bookings each led
  to. A website booking keeps how its guest arrived (`bookings.website_source`,
  the attribution of the visit or checkout it was made through); a booking a
  member adds has none and is listed as Added by you; a channel's reservation
  is its channel.

Page views, top pages, sources and offering views are day counts the visit
write keeps current (`recordTenantPageview` in `server/utils/pageview-tracking.ts`):
recording a visit adds one, in the same batch, to the organization's local day
of the visit, for the day, the page, the offering whose page it is and, on a
session's first page view, the channel it arrived from. A duplicate event adds
nothing. Visits are counted from the organization's `analytics_data_start_at`.

Clicks are counted the same way by the click's own write
(`recordOrganizationConversionEvent` in `server/utils/organization-conversions.ts`):
a new click to book, call or order adds one to its event's `interaction` day on
the organization's local day of the click; a duplicate adds nothing. Clicks
recorded before this count existed (it shipped with the Insights pages) stay in
`analytics_events` and are not counted.

Insights → Instagram and → Google Ads are read live from the provider when the
page opens (`GET /api/dashboard/instagram-insights`,
`GET /api/dashboard/google-ads-insights`), through the Better Auth linked
account that connected it, and nothing is stored. Instagram needs the Growth
plan and the `instagram_business_manage_insights` permission; each missing piece
is its own state. Google Ads reports spend, clicks and conversions by day in the
account's time zone.

`query_google_analytics` and `query_search_console` read the connected GA4
property and Search Console site directly; neither is mixed into Insights.
