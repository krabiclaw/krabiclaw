# Stripe catalog operator plan

`scripts/seed-stripe.mjs` reconciles the new-sale recurring catalog for Basic
(free, with no Stripe product), Growth (`$49` per month) and Business (`$149`
per month). Business includes Growth's features, online payments and managed
Google Ads campaigns. Each plan price is one flat monthly price billed at
quantity 1; there is no annual offer.

Everything else a plan bills is a metered price on a Stripe billing meter, each
its own product with `product_family` set to the meter key (never a `plan_id`):

| `product_family` | Meter event | Formula | Price | Plans |
| --- | --- | --- | --- | --- |
| `locations` | `krabiclaw_locations` | `last` | graduated: 2 included, then $49 per additional location per month | Growth, Business |
| `homes` | `krabiclaw_homes` | `last` | graduated: 2 included, then $9 per additional home per month | Growth, Business |
| `captured_volume` | `krabiclaw_captured_volume` | `sum` | 0.014 cents per cent (1.4% of payment volume) | Business |
| `stripe_cost` | `krabiclaw_stripe_cost` | `sum` | 1 cent per cent (Stripe fees at cost) | Business |
| `ad_spend` | `krabiclaw_ad_spend` | `sum` | 0.1 cents per cent (10% of monthly ad spend) | Business |

`BILLING_METERS` in `shared/billing-model.ts` owns these definitions and their
Stripe phrasing. The plan creates a missing meter (`create_meter`, mapping
`stripe_customer_id` and `value`) before the price on it, reuses an active meter
with the same event name, and refuses one that aggregates differently. A meter's
formula cannot change; deactivate a wrong one in Stripe before planning. The
metered prices are the plans' Better Auth `lineItems`, so Checkout adds them and
Growth → Business is one `subscription.upgrade` (`docs/payments/payments.md`).
`/api/billing/plans` and the Better Auth plan loader both refuse a catalog
without exactly one active product per meter at its published price, so apply
the offers before deploying an application that sells them.

The graduated per-location plan prices sold before #1503 and the annual Growth
price are retired for new sales by the full plan's `deactivate_price`
operations. Rental units are not billed: the Additional rental unit product
(`product_family=rental_units`) is a retired family, so the full plan clears its
default price, deactivates its prices and archives it. Subscriptions on any of
them keep their items until they change plan.

Commerce (`$89`), Marketing (`$99`),
Managed (`$149`) and SEO Accelerator (`$349`) are retired from new offers. Every
product and price, including already-archived products and inactive or one-time prices, is
read into the reviewed snapshot. Only products whose metadata explicitly names
`plan_id=commerce|marketing|managed|seo_accelerator`,
`addon_type=translation|seasonal|gbp_setup` or `product_family=rental_units` are retired; unknown products are never classified by name. For each still-active
retired product whose default price is active, the plan first clears that exact
default price, then deactivates every independently active price before archiving
the product, including duplicates. Inactive products are never cleared or
archived. Retired products are never created or marketed, and an absent retired
product produces no operation. Commerce and Marketing remain valid existing
subscription identities with their original capabilities; they cannot be
purchased as new subscriptions or selected as a plan change. Existing customers
retain their exact price IDs, quantities, schedules and renewal terms. Better
Auth Stripe owns their subscription lifecycle. Historical fulfillment rows
remain raw read-only audit history.

The script does not create one-time credit, add-on, or auto-top-up products, and
it never changes a price amount or writes a subscription. Google bills the ad
spend itself; the ad-spend meter bills only KrabiClaw's 10%.

The default mode is read-only. It proves the exact Stripe account, lists every
product and all of its active and inactive prices, writes no product/price/file
mutations, and emits a deterministic JSON plan with a SHA-256 hash. The full
`pricesByProduct` snapshot is included in `providerSnapshotSha256`, so expected
price state is covered by the signed plan and every destructive precondition:

```bash
STRIPE_SECRET_KEY=rk_test_... yarn stripe:catalog:plan \
  > .tmp/stripe-catalog-plan.json
```

For a replacement offer, use the two signed scopes to keep the deployed
application and provider catalog compatible throughout the cutover:

1. Generate and apply an `--offers-only` plan. It creates or reconciles current
   offers without clearing defaults, deactivating prices or archiving products.
2. Deploy the application that sells Growth and Business and resolves existing
   subscriptions on their historical prices through Better Auth.
3. Update the account's native customer portal configuration before retirement.
   Add the new offered Product/Price IDs and retain the exact historical entries
   needed for existing subscriptions' quantity confirmations. Stripe validates
   every submitted price as active when saving this product list, including
   unchanged entries. An already-saved historical entry continues to support
   native quantity confirmation after its product and price are archived.
4. Generate and apply an `--retirement-only` plan. It archives the retired
   families only after proving exactly one active canonical Growth and Business
   product and their flat USD 49 and USD 149 monthly prices. It emits no offer product, price or image mutations and does not need
   local product images.

```bash
node scripts/seed-stripe.mjs --dry-run --require-test-mode --offers-only \
  --plan-file .tmp/stripe-offers-plan.json
node scripts/seed-stripe.mjs --apply --require-test-mode \
  --plan-file .tmp/stripe-offers-plan.json --confirm-sha256 <offersPlanSha256> \
  --journal-file .tmp/stripe-offers-apply.json

# Deploy through the canonical application release workflow and update the
# native customer portal configuration before retiring existing price entries:
node scripts/seed-stripe.mjs --dry-run --require-test-mode --retirement-only \
  --plan-file .tmp/stripe-retirement-plan.json
node scripts/seed-stripe.mjs --apply --require-test-mode \
  --plan-file .tmp/stripe-retirement-plan.json --confirm-sha256 <retirementPlanSha256> \
  --journal-file .tmp/stripe-retirement-apply.json
```

Use `--require-live-mode` for the authorized live account. Scope flags are only
for plan generation; apply reads the signed scope from the reviewed file. The
scope is part of the schema and SHA, and conflicting scope flags are rejected.
Missing or ambiguous replacement offers, or an incorrect price, fail closed.
The default full scope reconciles offers and retirements together; use the two
scopes above when application support must be deployed between those operations.

Release preflight runs the same read-only planner with an explicit test-mode
guard. The guard is checked before the Stripe client is constructed, and all
provider reads use zero automatic retries and a 10-second timeout. Plan
generation also fails if the required local Growth product image is absent:

```bash
STRIPE_SECRET_KEY=rk_test_... node scripts/seed-stripe.mjs \
  --dry-run --require-test-mode --plan-file .tmp/stripe-catalog-plan.json
```

Catalog reconciliation is an explicit operator workflow and is not coupled to
application deployment. Staging releases verify the configured webhook and a
real test-mode checkout journey, while catalog drift is planned, reviewed, and
applied separately with the commands below. This prevents unrelated product
metadata copy from blocking an application or incident release.

Public plan reads share the canonical `ORGANIZATION_CACHE` catalog entry
for the actual application build for up to one hour. Tenant CMS content
purges do not refresh this global entry. A genuine new application build selects
a fresh entry; restarting the same built Worker retains its persistent cache.
After catalog changes, verify the actual public plan and Markdown reads as well
as the native zero-operation read-back.

Paid-plan changes also require the target account's native Stripe customer
portal configuration. Better Auth Stripe uses `subscription_update_confirm` for
its hosted confirmation. Enable subscription updates, allow price and quantity
changes, and add the canonical offered Product/Price IDs from that account's
verified catalog. Retain historical Product/Price entries for existing
subscriptions' quantity changes, including entries whose product or price will
be archived; removing them can prevent native confirmation on the original
contract. Archive retired products and prices to exclude them from new plan
choices, and verify the actual portal's available alternatives after archival.
Better Auth's saleability guard also rejects new subscriptions and plan changes
to retired identities. Quantity is how an owner adds or removes locations on
their plan. Read the saved products with
`expand=['features.subscription_update.products']`; the ordinary configuration
response omits them. Preserve existing cancellation, payment-method, invoice,
proration and timing settings unless the operator explicitly changes them.
Save this configuration while all submitted prices are still active: Stripe
rejects an updated product list containing inactive prices even when those
entries were already present. A failed API response is not a saved change; read
the expanded configuration back and compare the exact products and settings.
Verify an actual Better Auth plan-change confirmation and its signed webhook
read-back. New subscription Checkout alone does not qualify an existing
subscription's plan-change flow. The catalog planner does not configure this
portal, and the isolated E2E Sandbox configuration does not qualify staging.
[Stripe portal configuration](https://docs.stripe.com/api/customer_portal/configurations/update),
[native confirmation flows](https://docs.stripe.com/customer-management/portal-deep-links).

Review the plan and its `providerSnapshotSha256`, `operations`, and fixed
amounts. Apply only the reviewed file, with the exact hash copied from its
`planSha256` field:

```bash
STRIPE_SECRET_KEY=rk_test_... yarn stripe:catalog:apply -- \
  --plan-file .tmp/stripe-catalog-plan.json \
  --confirm-sha256 <planSha256> \
  --journal-file .tmp/stripe-catalog-apply.json
```

`--journal-file` is mandatory for every apply. The operator writes the journal
atomically before the first provider mutation. It is keyed to the exact plan
SHA, provider snapshot SHA, Stripe account ID, and selected account mode; reusing
the path for any other plan, snapshot, account, or mode is refused. Each operation is recorded as
`pending`, `running`, `applied`, or `failed` with only sanitized IDs/URLs and
error evidence. A failed apply exits non-zero with `status=incomplete`; review
the journal and resume the same signed plan only after the named action is
safe. The journal never claims compensation or completion when a provider
mutation may have succeeded without a durable result.

The signed operation order creates or reconciles each offered plan's canonical
product, required monthly price, any supported unambiguous existing annual price,
and configured image first. Business does not require a product image. The full
planner also reconciles the existing Site Language catalog family.
For active retired products, it clears a signed active default price before
deactivating prices and archiving the product. The planner creates an annual price only when the canonical offer defines its
exact amount. The operator re-reads the provider
and proves that no canonical operation remains before each deactivation or
archival mutation. Every operation re-checks its
reviewed provider precondition, and already-applied operations are skipped only
when the provider state matches the journal evidence. On completion, a fresh
provider snapshot must produce zero remaining operations against the same desired model;
otherwise the journal remains `incomplete` and a new reviewed plan is required.

If the read-only snapshot contains more than one active product for an offered plan, plan
generation fails closed and prints every conflicting product ID. Resolve the
ambiguity explicitly when regenerating the plan with that plan's override:

```bash
STRIPE_SECRET_KEY=rk_test_... yarn stripe:catalog:plan -- \
  --canonical-product growth=prod_...
```

The override must name an offered paid plan and an active product whose `metadata.plan_id`
matches exactly; retired-plan overrides are rejected. The signed plan
records its resolved `canonicalProductIds` selection. For every non-canonical
offered-plan duplicate, and for every active retired product, the plan deactivates
all active prices (recurring or one-time) and archives the product, each guarded by the
reviewed provider snapshot. An active retired default price is cleared first;
canonical offered products and inactive products are not cleared. There is no
automatic first-product selection.

For an existing canonical product, the canonical monthly and annual prices are
the active prices exactly matching the definition (`desiredPriceParams`):
currency, interval, billing scheme and tiers or unit amount. Product metadata
selects among identical candidates; more than one identical candidate without
it fails closed. A price at any other amount or scheme is not canonical: the
plan creates the matching price, points the product's metadata and default
price at it, and deactivates the old one. The configured `seat_price_id` is
never selected or deactivated. The plan snapshot includes each price's tiers,
`lookup_key` and normalized metadata, so these inputs are covered by the review
hash.

The signed snapshot records every open subscription billed on an offered or
retired paid plan product, including already-archived products. It includes the
status, schedule, billing-cycle anchor, cancellation and trial settings,
collection method, and each item's exact price ID, quantity and billing-period
boundaries. Every apply read and the final read-back must match that contract
snapshot. A concurrent subscription change stops the apply visibly; review and
regenerate the plan rather than overwriting the change.

Catalog reconciliation never migrates, reprices, changes quantities, releases
schedules, or otherwise updates subscriptions. Stripe's native archival blocks
new sales while existing subscriptions continue on their original prices. Better
Auth's plan definitions retain the original exact historical price IDs so signed
webhooks can resolve them even after archival. A customer-initiated plan or
location change continues through Better Auth's native hosted confirmation.
[Stripe product and price archival](https://docs.stripe.com/products-prices/manage-prices).

Apply defaults to test mode (`sk_test_` or `rk_test_`). Live apply requires
`--require-live-mode` on the reviewed plan and apply commands. Apply is refused
unless the key and plan have the selected mode, the
plan hash is intact, the confirmation matches exactly, the plan is
bound to the current exact Stripe account, local image files still match
their planned hashes, and the provider snapshot is unchanged when a new
journal starts. During resume, each pending operation revalidates its signed
target and canonical safety boundary against a fresh snapshot. A failed
operation performs no mutation from that operation; earlier journaled
operations remain applied and are reported as such. Use a restricted
key for the selected mode with read-account, subscription read and the catalog/file
permissions required for this task. Catalog apply needs no subscription write.
Never place a key in a plan file or commit it.

For an authorized production catalog change, use the configured live key in the
environment and retain the same account, snapshot, SHA and journal safeguards:

```bash
node scripts/seed-stripe.mjs --dry-run --require-live-mode \
  --plan-file .tmp/stripe-live-catalog-plan.json
node scripts/seed-stripe.mjs --apply --require-live-mode \
  --plan-file .tmp/stripe-live-catalog-plan.json \
  --confirm-sha256 <planSha256> \
  --journal-file .tmp/stripe-live-catalog-apply.json
```

The two mode guards are mutually exclusive and are checked before constructing
the Stripe client. Omitting the live guard cannot apply a live key or plan.

## Existing Stripe CLI authentication

For an account already authorized through the current Stripe CLI, select its
private configuration explicitly instead of supplying an API key:

```sh
node scripts/seed-stripe.mjs --dry-run --require-test-mode \
  --stripe-cli-config .tmp/stripe-cli.toml --offers-only \
  --plan-file .tmp/stripe-cli-catalog-plan.json
node scripts/seed-stripe.mjs --apply --require-test-mode \
  --stripe-cli-config .tmp/stripe-cli.toml \
  --plan-file .tmp/stripe-cli-catalog-plan.json --confirm-sha256 <planSha256> \
  --journal-file .tmp/stripe-cli-catalog-apply.json
```

The explicit test/live guard is mandatory. The operator verifies `stripe whoami
--format json` account and mode, pins that exact account context on each API
request, and checks the account API response. Apply retains the same signed
account, snapshot, SHA, contract-preservation and journal guards. The configured
profile must already target the intended authorized account; the script does
not switch accounts or authenticate a new session.

Stripe's SDK still owns serialization and provider errors. Its custom HTTP
transport delegates requests to native `stripe get` and `stripe post`, retaining
actual HTTP status, response headers, API version and idempotency keys. The CLI
owns its credentials and automatic refresh; the operator never extracts or
persists keychain tokens. An inherited `STRIPE_API_KEY` is removed from the CLI
subprocess so it cannot override the explicitly selected configuration.

CLI transport currently rejects product-image upload operations during apply
preflight, before any mutation. Use the configured account API key for a plan
requiring an image upload. Catalog-only plans without such operations use the
same canonical planner and apply implementation. Ownership cutover remains an
API-key operation.
[Stripe CLI authentication](https://docs.stripe.com/cli/login),
[CLI HTTP requests](https://docs.stripe.com/cli/post).

## Organization metadata and webhook cutover

The same operator script has an explicit `--ownership-file` mode for the Epoch 5
handoff. Ownership mode accepts the
inventory's exact account and mode, including live, and changes only Customer
metadata, non-canceled Subscription metadata, and the existing webhook URL. Run
this during the canonical release cutover, before removing the old webhook route
from production. Execute only for the exact environment and account authorized
by the operator.

Create a private JSON inventory from the verified epoch export's Better Auth
Organization customer IDs and the read-only Stripe endpoint census:

```json
{
  "accountId": "acct_REPLACE",
  "mode": "live",
  "organizations": [{ "organizationId": "REPLACE", "customerId": "cus_REPLACE" }],
  "webhook": {
    "endpointId": "we_REPLACE",
    "fromUrl": "https://krabiclaw.com/api/billing/webhook",
    "toUrl": "https://krabiclaw.com/api/auth/stripe/webhook"
  }
}
```

Use the configured environment key. Keep inventory, plan and journal outside Git;
the plan includes provider identifiers and ownership metadata.

For an endpoint-only cutover, set `organizations` to `[]` and provide the exact
existing `webhook` inventory. This preserves customer and subscription state.

```sh
node scripts/seed-stripe.mjs --ownership-file /private/ownership.json --dry-run --plan-file /private/ownership-plan.json
node scripts/seed-stripe.mjs --ownership-file /private/ownership.json --apply --plan-file /private/ownership-plan.json --confirm-sha256 REVIEWED_SHA --journal-file /private/ownership-journal.json
node scripts/seed-stripe.mjs --ownership-file /private/ownership.json --verify-ownership
```

The plan records original and proposed values. It sets Customer
`organizationId`/`customerType=organization` and Subscription `referenceId`,
removes the obsolete `organization_id` metadata key, and preserves all other
metadata. Canceled subscriptions cannot be updated through Stripe: their exact
metadata is retained, and ownership is established by their customer. Prices,
quantities, invoices, subscription lifecycle fields, webhook ID, events, status,
API version and signing secret are unchanged. The script rejects conflicting
ownership, account/mode mismatch, new/deleted provider objects and drift from the
reviewed snapshot. A retry with the same plan accepts already-applied operations;
request idempotency keys and a private journal protect partial completion.

For rollback while the reviewed provider state still matches, use the same plan
and hash with `--rollback-ownership --apply` and a separate journal path. This
restores exact original metadata and endpoint URL. Generate a fresh plan before
any later forward cutover so it receives new request idempotency keys. If the snapshot changed,
reconcile the changes under the release rollback procedure; do not force this
command through drift. The post-apply read verifies the full reviewed object
snapshot, including unchanged billing terms. Verify the Worker receives a signed
webhook at the canonical path and use the existing event replay/reconciliation
operator path for retained failed events. Preserve expired dead-letter tombstones;
provider-retention expiry does not justify creating replacement historical events.

Supported provider APIs: [Customer metadata update](https://docs.stripe.com/api/customers/update),
[Subscription metadata update](https://docs.stripe.com/api/subscriptions/update),
[Webhook endpoint URL update](https://docs.stripe.com/api/webhook_endpoints/update),
and [canceled subscription restrictions](https://docs.stripe.com/billing/subscriptions/cancel).
