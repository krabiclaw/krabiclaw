# Google Ads API

How KrabiClaw uses the Google Ads API, where its access is managed, and what
the Basic-access application states. Customer-facing behavior is in
`docs/payments/payments.md` (managed ads) and the Integrations leaf; this is the
operator's record.

## Access

- Developer token and access level: Google Cloud Console → Google Ads API →
  Access levels, project `kikuzuki-business-api` (number 799728932262), under
  the owner's Google login. **Explorer** since 2026-10-18 (2,880 operations a
  day, campaign management and reporting). **Basic** needs the application
  below.
- Manager account: Krabiclaw — Manager `331-742-7925`. Customers connect their
  own accounts; the manager is not required for a connection.
- OAuth: Better Auth's Google provider, incremental scope
  `https://www.googleapis.com/auth/adwords` (`shared/organization-settings.ts`).
  Better Auth stores and refreshes the token; the application stores only the
  chosen customer id and name in `organization_integrations` (`google_ads`).
- The developer token is `GOOGLE_ADS_DEVELOPER_TOKEN` on the Worker.

## What the product calls

All calls are in `server/utils/google-ads.ts`, against `v25`.

| Call | Used by |
| --- | --- |
| `customers:listAccessibleCustomers`, `googleAds:search` on `customer` | Integrations → Google Ads: list the login's accounts with their names, currency and time zone; pick one |
| `googleAds:search` on `campaign` | Insights → Google Ads (campaigns by spend for a range); `list_google_ads_campaigns`; Today's Google Ads card totals |
| `googleAds:search` on `ad_group`, `ad_group_criterion`, `ad_group_ad` | `get_google_ads_campaign` detail |
| `campaignBudgets:mutate`, `campaigns:mutate`, `googleAds:mutate` | `create_google_ads_search_campaign`, `clone_google_ads_campaign`, `update_google_ads_campaign` (status, budget) — Business plan only |
| `googleAds:search` on `customer` metrics for one day | `marketing:ad-spend-daily`: a managed account's finished day, billed at 10% |

Reads are live and never stored. The only persisted Google Ads figures are the
daily `ad_spend` usage events for businesses with managed ads on.

## Surfaces

- **Integrations → Google Ads** — connect, choose the account, disconnect.
  Free on every plan.
- **Insights → Google Ads** — spend, clicks, impressions, conversions, cost per
  conversion and campaigns by spend for the selected range, in the account's
  currency; a managed-ads card when the service is off.
- **Today** — the connected account's last 7 complete days (spend, clicks,
  conversions), linking to that range in Insights.
- **ChatGPT / MCP** — the five `*_google_ads_*` tools above, for Business.
- **Plan and billing → Managed ads** — managed ads consent; the daily task reads
  spend only for days the agreement was on.

## Basic access application

Google's form asks for the use case, a design document and a demo. State:

- **Who uses it:** KrabiClaw customers (small businesses: restaurants,
  experiences, lodging, law firms) connecting their own Google Ads accounts to
  the website and dashboard KrabiClaw runs for them. One OAuth login per
  business; no cross-customer data.
- **Why:** reporting their own results beside their website analytics, and
  — on the Business plan — creating and adjusting Search campaigns from the
  dashboard and ChatGPT. Managed ads is KrabiClaw's own staff working in the
  customer's account under a recorded agreement.
- **Reporting vs. management:** both; see the table above.
- **Volume:** one connected account per business today; reads per dashboard
  visit plus one daily read per managed account. Explorer's 2,880 daily
  operations bound the current fleet; Basic is requested so growth in connected
  accounts does not interrupt customers' reporting.
- **Policy points:** required minimum functionality is met (campaign creation
  with budget, status and keywords; reporting with spend, clicks, impressions
  and conversions). Tokens are the customer's, handled by Better Auth. No
  scraping, no automated bidding beyond the customer's explicit request.
- **Demo:** a recording of Integrations → Google Ads (connect and account
  pick), Insights → Google Ads, a campaign created from ChatGPT and shown in the
  Google Ads UI, and Today's card. Record on production with the owner's test
  business and a test-mode account; do not record a customer's account.

Submit from Cloud Console → Google Ads API → Access levels → Apply for Basic
access, signed in as the owner.
