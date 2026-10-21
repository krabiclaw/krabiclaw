# Native analytics

Insights and `get_organization_analytics` read the organization’s first-party D1
record through `getAnalyticsReport`. Traffic from social networks, search,
campaigns and direct visits shares the same reporting period and attribution
model. Provider access is not required to read that history.

`analytics_events` stores observations and business outcomes;
`analytics_summaries` stores sessions and daily summaries. The shared schema in
`shared/analytics-report.ts` defines the producer, dashboard and MCP contract.
Malformed reports fail before the dashboard endpoint sends a successful response.
Browser request failures include the endpoint, error code and request ID in the
console, and the page shows an error with a retry action instead of zero totals.

The report's `funnel` joins a business's site into one path: visits (pageview
sessions) → viewed → intent → submitted → confirmed → paid. Which event counts
toward which step is the `funnel` field of the event catalog
(`utils/organization-conversion-events.ts`). Confirmed is a submitted request
whose booking, reservation or stay is confirmed now; paid is `payment_paid`
with the cash collected per currency. The same counts are broken down by
channel (`attributionChannel`, from each event's attribution snapshot) and by
location. Insights names the steps in the vertical's words.

Google Analytics is a delivery destination. Recorded GA4 delivery outcomes are
reported separately from native business outcomes. Meta publishing connections
remain in Integrations; views and reach on those platforms are different
populations from visits to the website and are not added to website traffic.

Insights → Instagram reads the connected Instagram professional account live
from Instagram for the same date range, in the organization's calendar days
(`GET /api/dashboard/instagram-insights`, `server/utils/instagram-insights.ts`).
It needs the Growth plan, the selected account, and the
`instagram_business_manage_insights` permission on the Better Auth linked
Instagram account; each missing piece is reported as its own state. Account
totals come from `/{ig-user-id}/insights` (`period=day`, `metric_type=total_value`)
and each feed post or reel posted in the range from `/{media-id}/insights`
(lifetime); Instagram reports no insights for carousels. A metric Instagram did not
return is shown as unavailable, not zero. Nothing is stored, and Instagram can take
up to 48 hours to report recent activity. Instagram's own failures are returned as
a 502 with its message, and the tab offers a retry.

Dates are inclusive in the organization’s timezone, defaulting to the last 30
calendar days. The dashboard offers compact 7d and 30d controls. Session
conversion rates use eligible sessions, while outcome attribution uses each
event’s immutable attribution snapshot. Amounts remain in minor units per currency;
quoted booking value is not collected revenue.
