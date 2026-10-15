# Payments

Payments extends canonical Products, variant-owned Prices, Sessions and Bookings.
It does not introduce a consultation table, shipping engine, customer subscription,
FX conversion or replacement for Better Auth platform subscriptions.

## October 6 release qualification

Provider configuration is installed on staging and production. Native Stripe
reads verify platform `acct_1SXZfREm0pkzLQDb` in the matching test/live modes,
connected Payments webhook scope, the required events and API version, and the
live Growth/Commerce catalog and customer portal. The existing Better Auth
subscription lifecycle remains canonical. Dedicated Payments configurations
allow Card, Apple Pay, Google Pay and Link; the staging merchant's native child
configuration independently confirms this exact set. Native Metronome mappings
and USD-cents rate cards pass the application's validation, with automatic
collection enabled.

The dedicated staging canary completed a paid Growth subscription Checkout and
Stripe's existing-subscription confirmation for Commerce through normal Better
Auth owner authentication. Independent native reads confirm the same active
subscription at $89/month, the unchanged billing anchor and Payments entitlement.
Its operating Stripe customer and native Metronome customer/contract match. The
connected Sandbox merchant completed hosted onboarding and is Ready with its
test bank.

On 2026-10-06 the canary took a real paid booking and refund. The service
needed its Blawby surfaces: a `/services/sandbox-booking` page bound to the
product, a `page_grid` on `/services` naming it, consultation mode `native`,
and an online weekly schedule (the booking picker lists online sessions only).
A guest booked through `POST /api/public/products/sandbox-booking-2/book` and
paid USD 10.00 on hosted Sandbox Checkout with Stripe's 4242 card. Independent
Stripe reads: Checkout complete/paid, intent `pi_3UNMbcEsC8iRCsIQ128bxOD2`
succeeded with 1000 received and no application fee, on
`acct_1UNLlgEsC8iRCsIQ`, livemode false. Both signed webhooks
(`checkout.session.completed`, `payment_intent.succeeded`) processed; the hold
converted to confirmed booking `24bbbe2e-40e5-4005-b41f-51902a6e71ae`; the
captured-volume usage row is queued for Metronome; guest acknowledgement,
status update and owner alerts were delivered (log-only). The owner refunded
USD 10.00 from the dashboard (prepare, then same-origin approval): Stripe
refund `re_3UNMbcEsC8iRCsIQ1wmWEhdA` succeeded with the note in metadata; the
application shows the payment refunded 1000/1000, the authorization consumed,
the thread entry, owner and buyer notifications, and the guest's Activity page
"Refunded $10.00 · Refund sent".

The return to the app after Checkout failed with 500 on the first attempt. The
cause was in `createCanonicalNotification`: after `ON CONFLICT DO NOTHING` it
re-read the row and threw when any field differed, so the second delivery of
the capture event (the purchase now attached to the account that proved the
return) was refused. The re-read is removed; the id is the event's identity
and the first write wins (staging `25b8f00`). Stripe and Better Auth behaved
correctly throughout.

Production moved to the v12 replacement on 2026-10-06 at 02:03 UTC (PR 1272,
`main` `c81705e04`). Before the merge, a fresh v11 read against the independent
destination checkpoint carried the owner's Terms and Privacy edits of 01:27 to
01:29 UTC as four guarded full-row compare-and-swap updates, read back equal to
v11, and then the insert-only delta wrote the rows the checkpoint lacked. The
remaining source changes were `updatedAt` bumps, rate-limit leases and expired
cache invalidations. After the deploy switched the binding, a second checkpoint
and delta found a gap of five NCLS pageviews, one session summary and one
rate-limit lease: the pageviews were inserted and read back, the session summary
was left to v12's own later row for the same session, and the lease expires
within the hour. Foreign keys are clean after every write. Production answers
200 for the platform, docs, pricing and policies pages, both verified tenant
sites, the dashboard Payments, Plan, Payouts and Earnings surfaces and the MCP
workspace read. NCLS was not upgraded.

Current native evidence also supersedes the earlier shortened-period test
below. Contract `66a54a7c-fffe-4bf7-8b72-f8b9ebeea38d` is already reopened, with
its original monthly schedule. The current USAGE invoice is
`d16029da-c5b5-5fc7-b237-dc60cc8bcec9`: DRAFT, 48,000 USD cents of volume at
0.014, total 672 USD cents, October 4 at 09:00 UTC through November 1. It has
no external Stripe invoice. The former 140-cent shortened-period invoice is
absent from the current native invoice list. Stripe independently shows only
the paid $89 subscription invoice for that operating customer. The subscription
remains active at $89/month, with no scheduled cancellation. Fee collection and
the earlier collection/restoration/acceptance test remain unqualified.

Sanitized provider and release observations are recorded in
[the October 6 proof](release-verification-2026-10-06.json). Historical snapshots
below remain dated observations; they do not describe the current contract or
prove a paid usage invoice.

## Coordinated dependencies

Payments builds on Calendar/member scheduling, now merged into staging. The
migration chain preserves the v11 baseline and all three applied Calendar
migrations. Generated `0004_payments_commerce` adds Payments and reduces the
custom webhook receipt to concurrent deduplication; Stripe owns redelivery.
Calendar stages cleanup in the tenant cleanup helper; Payments retains financial
servicing relationships afterward.

Required online collection is an explicit offering policy. Positive pay-later Prices
remain bookable without Checkout. Valid zero Prices use the canonical free flow;
missing Prices cannot authorize a charge. Commerce is $89/month and includes
Growth's features and Payments. Free and Growth do not include Payments;
historical Basic/Starter catalog names do not grant it. Existing transaction,
refund, dispute, receipt and usage servicing is independent of new-sale entitlement.

## Payments help articles

The platform's canonical Docs collection owns these articles. They were created
and published through MCP on October 7, 2026 under **Payments and payouts**:

- [When you'll get your payout](https://krabiclaw.com/docs/when-youll-get-your-payout)
- [How refunds work](https://krabiclaw.com/docs/how-refunds-work)
- [Fees and invoices](https://krabiclaw.com/docs/fees-and-invoices)
- [Disputes](https://krabiclaw.com/docs/disputes)
- [Changing your bank account](https://krabiclaw.com/docs/changing-your-bank-account)

`PaymentsHelp` links these stable platform URLs from Earnings, Paid, payout
details and Payments → Payouts. The articles remain CMS content; dashboard
components own only their links. Absolute platform URLs keep tenant-hosted
dashboards pointed at the same articles. Go to your transactions remains scoped
to the selected business.

Stripe's settlement timing and payout schedule are separate. Krabiclaw does not
apply Airbnb check-in payout-release rules. Bank changes use Stripe Express;
sent payouts cannot be redirected. Merchant refunds require authenticated browser
approval. A paid visit's rejection or cancellation, a guest's own cancellation of
a deposit-paid reservation inside its terms, and the recovery of a capture
nothing could be fulfilled for are each Stripe's full-remaining refund: the
request names no amount, Stripe returns whatever it still holds for the
payment, and the recorded amount is the one Stripe reports. The approval screen
shows that remainder read from the charge. Each refund is one request under a
stable idempotency key; a lost response is retried against Stripe's record of
the first attempt, and an attempt older than Stripe's 24-hour key window is
refused for a manual check rather than re-sent. Settlement verifies the
Checkout is the authorized purchase on the right account and mode and that
Stripe reports it paid; it does not recompute the total from the catalog
price, so native tax or a surcharge is never a settlement failure.
Dispute evidence is submitted in Stripe, and Managed Risk covers unrecoverable
negative balances rather than guaranteeing that disputed funds are retained.
The 1.4% captured-volume fee remains billable after refunds/disputes; actual Stripe
costs and subscription billing remain separate.

The customer articles follow the provider help structure, with the relevant
steps, timing, status explanations and troubleshooting mapped to Krabiclaw's
actual screens. They are complete task guidance rather than external-source
summaries. Their links point only to related Krabiclaw articles and support.
The dispute notification opens Krabiclaw payment details, not Stripe; the article
explains the separate Stripe Express Payments → Disputes response workflow.
The booking refund guide names Amount, Reason, Review refund and the final
Approve and send refund action, including the 10-minute approval expiry.

Provider references for future operator maintenance (reviewed October 7, 2026):

- [Airbnb payout help structure](https://www.airbnb.com/help/article/425)
- [Stripe settlement and payout schedules](https://docs.stripe.com/payouts)
- [Stripe Express payout restrictions and statuses](https://support.stripe.com/express/questions/what-does-it-mean-that-my-payouts-are-paused-or-my-payments-are-blocked)
- [Stripe refund destinations, timing and failures](https://docs.stripe.com/refunds)
- [Stripe Express dispute actions](https://support.stripe.com/express/questions/how-do-i-manage-my-disputes?locale=en-GB)
- [Stripe dispute response requirements](https://docs.stripe.com/disputes/responding)
- [Stripe dispute evidence and withdrawn disputes](https://docs.stripe.com/disputes/best-practices)
- [Stripe Express bank changes](https://support.stripe.com/express/questions/update-bank-account-or-debit-card-for-payouts?locale=en-GB)
- [Stripe Express bank-change verification recovery](https://support.stripe.com/express/questions/how-do-i-update-my-payout-account-details-if-i-dont-have-my-previous-bank-or-card-details)
- [Stripe Express wrong-bank payout troubleshooting](https://support.stripe.com/express/questions/my-payout-was-sent-to-the-wrong-bank-account)

Amounts and Krabiclaw-specific rules come from the native financial and Metronome
billing contracts below. Recheck both the provider guidance and the actual
application actions before changing these articles; preserve their stable paths.

## Activity and payment details

Buyer navigation is Today, Calendar, Activity, Messages and Menu. Tenant
navigation remains Today, Calendar, Locations, Messages and Menu. The explicit
route selects the screen; a tenant owner can also be a buyer. Profile holds account
settings, with no separate Purchases and bookings page.

Better Auth owns the session, active organization, membership and permissions.
The explicit Personal/business chooser uses its native `organization.setActive`
with null or the chosen organization ID, then refetches the session. There is no
buyer role, account-type flag or second authentication context. A direct route
still targets its stated tenant and must pass the shared membership/permission
boundary; visiting a route does not silently activate a different organization.

Activity opens the actual booking, reservation or product detail. Payment info,
receipts and refunds belong inside that detail. Both audiences use the same
payment presentation; tenant management actions use the existing financial
authorization. Messages links back to the same record. One-time orders have
their immutable items, without a calendar occurrence or manufactured booking
conversation; the merchant arranges fulfillment outside KrabiClaw.

Buyer reads authorize the current Better Auth user against the targeted record.
The buyer conversation excludes internal notes, staff controls and delivery
diagnostics. Tenant membership never grants access to another buyer's account.
An authenticated personal web reply is labelled You using its exact native user
identity. Other actor IDs stay private; historical and deleted authors are not
inferred from current record ownership.

## Payment updates

Authenticated native payment, refund and dispute status changes use the existing
activity and notification center. Bookings retain their conversation; a financial
operation appears there with its actual amount and item. One-time orders do not
create a conversation. Merchant alerts appear under Messages → Updates, and
buyers see their own updates under Messages → Updates. Both reuse the same notification list;
the tenant navigation remains Today, Calendar, Locations, Messages and Menu.
Tenant feeds exclude platform alerts and other businesses' or buyers' updates.

Merchant email respects each Better Auth owner's or administrator's
Organization and billing preference. Buyer payment/refund notices use the
existing transactional category and the authenticated Checkout contact; that
email address never creates or identifies an account. Updates open the actual
service or product detail; receipts and invoice links remain native Stripe links.
No new WhatsApp template is introduced.

Native object, account, mode and status identify an alert. Replays retain one
notification and durable per-recipient email receipts. Email receipts remain on
the merchant's financial activity when a personal account is deleted. Existing
Better Auth anonymous linking transfers purchases, notification targets and read
acknowledgements; current purchase ownership authorizes a return-proof replay.
Booking conversion completes before notification delivery. Delivery and realtime
publication failures remain visible and retryable through the canonical path.

Better Auth Stripe still owns subscriptions. Its documented `onEvent` hook adds
Metronome Payments invoice status alerts after the canonical customer, contract,
platform and external-invoice validation. Native paid state is authoritative;
an open invoice alone does not imply failure. There is no scheduled
reconciliation: the connected-account webhook owns capture, refund, dispute and
payout state, and Stripe's own redelivery is the retry. Nothing here issues or
collects an invoice.

The preserved local environment intentionally has no automatic cron schedule and
uses log-only customer mail. Its existing Stripe CLI listeners forward the native
Sandbox events. The hourly thread follow-up independently checks actual native
collection, restores the same monthly contract only after paid collection, and
verifies the resulting alert and normal authenticated readback. Collection stays
pending until the genuine invoice issue time; an hourly check does not guarantee
collection at that exact minute.

October 5 verification used the locally built Cloudflare Worker with development routes
disabled and normal Better Auth authentication. The actual $100 order appears
in Activity and its product detail, with immutable items, Payment info and the
native receipt. A genuinely disposable existing contact received one web reply:
the original and exact replay returned 200, conflicting replay returned 409,
and read acknowledgement counts were 1 then 0. Independent D1 and merchant
reads show one message, one owner notification and one buyer read receipt;
acknowledgements never render as conversation events. All seven original
Commerce financial datasets compared exactly unchanged. Personal selection
changed exactly one existing native Better Auth session from Commerce to null;
business selection restored the same session to the exact Commerce organization.

Supporting checks passed: quality, the final full typecheck and Node 24.18.1
production build, 239 unit tests, 107 D1 tests, four migration tests, migration
and schema guards, 44 email previews, ten dual-channel notification cases and
the normal HTTPS OAuth/MCP smoke with its 116-tool catalog. The D1 suite has one
explicit native Resend opt-in skip. Local CodeRabbit reviewed the 67-file
notification and Activity revision; its three valid findings were corrected,
with scoped lint and the final typecheck/build passing. Earlier full-PR review and its dispositions remain in
the dated qualification notes.

The previous-head CI pricing failure was a stale exact expectation of
“Included with setup” for Commerce. The owner-tested canonical comparison uses
“Included” and separately states the Stripe and Payments billing setup
requirement in the row detail. The expectation now matches that exact label
and verifies the exact visible Payments setup detail. This correction does not change pricing
or weaken the setup requirement.

Isolated persisted delivery, realtime retry and audience isolation are separate
from the native Resend transport test addressed only to `delivered@resend.dev`.
That transport proof did not claim an actual merchant inbox or the pending
Metronome/Stripe collection event. The October 5 read showed the 140-cent invoice as DRAFT
with no external Stripe invoice and a native issue time of October 5 11:00 UTC
after the native grace period.
That verification did not qualify native collection, monthly restoration, acceptance
or the resulting alerts. The October 6 observation above supersedes its provider state.

## Native financial contract

A connected Accounts v2 merchant owns direct charges and captured principal. The
platform pays Stripe fees, and Stripe manages connected-account losses. Checkout
explicitly sets application_fee_amount=0 so omission cannot invoke Platform Pricing.
No application-liability fallback exists. Refund/dispute principal follows Stripe
native semantics. Captured-volume usage remains billable after refunds/disputes.

The supported path uses Stripe-hosted onboarding, an Express Dashboard login-link
handoff, Radar and the native full service agreement. Krabiclaw never accepts the
merchant's agreement or stores KYC answers. Payments/Connect explicitly select the
central `2026-09-30.preview` pin in the existing Stripe client factory; default
Better Auth/billing callers retain `2026-08-26.dahlia`. Better Auth's separate inbound
subscription endpoint retains `2025-11-17.clover` and remains canonical.

Verified sandbox account on 2026-10-01: platform `acct_1ULcs2RBlJkGOR4x`,
connected account `acct_1ULddoRBlJCkNTaU`, livemode=false, dashboard=express,
fees_collector=application, losses_collector=stripe, requirements_collector=stripe.
After owner-completed hosted onboarding, card/payout capabilities are active with
zero requirements. Native direct capture/refund, hosted hold conversion and
merchant-approved rejection were verified; exact provider evidence is recorded in
`sandbox-verification-2026-10-01.md`. No liability fallback or live action occurred.

Primary contracts: [Managed Risk](https://docs.stripe.com/connect/risk-management/managed-risk),
[Accounts v2 responsibilities](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration),
[direct charges](https://docs.stripe.com/connect/direct-charges).

## Durable boundaries

`createProductBooking` is shared by public and MCP creation. Public booking
creation with required positive collection reserves an expiring hold and
waiting-on-guest request in one D1 batch before creating Stripe Checkout. MCP
passes the explicit no-financial-writes boundary and returns
`financial_action_required` with the authenticated product booking dashboard URL
before creating any Booking, hold, request, Checkout, Payment or authorization;
required collection and the product payment configuration stay unchanged.
The public booking hold uses the canonical allocator predicate,
including tenant/calendar-group half-open overlap exclusion. Holds expire after
60 minutes. Review-pending Bookings have no Checkout TTL and consume capacity.
Only authenticated native capture converts the hold to the canonical pending or
confirmed Booking and commits its lifecycle activity/operational ID atomically.
Late or unfulfillable capture creates an automatic full-principal refund intent.

Stripe account + livemode + native object identity scope every financial mutation.
The connected snapshot webhook is separate from the subscription handler; durable
outbox identity is namespaced by account/mode/event. Only minimal object identity
is retained. Stripe remains record authority; a webhook handler that fails
returns non-2xx and Stripe redelivers the event until the write lands.

### Paying on the site

The buyer pays on the business's own site at `/pay/<payment id>`, not on a hosted
Checkout. `createPaymentCheckout` opens a Stripe PaymentIntent on the connected
account (`payment_attempts.stripe_payment_intent_id`) and hands the browser the
page path and a purchase claim, carried in the URL fragment so no server, log or
referrer sees it. Stripe's Payment Element, mounted on the connected account in
deferred mode with the business's payment method configuration, collects the
method; `POST /api/public/payments/<id>/review` attaches it to the intent and
returns what the card will cost; `POST .../confirm` confirms exactly the reviewed
method and total, and the browser completes any 3DS with `handleNextAction` before
returning to `/account` with the claim. A succeeded confirmation settles at once
through `reconcilePaymentIntent`, and again, idempotently, from the webhook.

**Surcharge.** A business that opts in sets `surcharge_basis_points` on its
connected account. Stripe's native surcharge preview (`amount_details.surcharge`,
pinned by `STRIPE_PAYMENTS_API_VERSION`) says, per attached card, whether a
surcharge is `available` and its `maximum_amount`; the business's rate is applied
inside that bound and an ineligible card carries none. Stripe not answering is an
error, never a free payment. The surcharged total is confirmed with
`amount_to_confirm` and the named surcharge, so Stripe's receipts and refunds carry
it; `payments.surcharge_amount` records what Stripe charged.

**Expiry.** The buyer's time to pay is the attempt's `expires_at`. Every
availability query ignores a hold past it, and the confirm endpoint refuses an
attempt past it, so an unpaid intent simply stays unused at Stripe. A capture that
lands late anyway takes the unfulfillable-capture path and is refunded.

A business with Stripe Tax configured is refused (409 `stripe_tax_unsupported`)
rather than charged without the tax Checkout used to calculate.

The PaymentIntent is created only for a booked session through `createProductBooking`;
there is no merchant payment link or MCP order checkout. Existing one-time order
payments keep their immutable lines and Price snapshots and remain serviceable.
Native automatic tax is enabled only for a merchant with active configured Stripe
Tax settings/registrations. No registration or service taxability is invented.

Financial read, refund, dispute, payout and integration permissions are
separate. Refund and paid-review rejection require an actor-bound, expiring explicit
same-origin browser approval. MCP cancellation or rejection requiring a refund
returns an incomplete `financial_action_required` result and the existing booking
dashboard URL before changing state or preparing an authorization. Repeating that
handoff creates no financial records. MCP exposes only payment, summary, payout
history and operating-usage reads, plus `get_payments_dashboard_link` for a setup
URL lookup. Refund preparation/execution and Checkout creation are dashboard/public
booking operations. After authenticated browser approval, paid rejection commits
cancellation, allocation release and full refund intent in one guarded D1 batch;
provider retry and interrupted-refund recovery remain durable. Ordinary cancellation
is distinct.

Buyer ownership uses Better Auth identity. Signing in on any device reads the same
owned purchases. A guest acts on a business's own site as an anonymous Better Auth
user. Better Auth links that guest's records when they sign in in the same browser,
and a verified inbox links them anywhere: when a verified account gets a session, the
anonymous identities whose requests were all made with that email join it
(`server/utils/guest-accounts.ts`), because whoever controls the inbox already
received every confirmation and manage link sent to it. An email typed into a form
is never proof by itself, and no tenant membership is granted. There is no manual
transfer-code flow. Thank-you pages and guest confirmation emails invite the guest to
create the account at krabiclaw.com with the email they used. Hidden return tokens are one-time possession
proofs; the server retrieves the native PaymentIntent before conversion.
Financial parent FKs retain evidence; tenant deletion stores minimal servicing
relationships without retaining merchant credentials or recreating the tenant.

### Saved cards

A buyer's cards are saved with each business, never on KrabiClaw. On a business's
pay page a signed-in buyer pays as their Customer on that business's connected
account (`stripe_connected_customers`) through a Stripe customer session; the
Payment Element's own checkbox saves a new card there, offers those saved cards
again at that business only, and lets the buyer remove them. A Customer on the connected account is also what lets that
business charge a saved card later, as Stripe's recurring-payment guidance
requires. A guest pays without a Customer; Link remains Stripe's way to reuse cards
across businesses. KrabiClaw creates no platform Customer for buyers: the Better
Auth Stripe plugin's customers are the businesses' operating customers for their
subscriptions.

Deleting the account deletes the buyer's Customer at every business it paid, in
Better Auth's user delete database hook, which every deletion path runs
(self-service, admin removal, anonymous-account merge) while the mappings still
exist. Stripe removes the cards saved there and cancels any subscription the buyer
holds with that business. Each business keeps its charges, receipts, refunds and
disputes, and no connected account or business billing is touched. Deleting a
business does not touch buyers' Customers.

## Metronome operating billing

### Ad spend (Marketing plan)

The Marketing plan's usage fee is a share of Google Ads spend. The daily
`marketing:ad-spend-daily` task reads, for each business whose plan grants
`marketing` and whose Google Ads account is connected, Google's cost for the day
two days back (a day Google has finished counting), and queues it as an
`ad_spend` usage event (`google_ads:<customer>:<date>`, USD cents) delivered
through the same Metronome path as captured volume, as `payments_ad_spend`.
Metronome prices it at the ad-spend rate on the Payments rate card:
`validatePaymentsRateCard` accepts that third flat rate, and the plan screen and
`get_payments_usage` show it as `ad_spend_rate_percent`. A Google Ads account
in a currency other than USD, or a day whose spend changed after it was queued,
fails the task for that business rather than being converted or overwritten.

KrabiClaw Payments: **1.4% of payment volume, plus Stripe fees.** Billed after
use. KrabiClaw Payments fees aren't returned after a refund or dispute. The
subscription is billed separately. Public pricing follows the Stripe and
Metronome wording standard in `AGENTS.md`.

The seller-scoped buyer/connected account and the tenant's operating Stripe Customer
are different identities. Metronome collection requires the latter Customer's
invoice_settings.default_payment_method; a subscription-only default is insufficient.
Provisioning verifies native rate-card units/rates, SUM pricing_amount filters,
collection Customer, platform account and native contract uniqueness before use.

Metronome owns the effective captured-volume rate. The selected commercial rate
is 0.014 per USD cent (1.4%); attributable Stripe-cost events rate at 1 per cost
cent. The 1.337% in October 1–2 sandbox evidence was an internal test rate;
those dated historical proofs retain it and do not describe the approved price.
Refunds/disputes do not reverse captured-volume usage.
Integer minor units are explicit. Acceptance and billing use US/USD; incompatible
currency usage remains visibly undelivered rather than being converted or billed.

Actual fees come from native platform all_fees itemized reports, including tax.
Connected balance_transaction.fee alone is insufficient. Itemization can lag 96+
hours; a daily task requests the report covering the last 35 days for late
corrections, and Stripe's `reporting.report_run.succeeded` event on the platform
webhook ingests it and bills the usage. Unattributed items remain durable and are
never charged to a tenant.

Native invoice/grace/collection defaults govern billing. Late closed-period positive
costs roll to the current period as explicit adjustments. Negative closed/final
credits remain visible until an owner settles an issued native Stripe credit note
against the correct operating Customer/currency/exact amount. They are never lost
through a zero-floor metric. Post-cancellation/tenant-deletion servicing preserves
native mapping and delivery. The 34-day Metronome dedupe window is guarded: stale
or ambiguous attempted delivery requires acceptance reconciliation before retry.

Primary contracts: [Stripe fees reports](https://docs.stripe.com/reports/all-fees),
[Metronome ingest](https://docs.metronome.com/api-reference/usage/ingest-events),
[rate cards](https://docs.metronome.com/api-reference/rate-cards/get-rates),
[customer billing configurations](https://docs.metronome.com/api-reference/customers/fetch-billing-provider-configurations-for-a-customer).

## Setup and verification limits

Use the safe blank `.env.example` entries. Required provider setup: intended sandbox
test key, dedicated thin Connect and connected snapshot Payments secrets, synchronous
parent or dedicated seller payment-method configuration, Metronome test workspace/API key/USD rate card,
and HTTPS platform return origin. Keep the subscription secret separate. Complete
merchant-hosted onboarding and Radar before claiming native card readiness.
No Payments deployment, live webhook change or production activation is part of
this draft. The existing Sandbox-to-Stripe TEST grant was completed on October 2;
its dated evidence is in `requirements-verification-2026-10-02.md`.

Read-only native verification on October 4 found that actual Metronome USAGE
invoice `7a30b370-ea2e-5fd7-b432-77f925eeb7ee` collected through Stripe invoice
`in_1UMNvzRBlJkGOR4xdrITU49a`: test mode, USD 751 cents total and paid, no balance
credit. This differs from the scheduled synthetic invoice and earlier credit
exercise. Existing native partial capture, refund and dispute objects also remain
readable. The current canonical contract, rate-card and invoice readers passed
against these native objects. The intended Stripe integration's native "Leave
invoices as drafts" setting is off; that global setting is managed in Metronome
and is not returned by the contract API. These reads verify historical provider
outcomes and the current reader boundary; they do not qualify new acceptance or
create an application billing mapping.

Actual fee itemization requires live Stripe data and is unavailable in test mode.
Reconciliation reports that limitation explicitly. Current enabled acceptance,
hosted capture and provider delivery must be qualified through the application
with the intended sandbox configuration and an authorized commercial entitlement.
Current free/Growth plans deliberately reject new payment acceptance.

## Current local qualification — 2026-10-04

Rebased onto staging `454c1f6107b00733704f8aaaa24df9b29fb917b9`. The canonical
local setup verified 83 tables, 77,010 copied rows, five applied migrations and
no foreign-key errors. Supporting checks pass: 239 unit tests, 101 D1
tests, four migration tests, migration lint, schema drift, generated
MCP/submission parity, final quality and the production Worker build. The earlier full local Chromium run passed 97 tests and timed out in the font preset case's redundant network-idle
wait. That existing case then passed separately in 15.2 seconds against the built
Worker after retaining the canonical Nuxt hydration wait and removing network
idle. All outcome assertions stayed intact; independent settings read-back
confirmed the original tenant font and colour were restored.
GitHub Checks and E2E passed at `5ff09e66f`. Final local quality and the production
Worker build also passed after the production-only scheduled cleanup and
merchant Checkout retry corrections. The existing Payments D1 suite passed 6/6
after the retry correction.

The existing opt-in native consultation journey also passed separately against the fresh
production Worker build, along with all four pricing presentation cases. Manual
normal-sign-in review verified the current Payments panes, invalid UTC ranges,
mobile navigation, fractional-quantity blocking and persisted buyer bookings.
Empty financial history cannot qualify older-page pagination or native collection.

The intended Stripe sandbox catalog was applied through its canonical reviewed
plan and journal. Fresh native read-back shows no remaining catalog operations,
and the pricing, billing and OAuth browser journeys pass with that configuration.
The existing unrecognized sandbox product was preserved.

Final targeted source review found no blocking defect in the shared native
Payments pricing reader, Overview's use of that reader, Quick Tunnel host
classification and its security callers, the validated subscription success
return URL, or the font test's native hydration readiness. Overview reads current
contract pricing without depending on billing invoices or credits. Better Auth
owns subscription confirmation; the success URL preserves the requested plan,
and Billing removes the return query before considering another upgrade.

The new disposable site `commerce-payments-sandbox-october-4`, organization
`K7nV9Zn1JYJK8gXLceb9haThizkvBRmX`, was created through the normal dashboard
onboarding flow. Normal authenticated Commerce selection completed native Stripe
subscription Checkout in test mode. Independent native and Better Auth read-back
agree on Customer `cus_VNWeaZSkNWO7pu`, active monthly subscription
`sub_1UMlivRBlJkGOR4xEMQRt82k`, and the exact organization reference. Its first
subscription invoice `in_1UMlitRBlJkGOR4x4sdULvw8` is paid: $89 total and paid,
zero outstanding. The canonical billing decision is Commerce with
Payments enabled, for October 4–November 4. Proof was recorded at 09:32–09:34 UTC
in `.tmp/payments-native-commerce-subscription-proof.json` and
`.tmp/payments-commerce-better-auth-subscription-proof.json`.

The operating card was then set through Stripe's hosted customer portal. Native
read-back at 09:36 UTC confirms the same test Customer's
`invoice_settings.default_payment_method` is a card attached to that exact
Customer on platform `acct_1ULcs2RBlJkGOR4x`; the card and Customer are both in
test mode. This is recorded in
`.tmp/payments-native-commerce-customer-default-proof.json`.

Payments billing was provisioned through the application. Independent persisted
and native reads at 09:46 UTC confirm active mapping to Metronome Customer
`e70a8fe1-914a-455f-86b4-413637a7224d` and contract
`66a54a7c-fffe-4bf7-8b72-f8b9ebeea38d`. The exact tenant alias and contract
uniqueness key match; the contract starts October 4 at 09:00 UTC, has no
overrides, and its current effective rate is 1.4% of payment volume, plus Stripe
fees. Automatic collection targets the same operating Stripe Customer and
platform. This setup read is recorded in
`.tmp/payments-native-commerce-operating-billing-proof.json`; subsequent capture
and delivery evidence below supersedes its initial zero-usage snapshot.

After owner-completed Stripe-hosted onboarding, connected merchant
`acct_1UMlyXRBlJfhDVPn` was Ready. The application generated a one-time order
Checkout for the actual $100 USD test item, quantity one. Native charge time was
10:45:12 UTC. Independent Stripe and D1 read-back at 10:48:54 UTC confirms
payment `efc41898-6bfc-47b6-9d28-b6d585dc7fd9` is captured for 10,000 USD cents,
with zero tax and refunds. Checkout is complete and paid; PaymentIntent
`pi_3UMmuqRBlJfhDVPn0HWOhZwP` succeeded on that connected account in test mode,
with `application_fee_amount=0`. This proves the merchant-generated order link,
not a published website cart. Evidence is
`.tmp/payments-native-commerce-actual-capture-proof.json`.

The buyer browser was signed out before payment, then claimed the verified
purchase and opened the native Stripe receipt. In that same browser, ordinary
email sign-in retained the $100 purchase and receipt in Paul Luke — App Review's
history. Independent read-back at 11:02:33 UTC confirms payment and order now
belong to the named Better Auth user (`isAnonymous=0`, `emailVerified=1`), the
old anonymous user was deleted, and the frozen price snapshot and order line
are unchanged. The anonymous buyer had no memberships; the named account's six
memberships, including this merchant's owner role, all predate the claim. The
purchase granted no role. The claim remains consumed; its anonymous actor
reference is null after native deletion, not evidence of a named claim actor.
Hourly reconciliation completed the Checkout attempt at 10:48:21 UTC with no
error. Evidence is `.tmp/payments-native-linked-buyer-verified.json`; actual
screenshots are `.tmp/commerce-buyer-captured-purchase.png`,
`.tmp/commerce-native-buyer-receipt.png` and
`.tmp/commerce-buyer-linked-purchase.png`.

The original merchant form was retried with the same offering, quantity and
idempotency key after the named account link. This exposed a check that treated
mutable buyer ownership as part of the immutable purchase. The canonical
Checkout boundary now checks authenticated buyer ownership separately; authorized
merchant requests retain the original purchase checks. After rebuilding, the
same button returned the exact original Stripe Checkout link with no error.
Independent native and D1 reads confirm one payment, order, attempt, line, usage
event and consumed claim, with the original identifiers, buyer, snapshots and
timestamps unchanged. Evidence is
`.tmp/payments-native-merchant-replay-verified.json`; the transaction screenshot
is `.tmp/commerce-checkout-retry-final-transactions.png`.

The first native hourly invocation delivered usage but failed because
social-card cleanup required production-only Images credentials. The corrected
task skips copied images in known non-production environments; the canonical
dispatcher reports its explicit skip and still rejects real task failures.
The rebuilt hourly invocation returned `outcome: ok`, `noRetry: false`, with
that skip visible in the Worker log. Independent read-back at 11:03:04 UTC
confirms exactly one captured-volume event for 10,000 USD cents, delivered once
at 10:48:28.456 UTC, with no error or dead letter. Repeating the scheduler did
not duplicate the event or change its delivery timestamp. Evidence is
`.tmp/commerce-native-scheduler-trigger-after-fix.json` and
`.tmp/payments-native-commerce-scheduler-rerun-proof.json`.

Native collection is still unqualified. At 23:40:33 UTC on October 4, the native
contract-end operation returned 200 for the same contract
`66a54a7c-fffe-4bf7-8b72-f8b9ebeea38d`, setting `ending_before` to October 4 at
11:00 UTC. Independent native read-back at 23:41:35 UTC confirms the same
Customer, Stripe collection configuration and 1.4% rate, with the unchanged
`MONTHLY` schedule and October 1 billing anchor. Commerce subscription
`sub_1UMlivRBlJkGOR4xEMQRt82k` remains active at $89/month. Evidence is
`.tmp/payments-native-short-period-end.json` and
`.tmp/payments-native-short-period-readback.json`.

The resulting USAGE invoice `499ebcd9-2b07-52d5-ab89-133af897e15b` is `DRAFT`
for October 4 at 09:00–11:00 UTC. Quantity 10,000 at rate 0.014 gives 140 USD
cents ($1.40) before tax. Its native `issued_at` is October 5 at 11:00 UTC
(18:00 Asia/Saigon), and `external_invoice` is null. This shortens the genuine
usage period without waiting a month or changing the Commerce subscription;
the native 24-hour grace still precedes the scheduled issue time.

A normal Better Auth credential sign-in and exact-organization billing API read
returned 200 at 23:48:46 UTC. The application reports billing `closed`,
`pricing: null`, no pending usage, and the same 140-cent draft invoice with
`external_invoice` and `collection_invoice` null. This read-back is recorded in
`.tmp/payments-native-short-period-app-readback.json`.

Two issue-date update attempts returned 404: one for the previously observed
invoice `d16029da-c5b5-5fc7-b237-dc60cc8bcec9` at 23:34:45 UTC, and one for
the shortened-period invoice at 23:43:00 UTC. Both responses said the named
invoice could not be found in the contract. These attempts did not qualify an
earlier issue date. Evidence is `.tmp/payments-native-short-issue-attempt.json`
and `.tmp/payments-native-ended-period-issue-attempt.json`.

The native end intentionally paused new payment acceptance. The planned
qualification required the actual Metronome invoice and corresponding Stripe
collection invoice to be issued and paid, with identities, totals, amount paid
and amount remaining independently verified, before removing that native end
and verifying the unchanged monthly schedule and restored acceptance. The
October 6 read shows the contract reopened before that qualification was recorded.
Native `all_fees` itemization remains unavailable in test mode; reconciliation
reports `test_mode_unavailable`, and no estimated Stripe costs were ingested.
[Contract end semantics](https://docs.metronome.com/api-reference/contracts/update-the-contract-end-date),
[invoice grace period](https://docs.metronome.com/guides/implement-metronome/core-concepts/how-invoicing-works).

## CMS and staging release

The existing Products, Variants and Prices editor remains the canonical catalog.
Commerce enables online collection; Free and Growth retain bookings without
online payment. The shared booking-config writer checks the current canonical
Payments entitlement before enabling mandatory payment. The editor uses that
same plan policy and permits turning a previously enabled requirement off after
a downgrade.

Actual CMS verification on October 4 reproduced the unsupported save on the
Growth site's existing $75 local consultation. After rebuilding, that same old
editor received 403 with the visible Commerce requirement and no policy write;
disabling succeeded and a fresh editor disabled re-enabling. The Commerce test
item's calendar was configured through the same CMS solely to exercise payment
policy enable and disable, both independently read back from D1. Its original
no-calendar setup was restored through the editor. Product kind, $100 price,
publication and subscription state were preserved. Evidence is
`.tmp/payments-cms-final-persisted-read.json`, the enabled/disabled reads and
`.tmp/commerce-cms-growth-server-rejection.png`. Quality, 239 unit, 102 D1 and
4 migration tests passed, including rejected-write and downgrade-disable
invariants. The missing-plan UI branch fails visibly rather than inventing a
plan.

The normal new-question flow previously dropped its selected page during
Question/Answer navigation. Q&A now uses the supplied route query as the single
page selection source and carries it through creation, the saved-record redirect
and Back. Invalid supplied scope produces a visible 400 error. Actual CMS
creation published `Which plan includes online payments?` and `Can I take
bookings without online payment?` under `/pricing`. Create and Back retain the
Pricing selection; independent D1, rendered answers and FAQPage JSON-LD
read-back agree, and all 55 existing root Q&A records were unchanged during
creation. The new
answers refer to Commerce and the plans above rather than duplicating prices.
Evidence is `.tmp/payments-cms-qa-scope-final-proof.json` and the final
created/Back/public screenshots. An existing browser test now checks normal
scoped creation, exact HTTP/MCP reads, public rendering and return to the
selected list.

The browser regression also exposed a pane-width mismatch: CSS used the
canonical 992px theme value while navigation hardcoded 1024px. Navigation now
reads that CSS value and registers its existing automatic-selection watcher
after native Nuxt readiness, within the active component scope. The rebuilt
application opens the actual Question editor on a fresh 1000px visit without a
reload; at 900px, Close and Back retain Pricing. Evidence is
`.tmp/payments-cms-pane-final-proof.json` and its screenshots. The existing
browser test verifies both widths without changing its outcome assertions.

After that creation proof, the domain and hosting pricing FAQ answers had their
legacy `Grow` references corrected to `Growth` through the same CMS. Only the
two answers and their update timestamps changed; their publication and scope,
and all 55 other root Q&A rows, were preserved. Independent D1, rendered answers
and FAQPage JSON-LD agree. Evidence is
`.tmp/payments-cms-plan-name-proof.json` and its public screenshot. The canonical
Growth CTA also uses `Get Growth`; existing signup destination and redirect
assertions remain unchanged.

The public-read regression found that the HTML KV cache stored and served
preview responses despite their existing `private, no-store` policy. The shared
key now applies the canonical non-production/non-indexable host policy before
reads and writes, and the writer also rejects private/no-store/no-cache response
directives. Production public keys retain their build identity and TTL. The
rebuilt anonymous `/pricing` response is 200 with `private, no-store, max-age=0`,
no edge-cache hit, `Get Growth`, Commerce at $89/month and all four edited/created
FAQ answers in FAQPage JSON-LD. Evidence is
`.tmp/payments-cms-cache-public-proof.json` and its rendered public screenshot.
The existing normal CMS creation regression asserts these exact cache headers
as well as the saved question and answer becoming public.

CMS content edits are data changes, separate from schema and code deployment.
The two published pricing FAQ answers were corrected in the local test database
through **Reviews and Q&A → Pricing → Answer → Save**. They have not been copied
to staging or production. For each target, select **Reviews and Q&A → Q&A →
Pricing** and read both published and hidden questions before editing. Update the exact existing
question when present. If the reviewed question is absent, use **Add a question**,
complete **Question** and **Answer**, then set **Visibility → Published** and
choose **Create question**. The target creates its own record ID; never copy
local IDs or substitute an unrelated question. Publish the reviewed FAQ through
**Visibility** while preserving other questions' publication. Verify the saved
`/pricing` scope, rendered answers and FAQPage JSON-LD. Public plan prices and
the Payments fee phrase remain in their canonical pricing sources rather than
duplicated CMS fields. Existing customer product prices and publication are
preserved.

The canonical Growth catalog description and feature wording now match the
current staging copy. The reviewed Sandbox catalog plan applied one Product
metadata update, without changing Prices or subscriptions. Native read-back has
zero remaining operations; after the new application build, public plan and
Markdown reads show that wording and Commerce at $89/month with `1.4% of payment
volume, plus Stripe fees.` Evidence is
`.tmp/payments-catalog-copy-public-read.json` and the catalog plan/apply/read-back
journals.

Staging's deployed `/api/billing/plans` and actual public `/pricing` page reads
on October 4 show two plans only. Its six published FAQs do not include the
two local price/fee question titles; this public read does not establish whether
hidden target records exist. Inspect the target CMS before creating anything.
Before deploying this three-plan reader, verify staging's own configured Stripe
catalog using the reviewed plan/apply/read-back workflow in
[stripe-catalog.md](../operations/stripe-catalog.md). The isolated E2E Sandbox
catalog does not qualify staging's account. Then use the canonical schema and
release workflow, apply the target's exact CMS copy edits, and verify public
pricing, Markdown/LLM pricing and the actual CMS/payment journey. The migration
does not change product prices, publish content, enable payment requirements or
provision subscriptions. No staging deployment or content write has occurred.

## Historical local verification — 2026-10-02

The following notes describe the superseded implementation. Current validation
is recorded separately in the replacement PR; these notes do not qualify its head.

One-time browser observations are retained as screenshots and dated findings.
The bespoke proof specs and synthetic seed scripts were removed under #1225.
Use the canonical local setup and the actual CMS/account/guest surfaces for
manual verification; Google consent is a manual browser check.

Verified: production Worker build and typecheck; complete unit suite; migration
baseline/archived-table backfill; real D1 capture/hold race, late-capture refund,
review rejection, claim atomicity, cost corrections, signed webhook replay,
separate merchant fulfillment and historical servicing. Browser proof covers
current-tier acceptance rejection without financial writes, merchant access, refund preparation and browser approval page, buyer ownership,
unsigned/tampered/signed webhook ingress and replay, forged return-proof rejection.
Inspected desktop and mobile transaction screenshots. Provider doubles prove local
boundaries only; native account creation is the separately documented sandbox proof.

Downgrade marks the usage contract for historical servicing. Billing owners can
explicitly end the native contract after queued usage and outstanding checkout/
refund work settle. The native `updateEndDate` call forbids changing finalized
invoice boundaries; it does not archive or void invoices. A subsequently itemized
historical cost reopens that same contract through the documented open-ended update,
then delivers an explicit adjustment. This servicing path never grants new payment
acceptance. Negative finalized credits still require the native credit-note path.
[Metronome contract end semantics](https://docs.metronome.com/api-reference/contracts/update-the-contract-end-date).
Native end/reopen/rating proof remains part of the provider configuration verification.

## Replacement review

Anonymous purchasers retain their native Better Auth session when opening the
ordinary login or signup forms. Only named sessions redirect away from those
forms. Better Auth's anonymous plugin owns the account link; the existing
`onLinkAccount` callback transfers purchases before the anonymous identity is
deleted. Same-browser named-account retention was verified through ordinary
email sign-in on October 4; the current qualification above records the native
ownership read-back and actual purchase/receipt screenshots.

This branch replaces the Payments work previously combined in #1213 and #1224.
The separate Calendar PR owns Google projection and member scheduling. Dated
sandbox and review documents in this directory retain historical evidence.

Dated screenshots and review notes are historical observations, not evidence for
this PR's revised head. The current PR records checks against its final staging
base. Commerce and its sandbox qualification are part of this change; merge and
deployment remain separate decisions.
