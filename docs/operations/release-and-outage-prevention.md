# Releases and outages

This applies to work that changes, deploys or releases user-facing runtime
behavior or database schema. Customer behavior, not release bookkeeping, is the
approval signal.

## Release flow

A pull request deploys nothing, a push to `staging` deploys the staging Worker,
and a push to `main` deploys production. Each environment gets one ordinary
Cloudflare Worker deployment. GitHub workflow runs and Cloudflare's deployment
history are the release record; do not add release manifests, version headers,
release locks or rollback scripts.

1. Keep one coherent change in one pull request targeting `staging`.
2. Pull-request CI runs `Checks` and the E2E suite against a local D1.
3. Merge to `staging` once those pass, and start read-only MCP and browser
   checks on staging as soon as it deploys.
4. Open or update the `staging` → `main` pull request. Promote only after the
   checks on that exact SHA and the customer checks pass.
5. After production deploys, repeat the affected read-only customer journeys.
   Any production action that writes or sends notifications uses an explicit
   canary identity.

Green CI is necessary but is not approval. A reproducible first-party failure
blocks promotion. Retry a failed verification job; do not redeploy a healthy
Worker to repeat browser checks.

The release owner may waive an incomplete check for one named release when
production already has a customer-facing regression and waiting would prolong
it. Record the impact, the waived checks and the post-deploy verification in the
promotion pull request. An override never waives a known reproducible failure,
migration safeguards or production data protections.

For every iOS App Store submission, select **Automatically release this
version**. For an existing external TestFlight group, select **Automatically
notify testers**.

## iOS API compatibility

Keep the routes and response fields used by supported iOS builds working while
those builds are installed, including during App Review. Ship API changes
additively, deploy the compatible server first, and then release the iOS build.
Remove an old route or field once supported builds no longer use it.

Before promoting a native API change, run the affected authenticated requests
in the existing deployed verification suite. Open the affected screens against
the deployed staging API with the demo workspace, using Debug builds from the
exact source revisions of the oldest supported iOS build and current TestFlight
candidate. Include any newer shipped App Store build whose API contract differs.
If a supported build cannot complete the journey, fix the server before
promotion. After deploy, repeat the affected read-only journeys in the actual
distribution builds against production.

## Queue and webhook cutover

A release that adds a Cloudflare queue creates it, and its dead-letter queue,
in both environments before the push that binds it: the deploy fails on a
missing queue. Airbnb sync and disconnect steps run on `blawby-airbnb-sync`
(`blawby-airbnb-sync-staging` on staging), one delivery at a time.

After the deploy, the `adopt-pending-work` step re-queues every pending
`airbnb_sync_jobs` row there. Check the `blawby-airbnb-sync` dead-letter queue
when qualifying a release that changes Airbnb synchronization.

## Verifying a release

Verification means completing what the customer came to do, up to the last
read-only step: opening a class shows a time to book, a dish shows its price and
photo, a legal service shows its page in the site's design. An empty state is a
failure unless the emptiness is the tenant's own data. Row counts, foreign-key
checks and typecheck are not customer journeys.

For tenant routes, check the final URL, tenant identity, copy, first-party
media, navigation and calls to action, console errors, failed first-party
requests, hydration errors and content that disappears after load. Check every
customer site a shared public change touches, and Blawby's own site, which is an
ordinary site on the platform template.

For an auth or MCP change, run the deployed flow end to end: OAuth discovery,
credentialed authorization with PKCE and token exchange, bearer-authenticated
`initialize` and `tools/list`, `get_workspace_context`, a tenant-scoped read,
and the affected write on local data. A rendered login page is not an auth
check. Use a real ChatGPT session only when the defect is about ChatGPT's tool
selection, attachments or host-provided arguments.

Writes, bookings and MCP mutations belong on local disposable data. Staging and
production checks stay read-only unless a canary is explicitly authorized.

## Schema changes

Create every D1 database with `--location wnam` and confirm Cloudflare reports
WNAM before binding or loading it.

Change `server/db/schema.ts`, then run `yarn db:generate` for a forward
migration. Never edit a migration that a live database has applied. Deployment
runs `wrangler d1 migrations apply` before the Worker deploy. Run
`yarn lint:migrations`, `yarn lint:schema-drift` and `yarn test:migrations`
locally, then check schema drift and `PRAGMA foreign_key_check` on each deployed
database.

Never rebuild a referenced parent table with `DROP TABLE`: D1 may run
foreign-key actions during the rebuild. When a CHECK constraint on a referenced
table must change, either rebuild and drop every child first, or use a
replacement database.

A replacement database gets a new generated baseline and moves the previous
migrations to `migrations-history/<version>/`. Prepare it while the old Worker
stays live with `scripts/pull-production-snapshot.ts`: run the read-only
preflight against the live source (`--source`, `--out`) and keep its report,
bulk-load the unbound database, repoint the binding, wait for old HTTP and cron
invocations to finish, then load the final delta with `--delta-from`. The delta
only inserts rows the initial copy did not hold, so it never overwrites a write
already made on the replacement; it names every row that changed or was deleted
on the source since the initial copy, and those are carried over by hand.

Before dropping a table or writer, remove every runtime reader and writer, map
any records the canonical schema still needs, and fail on unmapped records
rather than discarding them. When a change turns a computed value into stored
rows, the same change ships what creates those rows and derives them for
existing data.

A change that deletes or moves a public route lists every retired path and what
answers it now. Retired paths are not redirected. Update the production
verification spec, the sitemap allowlist and any robots rule that named the
path.

Never reseed or hand-edit production to hide a renderer, routing or migration
bug. Fix the source.

## Incident recovery

1. Identify the environment, the broken routes or MCP operations, and the
   first-party failure.
2. Restore the last known-good Worker from Cloudflare's deployment history,
   without changing D1 data.
3. Re-open the affected customer journeys.
4. Land the source fix through `staging` and `main`.

## Handoff

Report what landed, where it deployed, which customer journeys were actually
exercised, and what remains unverified.
