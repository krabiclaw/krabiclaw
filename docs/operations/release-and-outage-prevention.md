# Release and Outage Prevention

This contract applies to work that changes, deploys, or releases user-facing
runtime behavior or database schema. It keeps the release path simple and makes
customer behavior, rather than release bookkeeping, the approval signal.

## Release rule

KrabiClaw uses a branch-driven flow: a
pull request deploys nothing, a push to `staging` deploys the staging Worker,
and a push to `main` deploys production. Each environment receives one normal
Cloudflare Worker deployment. Do not add candidate manifests, version-override
headers, Worker UUID tracking, custom release locks, or repository rollback
commands.

Green CI is necessary, but it is not release approval. As soon as an environment
is deployed, start the relevant browser and MCP checks while the remaining CI
jobs continue. Automated E2E and manual browser evidence are independent gates;
neither must wait for the other to begin.

### Release-owner emergency override

The release owner may explicitly waive waiting for an incomplete qualification
check for one named release when production already has a material
customer-facing regression and delay would prolong the incident. The owner must
acknowledge the incomplete gate and authorize the promotion directly. Do not
infer an override from urgency, prior releases, or general deployment access.

Before promotion, record the customer impact, the exact checks being waived or
left incomplete, and the required post-deploy verification in the promotion
pull request or merge record. Begin production verification as soon as the
deployment converges. If the affected journey is not restored, use Cloudflare's
ordinary deployment history to restore the last known-good Worker and continue
incident recovery through the normal release flow.

This override cannot waive a known reproducible first-party failure,
database-epoch or migration safeguards, production data protections, or the
restriction on production writes and notifications without an explicit canary.

Validation follows product risk:

1. Test the affected tenant journey first.
2. Check all three customer sites for shared public changes.
3. Expand the retained tenant matrix only for shared renderer, routing,
   theme, content-model, or destructive content-migration changes.

A reproducible first-party failure blocks promotion. An operator-closed tab or
an isolated third-party timeout is not an application failure; retry the
inspection once to determine ownership, then report the actual result.

## Normal release sequence

1. Keep one coherent bugfix or feature in one ready pull request targeting
   `staging`. Split work only when the changes are independently releasable.
2. Run the E2E suite locally against a local D1 (`yarn e2e:local:prepare &&
   yarn test:e2e:local`). Pull-request CI runs `Checks` and its own isolated
   local-D1 E2E suite; there is no preview deployment.
3. Merge to `staging` after required PR checks and local validation pass.
4. When staging deploys, begin read-only MCP and tenant browser validation
   immediately.
5. Open or update the ordinary `staging` to `main` pull request. It reuses the
   completed checks attached to that exact staging SHA without another deploy,
   provisioning pass, or CI qualification cycle.
6. Promote only after the required checks on that exact SHA and the scoped
   customer validation pass.
7. After production deploys, repeat the affected read-only customer journeys
   and production smoke. Use an explicit canary identity for any production
   action that writes or sends notifications.

Production deployment and verification remain separate jobs. Verification
must confirm that customer-domain HTML, Nuxt build metadata, and referenced
assets have converged on the exact deployed build before browser coverage
starts. Retry only the verification job after a verification failure; do not
redeploy a healthy production Worker to repeat browser checks.

GitHub workflow runs and Cloudflare's native deployment history are sufficient
release evidence. Do not invent a second mapping between Git commits and Worker
version identifiers.

## Browser and MCP verification

Use the browser state appropriate to the behavior. Anonymous public routes may
use a fresh context. OAuth and MCP checks must use a credentialed tenant account;
rendering the login page does not validate authentication.

For an auth or MCP change, exercise the deployed flow end to end:

- OAuth protected-resource and authorization-server discovery;
- credentialed authorization with PKCE and token exchange;
- bearer-authenticated MCP `initialize` and `tools/list`;
- `get_workspace_context` and a tenant-scoped read such as `list_organizations`;
- the affected safe write or media journey when tool behavior changed;
- one real ChatGPT app session when the defect involves ChatGPT tool selection,
  attachment delivery, or host-provided file arguments.

For affected tenant routes, verify the final URL, tenant identity, visible copy,
first-party media, primary navigation and calls to action, console errors,
failed first-party requests, hydration errors, blank sections, and late content
disappearance. Mutating form, booking, and MCP interactions belong only on local
disposable data. Staging and production checks stay read-only unless
a dedicated canary is explicitly authorized.

Verification means completing what the customer came to do, up to the last
read-only step. Opening a class means opening its booking form and seeing a
time to choose; opening a dish means its price and photograph; opening a
service means its page in the site's own design. A page that renders with an
empty state is a failed check unless that emptiness is the tenant's own data.
Row counts, foreign-key checks, and `typecheck` describe the database and the
build; none of them is a customer journey, and a cutover is not verified until
one has been walked on each representative surface. On 2026-09-12 a catalog
cutover passed every count — 406 products, 627 prices, 0 FK violations — while
no class on any site had a bookable time, because nobody opened a booking form.

The representative client order is:

1. Pottery House: home, experiences and details, locations, contact, and
   reservations.
2. Kikuzuki: home, menu and items, locations, and reservations.
3. NCLS: home, services and details, pricing, articles, contact, and schedule.
4. KrabiClaw's own site: home, documentation, blog, and the help form. It is an
   ordinary site on the platform template, so it is qualified like a tenant.
5. For lodging changes on staging, Saltleaf Stays: home, the homes index and a
   home detail, nightly availability and the guest booking form. Use the
   [fictional lodging demo](lodging-demo.md); inspect existing calendar, Airbnb
   and guest-message state without resetting the demo or sending a message.

For a shared renderer, routing, theme, content-model, or destructive
content-migration change, expand that representative set to every published
route using the sitemap and fixture inventory. Check desktop and narrow/mobile
layouts and full-page media composition. A route that was not opened remains
unverified, but unrelated route families do not block a narrowly scoped change.

## Migration and content safety

All Cloudflare D1 databases, including replacements, must be created with
`--location wnam` (Western North America). Do not omit the location hint or
create an APAC database. Confirm the creation result reports WNAM before
adding the binding or loading any data.

Change `server/db/schema.ts` first, then use `yarn db:generate` to add a forward
migration under `migrations/`. Keep every migration already applied to a live D1
immutable. A normal staging or production deployment runs `wrangler d1
migrations apply` before the Worker deploy; new tables, columns and indexes use
that path. Run `yarn lint:migrations`, `yarn lint:schema-drift` and `yarn
test:migrations` locally, then check schema drift and `PRAGMA foreign_key_check`
on each deployed database.

SQLite cannot alter a CHECK constraint in place. When a constraint on a table
referenced by other tables must change, Drizzle generates a table rebuild whose
`DROP TABLE` can cascade-delete D1 child rows. That case alone uses a replacement
database. Name the constraint and affected references in the pull request. A
replacement gets a new generated baseline and a fresh D1 migration ledger; move
the prior SQL and metadata intact to `migrations-history/<version>/`. Never edit
an already deployed migration and ask D1 to replay it under the same filename.

The replacement is prepared while the old Worker stays live. Use the existing
`scripts/pull-production-snapshot.ts` path for preflight, initial load and final
delta, specifying the old database with `--source`. The script refuses
unexpected source tables or columns, validates copied rows, checks foreign keys
and target schema, and previews rows changed or deleted since the initial
export. The delta inserts newly created rows only. Remote `--delta-from` sends
the whole payload to D1's normal query API as one atomic batch, retaining
foreign-key deferral and keeping SQL out of process arguments. Bulk imports
make D1 unavailable while they run. During replacement, use bulk import only
for the initial load before the new database is bound. Inspect changed and
deleted keys before retiring the old database; carry important edits explicitly,
without overwriting new-database writes. There is no write freeze or
maintenance response in the application.

For the v7-to-v8 integrations replacement, create empty v8 databases with
location hint `wnam` and apply the generated baseline with `wrangler d1
migrations apply`. Never execute the SQL file directly: its migration ledger
must record it. The transfer recognizes the immutable v7 chain in
`migrations-history/v7/` and copies account, session, OAuth and `jwks` rows
from each environment's own source. Local development omits encrypted
production keys.

The replacement drops `organization.integrations_json` and its CHECK
constraints from the parent of nearly every table, and
`business_locations.description_provenance`. Each JSON connection becomes one
`organization_integrations` row; a key that is not one of the four providers,
a status other than `active`, or a missing account, target or measurement id
fails the transfer, as does any `description_provenance` value.

```sh
node --experimental-strip-types scripts/pull-production-snapshot.ts --source krabiclaw-staging-v7 --out staging-preflight.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v7 --out staging-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v7 --out production-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v7 --out staging-final.sqlite --delta-from staging-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v7 --out production-final.sqlite --delta-from production-initial.sqlite
```

The v8-to-v11 catalog replacement removes product tags and custom field
definitions. Every product has an explicit `kind` and a validated `details_json`
object with named fields for that kind. Products are referenced by variants,
options, publication, location offerings, collections, booking configuration,
sessions and content documents; rebuilding the parent in place could delete
these rows. The immutable v8 and intermediate v9 chains live in
`migrations-history/v8/`, `migrations-history/v9/` and `migrations-history/v10/`.
The v11 baseline also validates the canonical consultation settings column and
scopes localized route uniqueness and lookup indexes by organization.

The canonical transfer maps existing product types and known descriptive fields,
including translations. Unknown or incompatible fields fail the transfer.
Existing bookings, sessions, prices, credentials and each environment's signing
keys are preserved. Both v11 databases were created with `--location wnam` and
Cloudflare reported WNAM before loading:

- `krabiclaw-production-v11`: `ef5d6da1-7feb-4b6e-93a9-aa3677eefea7`
- `krabiclaw-staging-v11`: `6ec294fd-6ac9-4da6-9463-1e1f088f49d3`

Prepared copies do not change deployed Workers. Before switching their bindings,
finish the ordinary final source delta and inspect changed or deleted keys. Copy
each environment from its own live v8 source:

```sh
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v8 --out staging-v11-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v8 --out production-v11-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v8 --out staging-v11-final.sqlite --delta-from staging-v11-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v8 --out production-v11-final.sqlite --delta-from production-v11-initial.sqlite
```

Prepare the load before the binding repoint. Inspect changes and deletions since
the initial load immediately before deployment; carry important edits explicitly
and preserve writes to the new database. After each deployment, verify schema,
foreign keys and customer journeys on the new binding before promoting further.
The repoint changes every `DB` binding in `wrangler.toml`, including `env.dev`
and `env.e2e`: local D1 state is keyed by database id, so an environment left on
the old id opens an empty database and the E2E suite fails on the next pull
request rather than on the repoint commit, whose push to staging skips E2E.

The v11-to-v12 replacement drops `organization.feature_overrides` and
`business_locations.feature_overrides` and their CHECK constraints (#1267):
site capabilities come from the organization's vertical and theme alone.
`organization` is the parent of nearly every table and `business_locations` is
referenced too, so neither column could be dropped in place. The v11 chain,
including its forward migrations `0001`–`0005`, is archived in
`migrations-history/v11/`; an older chain reaches v11 through those forward
migrations before the copy. A non-null override fails the transfer; staging and
production held none on 2026-10-05. Both v12 databases were created with
`--location wnam` and Cloudflare reported WNAM before loading:

- `krabiclaw-production-v12`: `27366e55-3b79-48db-9593-29a163a00dff`
- `krabiclaw-staging-v12`: `799c4af0-5d61-4102-ad3a-d3f8f8fedaaf`

```sh
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v11 --out staging-v12-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v11 --out production-v12-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v11 --out staging-v12-final.sqlite --delta-from staging-v12-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v11 --out production-v12-final.sqlite --delta-from production-v12-initial.sqlite
```

The v12-to-v13 replacement gives each site one palette and each logo placement
a presentation (#1274, #1276). `organization` drops
`organization_config_brand_color_check`, `organization_theme_saya_check`,
`organization_theme_blawby_check` and `organization_theme_by_template_object_check`
and gains `organization_config_palette_check` and
`organization_config_font_preset_check`; `media_placements` gains
`presentation_json` with `media_placements_presentation_check`. `organization`
is the parent of nearly every table, so the CHECK changes could not be made in
place. The v12 chain (`0000_baseline`, `0001_requests_guest_email`) is archived
in `migrations-history/v12/`; an older chain reaches v12 through its forward
migration before the copy. The transfer maps each Saya `config.brand_color` to
`config.palette`: Saya's template palette with that color as the light action
and its dark-mode variant as the dark action. `theme_by_template` is dropped only
when its tokens are Blawby's defaults, and any other value fails the transfer.
Every Saya `logo` placement gets the circle presentation it always rendered in.
On 2026-10-06 production carried three Saya brand colors and NCLS's default
Blawby tokens. Both v13 databases were created with `--location wnam` and
Cloudflare reported WNAM before loading:

- `krabiclaw-production-v13`: `57d494c8-b322-4584-a5f4-e2cc40d3d7b7`
- `krabiclaw-staging-v13`: `bc7d411b-b836-4b83-9771-3e09561463e3`

```sh
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v12 --out staging-v13-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v12 --out production-v13-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v12 --out staging-v13-final.sqlite --delta-from staging-v13-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v12 --out production-v13-final.sqlite --delta-from production-v13-initial.sqlite
```

The v13-to-v14 business-workflow replacement adds Better Auth's native `team`
and `teamMember` tables, and native `invitation.teamId`. Product booking settings
can select one member or one native team. `content_documents` gains generated
`document_role` and a source-locale foreign key to the site's authored language;
its children include blocks, placements and publication records.
`organization_locales` gives that source language a unique owner per site.
`reservations` stores the policy actually accepted, and Checkout holds distinguish
booking and reservation allocations. These referenced-parent constraints use a
replacement baseline, not a D1 parent-table rebuild. The complete applied v13
SQL and Drizzle metadata remain unchanged in `migrations-history/v13/`.

The transfer retains source identities, memberships, sessions, OAuth clients and
signing keys from each environment's own v13 database. It keeps the site's actual
source language and all booking commitments. Native teams start empty. New
reservation duration/deposit fields, historical accepted reservation policies,
and historical financial billing bases remain unknown until their canonical
owner supplies the facts; today's settings are never backfilled as past terms.
Oversized text rows are reconstructed from bounded SQL chunks during the same
native D1 import, without truncation. The import-only helper table is removed
before row-count, schema and foreign-key verification.

Both v14 databases were created with `--location wnam` on 2026-10-08, and
Cloudflare reported WNAM before binding or loading:

- `krabiclaw-production-v14`: `dad88350-88f8-4036-8cf2-d73c458d6060`
- `krabiclaw-staging-v14`: `2c172842-4e77-4cf3-b1c0-f1d1ec0d32ba`

Apply the generated baseline with native `wrangler d1 migrations apply`, then
use the existing transfer for each initial load and final delta. Keep the old
Worker live until the normal staging/main release changes its binding. Review
changed and deleted keys in the final manifests before carrying customer edits.

```sh
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v13 --out staging-v14-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v13 --out production-v14-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v13 --out staging-v14-final.sqlite --delta-from staging-v14-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v13 --out production-v14-final.sqlite --delta-from production-v14-initial.sqlite
```

The v14-to-v15 replacement changes only
`product_booking_configs_calendar_check`: a nonempty `calendar_group` may
also group physical sessions. `product_availability_rules` and
`product_sessions` reference that parent with cascading deletes, so the
constraint must not be rebuilt in place. The complete applied v14 SQL and
Drizzle metadata remain unchanged in `migrations-history/v14/`. The schema
adds no tables or columns, and the transfer copies v14 rows without changing
customer, identity, OAuth, signing-key, booking or payment values.

Prepared in WNAM on 2026-10-08: production v15
`9684d350-f15c-41bb-93c6-437651b72459` and staging v15
`3809d51b-2153-4f5b-bcf3-265329492115`. Preparation does not switch a live
Worker's binding.

Prepare an empty WNAM database with the generated baseline and native migration
ledger, then use the same preflight, initial-copy and final-delta procedure
above with each environment's own v14 source. Review all changed and deleted
keys before switching: the canonical delta carries new rows only, never
updates or deletions. Keep the v14 database and its Worker version intact.
Rebinding to v14 after v15 writes is not a data-preserving rollback; preserve
and reconcile those writes before any such rebind. Older runtime code also
must not serve physical calendar groups it cannot enforce.

The v15-to-v16 epoch makes the clocks and currencies a business, location and
online offering cannot run without strictly required, and replaces shared
calendar groups with provider-owned working hours (the Calendly model):

- `organization.default_currency` is NOT NULL and validated via `organization_default_currency_check`.
- `organization.timezone` is a new NOT NULL column (`organization_timezone_check`), moved out of `settings_json.config.default_timezone` with no `'UTC'` fallback. Both are Better Auth required organization fields validated in `server/utils/auth.ts`.
- `business_locations.timezone` is NOT NULL (`business_locations_timezone_check`).
- `product_booking_configs.held_online` replaces `online_timezone`. Online offerings require `scheduling_mode='provider'` and an assigned member or team (`product_booking_configs_held_online_check`).
- `calendar_group` is retired everywhere (`product_booking_configs`, `payment_checkout_holds`). Online offering bookable slots are persisted from provider working hours (`member_scheduling.windows_json`) in each provider's timezone. Archived epoch transfers invoke the same provider-hours generator before auditing and writing the payload; missing provider hours stop the transfer. The manifest inventories derived session IDs and source signatures so `--delta-from` retains their canonical occurrences and unchanged audit timestamps, reports actual source deletions, and inserts only new rows without overwriting replacement writes. Repeated generation preserves unchanged slot timestamps, bookings and active checkout holds.
- `product_availability_rules.location_id` is NOT NULL; online weekly rule templates are deleted.
- `product_sessions` enforces `product_sessions_online_provider_check` (`location_id IS NOT NULL OR assigned_member_id IS NOT NULL`). Existing online sessions take their provider's identity and `hours:<member>:<starts_at>` occurrence keys.

The complete applied v15 SQL and Drizzle metadata remain unchanged in
`migrations-history/v15/`.

Prepared in WNAM on 2026-10-13: production v16
`754caf79-1e59-4e5e-93d7-18449df90e3b` and staging v16
`76622a9c-bb92-4c1d-ab2c-206ff2594600`.

The v16-to-v17 epoch makes a place to stay a Product (#1381). It is additive
except for one constraint, which is why it needs a replacement database:

- `products_kind_check` admits `stay`. The constraint is on `products`, which
  `product_variants`, `product_options`, `product_locations`,
  `product_booking_configs`, `product_sessions`, `bookings`,
  `collection_products`, `product_publications`, `content_documents` and
  `reviews` reference (and now `product_stay_configs`), so the change is a
  table rebuild.
- `product_locations` gains the unique `(organization_id, product_id,
  location_id)` index that `product_stay_configs` references.
- New tables: `product_stay_configs`, `product_nights`, `stays`, `stay_nights`
  and `stay_payments`. They start empty.
- Existing rows transfer unchanged; no product changes kind. The transfer audits
  `every_home_has_stay_settings`.

The complete applied v16 chain (`0000_baseline` through
`0007_payment_intents`) and its Drizzle metadata remain unchanged in
`migrations-history/v16/`; an older export passes through its forward
migrations before the copy.

Prepared in WNAM on 2026-10-14: staging v17
`a9c8e8f0-eb44-4058-b251-f629276de5b5`, built with `wrangler d1 migrations
apply` and loaded from `krabiclaw-staging-v16` (87 tables, 78,725 rows;
`foreign_key_check` empty); its final delta after the staging binding moved
reported no new rows and nothing changed or deleted. Production v17
`e81e48eb-8ac6-4c9e-af31-5cef2946c52d` was created in WNAM on 2026-10-15,
built with the same baseline and loaded from `krabiclaw-production-v16`
immediately before the staging-to-main promotion; the v16 databases stay
untouched.

```sh
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v15 --out staging-v16-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v15 --out production-v16-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --staging --source krabiclaw-staging-v15 --out staging-v16-final.sqlite --delta-from staging-v16-initial.sqlite
node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source krabiclaw-production-v15 --out production-v16-final.sqlite --delta-from production-v16-initial.sqlite
```

The v17-to-v18 epoch lets a guest conversation be held by phone alone (#1381
step 4). It changes one constraint, which is why it needs a replacement
database:

- For stay conversations, `requests_guest_payload_check` requires the guest's
  name and an email or phone, where v17 required an email. Other conversation
  kinds still require email. Airbnb guests and host-entered stays often have
  no email. The constraint is on `requests`, which `activity_entries`,
  `bookings`, `reservations`, `stays` and the review and payment-hold tables
  reference, so in place it is a table rebuild that would cascade-delete every
  thread's timeline.
- Nothing else changes. The v18 baseline also absorbs v17's forward chain
  (Channex connections, channel mappings, the sync log, night pushes and
  `stays.request_id`). Its only other difference from the applied v17 chain is
  where `stays.request_id` sits among the columns, which the transfer copies by
  name.
- Existing rows transfer unchanged. A conversation with neither an email nor a
  phone is still refused.

Channel revisions and cancellations still apply when optional guest details
are cleared. The conversation retains its recorded participant as history;
email replies use the stay's current email and refuse when it is absent. A host
edit cannot remove the last contact from an existing stay conversation.

The complete applied v17 chain (`0000_baseline` through `0005_stay_threads`)
and its Drizzle metadata remain unchanged in `migrations-history/v17/`. An older
export passes through v17's forward migrations before the copy, after the stage
gains the v17 baseline's tables it never had.

Both v18 replacement databases were created with `--location wnam` on
2026-10-16 (Asia/Bangkok), and Cloudflare reported WNAM before configuration
or data loading:

- `krabiclaw-staging-v18`: `872459c4-70e4-4d2a-907c-d5a2951efd9b`
- `krabiclaw-production-v18`: `8d953c89-a6cd-4ade-b7c4-1eb6d372adbd`

Build each with native `wrangler d1 migrations apply`, then load it from that
environment's own v17 database using
`scripts/pull-production-snapshot.ts --source krabiclaw-<environment>-v17`.
Preparation and loading must finish before the deployment-triggering binding
change merges: the old database has already recorded `0000_baseline.sql`, so
D1 will skip the replacement baseline and the live schema-drift gate will
refuse it. Phone-only conversations cannot run against v17's email CHECK.
All four `DB` bindings, including `env.dev` and `env.e2e`, move to v18.

Deploy staging first and qualify its customer journeys before promoting to
production. Immediately after each binding moves, take the canonical final
delta, inspect changed and deleted keys, and reconcile important edits without
overwriting writes made to v18. Keep v17 intact until that review and the schema,
foreign-key and customer-journey checks pass.

The v18-to-v19 epoch admits channel-addressable Airbnb inquiries in the one
guest inbox (#1381 step 4.2). `requests_guest_payload_check` now accepts an
explicit channel participant with the provider's conversation title and nullable
actual guest name, email and phone. A contact-backed payload keeps its existing
requirements; an invalid present participant never becomes a contact payload.
Because `requests` is referenced by the activity, booking, stay, review and
payment tables, changing this CHECK requires another replacement database.

The unchanged v18 migration SQL and metadata are archived in
`migrations-history/v18/`. The v19 baseline adds `channel_threads`, which maps a
provider conversation and optional booking to one local request and home, and
admits Channex/Airbnb delivery receipts. No source conversation, activity entry,
delivery receipt, authentication row or OAuth token is transformed. An inquiry
adopts an existing stay conversation when one exists; two existing conversations
produce an explicit association conflict instead of moving or deleting history.
The `product_channel_mappings_stage_check` and enabled-stage CHECK also admit a
Messages import stage after reservation loading. A failed message read remains
visible at that stage and can be retried without repeating the reservation
write or claiming the conversation history is complete.

The same v19 baseline also carries the rest of #1381 step 4 as additive schema,
so it needs no forward migration of its own: `device_tokens` (an APNs device of
one Better Auth session, cascading with the session and user), the per-category
push preference, private `product_stay_configs.check_in_instructions`,
`message_templates`, `scheduled_guest_messages` and
`stays.booking_received_at`. Copied v18 rows get no device, no template, no
scheduled message, no instructions and a null `booking_received_at`: only a
direct stay created after cutover is a newly received reservation, so a
new-reservation schedule never messages a historical or imported stay. A saved
v18 category preference predates push; the transfer gives it that category's
product push default, the same value a person who never saved the category
gets, and records the `notification_preferences_push_default` transform. A
v18 chain is recognized from `migrations-history/v18/`.

Prepare separate WNAM v19 databases from each environment's own v18 database
using the canonical snapshot path above. Keep the replacements unbound until
their schema, copy invariants, foreign keys and local source gates pass. Before
and after cutover, inspect canonical delta changes/deletions and reconcile only
reviewed source edits with guards that preserve replacement writes. Do not run
the new Worker against a v18 binding: its migration ledger already contains the
same baseline filename. Real Airbnb message/webhook/reply qualification against
KrabiClaw remains required.

Both v19 replacement databases were created with `--location wnam` on
2026-10-16 (Asia/Bangkok), and Cloudflare reported WNAM before the baseline was
applied:

- `krabiclaw-staging-v19`: `036d7910-66a9-4343-9ae4-47398dd3c653`
- `krabiclaw-production-v19`: `3baf9b09-2c05-4ed8-8944-cafe9e84c9e3`

Staging v19 was loaded from `krabiclaw-staging-v18` before the binding change
merged: 100 tables, 81,340 rows, `foreign_key_check` empty, one transform
(`notification_preferences_push_default`, 2 rows).

The staging binding uses v19. The top-level production binding, and the
development and E2E bindings that share its local D1 id, stay on
`krabiclaw-production-v18` until production v19 is loaded from it; local schema
still comes from the v19 baseline in `migrations/`. All three move together in
their own change immediately before promotion.

Production v19 was loaded from `krabiclaw-production-v18` while unbound: 100
tables, 100,371 rows, `foreign_key_check` empty, the native `0000_baseline.sql`
ledger, one transform (`notification_preferences_push_default`, 4 rows). The
top-level production, development and E2E bindings then moved to
`krabiclaw-production-v19` together, immediately before promotion; take the
production final delta from v18 right after the deployment.

The v19-to-v20 catalog replacement narrows `products_kind_check` to the four
supported offering kinds: food or drink, Experience, Legal Services and lodging.
The Products parent is referenced by variants, prices, locations, publications,
bookings and stays, so an in-place table rebuild would risk those rows. The full
v19 chain, including `0023_stay_check_in_end_time.sql`, is archived unchanged in
`migrations-history/v19/`; `migrations/0000_baseline.sql` is generated from the
current schema. No existing offering is reclassified or discarded. Transfers
refuse unsupported offering identities, complete missing archived forward
migrations and retain v19 session identities and timestamps without regenerating
provider hours. Home property classifications must be either fully unknown or a
complete valid category/type pair; the baseline CHECK refuses partial NULL pairs.

The later live-home/import change remains an applied v19 forward migration at
`migrations-history/v19/0024_airbnb_import_draft.sql`. The v20 chain carries the
same child-preserving SQL as `0001_airbnb_import_draft.sql`; its generated
metadata describes the merged schema. The existing v20 baseline is unchanged.
Apply that forward migration to a prepared replacement before its final delta.
It changes channel-mapping CHECKs without changing columns or primary keys, so
the original v19-to-v20 snapshot remains the comparison artifact. Migration
verification covers populated channel children and a final delta across this
forward change. The production replacement receives this pending migration
through the normal production release procedure before its own cutover.

The later Airbnb sync-job change is archived unchanged as v19 migration0025
and becomes v20 `0002_airbnb_sync_jobs.sql`. Apply it before the final delta;
it adds the job table and the mapping's `import_written` fact. Transfer manifests
record the target migration filenames. A delta advances a private in-memory copy
of its original comparison through the canonical forward migrations, so new
tables and columns participate without rewriting the original artifact or
recreating the prepared database. Earlier artifacts must match exactly one
recorded schema stage; an ambiguous or unrecognized stage fails visibly.

On 2026-10-23 production and staging had no physical-item Products. The replacement
databases were created with `--location wnam`, and Cloudflare reported WNAM before
binding or loading either:

- `krabiclaw-staging-v20`: `5403dba1-cfae-4d9b-b441-6e0d2207f6f0`
- `krabiclaw-production-v20`: `e6bb3bd4-da9c-42d2-b0b7-beec8a4bd320`

Prepare each replacement from its own v19 source using the canonical snapshot
path, preserving that environment's signing keys. Verify the full transfer
invariants and independently read the stored counts, foreign-key checks, baseline
ledger and retained catalog kinds. Repository bindings point
to the prepared copies; deployed Workers continue using v19 until an authorized
deployment. Before each cutover, take a fresh delta with `--source
krabiclaw-staging-v19` or `--source krabiclaw-production-v19` and the corresponding
initial v20 snapshot as `--delta-from`. Review changed/deleted keys, carry important
source edits without overwriting replacement writes, and verify deployed schema,
foreign keys and guest journeys before retiring either v19 database. Production,
development and E2E bindings move together.

The v20-to-v21 replacement widens `stays_channel_check` to admit `booking_com`,
so Booking.com reservations arriving through Channex land as stays. `stays` is
referenced by `stay_nights`, `stay_payments`, `scheduled_guest_messages` and
`team_threads`, so the CHECK cannot change in place. The full v20 chain,
including `0006_channex_ari_outbox.sql`, is archived unchanged in
`migrations-history/v20/`; `migrations/0000_baseline.sql` is generated from the
current schema and differs from the complete v20 chain only in that CHECK.
Every v20 row fits the v21 baseline unchanged; no transform applies. A v20
source completes its missing archived forward migrations before the copy, and
older epochs reach v20 through its baseline and forward chain.

Create `krabiclaw-staging-v21` and `krabiclaw-production-v21` with `--location
wnam`, confirm Cloudflare reports WNAM, and apply the baseline with `wrangler d1
migrations apply` before loading either. Load each from its own v20 database
with `--source krabiclaw-staging-v20` or `--source krabiclaw-production-v20`
while it is unbound, keeping the initial artifact for the final delta. The
staging binding moves first; production, development and E2E bindings move
together immediately before promotion. Take each final delta from the v20
source right after its deployment, review changed and deleted keys, and verify
schema, foreign keys and guest journeys before retiring either v20 database.

`krabiclaw-staging-v21` (`1a8c3656-d005-46e0-a1cf-d33579c3c21a`) was created
with `--location wnam` on 2026-10-24, and Cloudflare reported WNAM before the
baseline was applied. It was loaded from `krabiclaw-staging-v20` while unbound:
113 tables, 99,128 rows, `foreign_key_check` empty, the native
`0000_baseline.sql` ledger, no transforms. The staging binding uses v21; its
final delta from v20 carried three rows and left three OAuth rows whose only
change was `updatedAt`.

`krabiclaw-production-v21` (`f18a888c-e52e-4c76-b5d6-9a8c11acb165`) was created
with `--location wnam` on 2026-10-24, and Cloudflare reported WNAM before the
baseline was applied. It was loaded from `krabiclaw-production-v20` while
unbound: 113 tables, 121,149 rows, `foreign_key_check` empty, the native
`0000_baseline.sql` ledger, no transforms. The top-level production,
development and E2E bindings move to it together, immediately before
promotion; take the production final delta from v20 right after the
production deployment.

Before dropping or retiring a legacy table or writer:

- remove every runtime reader and writer;
- inventory any records that require mapping into the canonical schema;
- fail on unmapped records rather than silently discarding them;
- apply the migration locally from a clean database and from the prior schema;
- compare the resulting schema and run `PRAGMA foreign_key_check`;
- repeat a read-only schema and foreign-key check after deployment.

When a change turns a value the runtime computed into rows the runtime reads
— a schedule into sessions, a flag into a placement — the same change ships
whatever creates those rows, unattended, and the migration derives them for the
data already there. A CMS button is not a generator. The check for such a
change is the surface that reads the rows, not the count of rules that would
have produced them.

A change that deletes or moves a public route lists every retired path and what
answers it now, in the pull request: a restored route, or a deliberate 404 with
the reason. A retired path is not redirected — a 301 keeps the retired shape
addressable and reachable forever, which is the thing the deletion was for, and
it hides from every caller that the route it holds no longer exists. The same change updates the
production verification spec, the template sitemap allowlist, and any robots
rule that named the path — those three are where a retired route keeps
answering after the page is gone. Customer-facing names are decided with the
owner before a route is renamed: a schema word is not a navigation label.

Never rebuild a referenced parent table with `DROP TABLE`; D1 may execute foreign-key actions during a generated rebuild. An obsolete unreferenced table may be dropped in the same release once these checks pass. Do not retain inert tables or compatibility code for an extra release as a substitute for proving the migration.

Never reseed or hand-mutate production to hide a renderer, routing, or migration bug. Preserve customer data and fix the source of truth.

## Incident recovery

When a deployed customer journey is broken:

1. Identify the affected environment, client routes or MCP operations, and the
   observed first-party failure.
2. Use Cloudflare's ordinary deployment history to restore the last known-good
   Worker without changing D1 data.
3. Re-open the affected customer journeys, including the relevant client sites
   and authenticated flows.
4. Repair the source in one narrow pull request through the normal `staging`
   and `main` branch flow.

Do not build a custom rollback system or delay emergency stabilization for
release bookkeeping.

## Handoff

Report what landed, which environment deployed, which customer journeys were
actually exercised, and what remains unverified. Do not call platform-only
checks client-site verification, a rendered login page an auth pass, or a
scripted request a real ChatGPT tool-usage pass.
