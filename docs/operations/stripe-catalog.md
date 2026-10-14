# Stripe catalog operator plan

`scripts/seed-stripe.mjs` reconciles the new-sale recurring catalog for Basic
(free, with no Stripe product), Growth (`$49` per month or `$588` per year), and
Commerce (`$89` per month). Commerce includes Growth's features and Payments and
has no annual price. Every plan includes 2 locations; Growth and Commerce charge
`$49` per additional location per month (`$588` per year on annual Growth).

Each paid plan price is one graduated Stripe price whose subscription quantity
is the number of locations it covers: the first tier (up to 2) is a flat fee of
the plan amount, the second is the per-location amount for every further unit.
The product's `unit_label` is `location`. Keeping it one price on one
subscription item is what lets Better Auth's plan changes and its location
quantity changes (`seats`) use Stripe's portal confirmation, which refuses
subscriptions with more than one item. `shared/billing-model.ts` owns the fixed
USD amounts and the tiers (`planPriceTiers`). Managed (`$149`)
and SEO Accelerator (`$349`) are retired from new offers. Every product and
price, including already-archived products and inactive or one-time prices, is
read into the reviewed snapshot. Only products whose metadata explicitly names
`plan_id=managed|seo_accelerator` or `addon_type=translation|seasonal|gbp_setup`
are retired; unknown products are never classified by name. For each still-active
retired product whose default price is active, the plan first clears that exact
default price, then deactivates every independently active price before archiving
the product, including duplicates. Inactive products are never cleared or
archived. Retired products are never created, updated, or marketed, and an absent retired product
produces no operation. Retired plan
identities are not valid runtime entitlements; the runtime sale model accepts
only Basic, Growth and Commerce. Historical fulfillment rows remain raw read-only audit
history, while archiving a product or price prevents new purchases.

The script does not create one-time credit, add-on, or auto-top-up products, and
it never changes a price amount.

The default mode is read-only. It proves the exact Stripe account, lists every
product and all of its active and inactive prices, writes no product/price/file
mutations, and emits a deterministic JSON plan with a SHA-256 hash. The full
`pricesByProduct` snapshot is included in `providerSnapshotSha256`, so expected
price state is covered by the signed plan and every destructive precondition:

```bash
STRIPE_SECRET_KEY=rk_test_... yarn stripe:catalog:plan \
  > .tmp/stripe-catalog-plan.json
```

When the reviewed change is limited to retiring unused catalog families, use
the signed retirement-only scope. It requires exactly one active canonical
Growth product with an active USD 49 monthly price and, when an annual price is
present, an exact USD 588 annual price, but emits no Growth product,
price, or image operation and does not require the local Growth image:

```bash
STRIPE_SECRET_KEY=rk_test_... yarn stripe:catalog:plan -- \
  --retirement-only --plan-file .tmp/stripe-retirement-plan.json
```

The scope is part of the plan schema and SHA. Missing or ambiguous Growth
identity, a wrong monthly amount, or any other Growth safety drift fails closed;
the plan then contains only metadata-classified retirement operations.

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
`stripe-plans:v6:<actual app.buildId>` for up to one hour. Tenant CMS content
purges do not refresh this global entry. A genuine new application build selects
a fresh entry; restarting the same built Worker retains its persistent cache.
After catalog changes, verify the actual public plan and Markdown reads as well
as the native zero-operation read-back.

Paid-plan changes also require the target account's native Stripe customer
portal configuration. Better Auth Stripe uses `subscription_update_confirm` for
its hosted confirmation. Enable subscription updates, allow price and quantity
changes, and select only the canonical offered Product/Price IDs from that
account's verified catalog; after a price replacement, select the new IDs.
Quantity is how an owner adds or removes locations on their plan. Read the saved products with
`expand=['features.subscription_update.products']`; the ordinary configuration
response omits them. Preserve existing cancellation, payment-method, invoice,
proration and timing settings unless the operator explicitly changes them.
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
and configured image first. Commerce does not require a product image. The full
planner also reconciles the existing Site Language catalog family.
For active retired products, it clears a signed active default price before
deactivating prices and archiving the product. The planner never invents an
annual amount when no annual price exists. The operator re-reads the provider
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
matches exactly; retired Managed/SEO overrides are rejected. The signed plan
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

The snapshot also records every open subscription billed on a paid plan product
(its status, schedule, and items' price and quantity). A subscription on a
non-canonical plan price gets a signed `migrate_subscription_price` operation
before any price is deactivated: its one item moves to the canonical price for
its interval at quantity `max(2, current quantity)`, with
`proration_behavior: none`, which charges the same amount. A subscription with a
schedule or more than one item fails planning closed. The subscription's
reviewed state is its precondition, and an already-moved item is recognized on
resume. Deactivating a price does not change a subscription on it; migration is
what keeps Better Auth able to resolve every subscription's plan.

A price replacement changes what the deployed Worker accepts as canonical, so
apply it to an account together with the application release that reads that
shape: the previous build rejects the new prices and the new build rejects the
old ones.

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
key for the selected mode with read-account plus the catalog/file permissions required for
this task, and subscription write when the plan migrates subscriptions;
never place a key in a plan file or commit it.

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
