# Local development

**Status: Contract**

There is one local setup path for humans and agents:

```sh
corepack yarn install
corepack yarn local:setup
corepack yarn dev
```

Copy `.env.example` to `.env` and fill the required application secrets before
setup. `.env` is the single local configuration for Nuxt, Wrangler, setup scripts,
and E2E tests; `.env.example` is the maintained template. Both `yarn dev` and
`yarn dev:worker` use port 3000 by default.

`yarn dev` also starts a second local Worker, `krabiclaw-guest-inbox-hub`, from
`server/cloudflare/dev/wrangler.toml`. Wrangler's platform proxy cannot host a
Durable Object whose class lives in the proxied Worker, so under `nuxt dev` the
`GUEST_INBOX_HUBS` binding (`[env.dev]` in `wrangler.toml`) reaches that Worker
through Wrangler's dev registry instead. The built Worker (`yarn dev:worker`,
staging, production) exports the class itself and never uses it.

The auxiliary Worker loads the same root `.env`, derives its database binding
from the root Wrangler `dev` environment, and shares the root local persistence
directory. Its broadcasts authorize connected members through Better Auth
against the same local database as the application.

That covers every server-side call to the hub, so opening a conversation with
unread notifications works under `yarn dev`. The dashboard's live inbox socket
does not: Nitro's dev server answers the WebSocket upgrade with a plain 200,
so the browser client keeps reconnecting and the inbox refreshes on
navigation only. Use `yarn dev:worker` to work on the realtime inbox.

If an older checkout has `.dev.vars` or `.dev.vars.<environment>`, merge its
needed values into `.env`, resolve conflicting values explicitly, then remove
the old file. Do not symlink it: Wrangler gives `.dev.vars` precedence and skips
`.env` loading when it exists. Keep local configuration in `.env` rather than
environment-specific copies so Node scripts and the Worker use the same values.
See [Cloudflare's local environment loading rules](https://developers.cloudflare.com/workers/local-development/environment-variables/).

Playwright loads `.env` into its process and enables Wrangler's native process
environment loading for its local Worker. Shell/CI values take precedence, and
the runner supplies local URLs, test-route settings, and log-only delivery.
There is no separate secret forwarding list to maintain. Deployed Worker
secrets remain configured through Cloudflare and the release workflow.

AI Search runs only in production. Local and CI E2E use the native `e2e`
Wrangler environment, which has local D1/KV/DO bindings and no AI Search
binding. Site writes still await cache purges.

Cloudflare [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
expose a local Worker through a temporary `*.trycloudflare.com` development
hostname. Configure the application origins to that exact HTTPS URL and run
Wrangler with `--upstream-protocol https` so it preserves the HTTPS origin
sent to Better Auth. Set `MEDIA_BASE_URL` to `<HTTPS origin>/__media` for local
uploads; keep `NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN` on the configured localhost
fixture domain. These hosts skip production AI Search and public caches;
they do not enable tenant headers, trusted origins, or development routes.

Local `.env` sets `ZARAZ_ANALYTICS=absent` and leaves `CF_ZONE_ID` unset, and
the Playwright runner sets the same. The only Zaraz zone is production's, so a
local reconcile would rewrite production's tags. With Zaraz declared absent,
reconciliation reports `zaraz_absent` without calling Cloudflare. Declaring it
absent while `CF_ZONE_ID` is set fails as a configuration error.

`local:setup` is safe to repeat: it applies the migration chain, refreshes
the demo, Kikuzuki, Pottery House, and NCLS fixtures, copies the shared review credential, and
verifies the resulting D1 database. Do not replace its steps with direct
Wrangler writes or a hand-edited local database.

## Stopping a server

Stop a server by the port it holds, never by process name:

```sh
lsof -nP -iTCP:3000 -sTCP:LISTEN     # see who holds it first
lsof -ti tcp:3000 | xargs kill
```

`pkill -f workerd` and `pkill -f "nuxt dev"` match every matching process on the
machine, not the one in this checkout. Several worktrees run their own server at
once, and `workerd` is the runtime behind all of them.

Killing `workerd` under a running dev server does not stop that server. The Node
process keeps serving, holding Miniflare stubs into a runtime that no longer
exists, so every request answers 500 with `Attempted to use poisoned stub` until
the server is restarted. Nothing about the checkout is wrong when this happens,
and reloading does not clear it — the stub outlives the reload.

If the listener on the port belongs to another worktree, use a different port
rather than killing it.

Fixtures are written before the Worker starts. Setup is not ready for a client
handoff until the post-start social-card generation and public verification pass:

```sh
corepack yarn local:cards
corepack yarn client:verify --url http://localhost:3000 --organization-id org-demo --tenant-slug demo
```

It signs in as the configured review account and regenerates every tenant's cards
through the same endpoint the dashboard's own button uses. It needs `yarn dev`
up, because rendering a card runs in the Worker, and it takes a while on the
first run — a card is rendered and uploaded per product, post and page. Requests
process five owners at a time. Each generated or reused PNG is fetched and its
1200×630 dimensions checked; every skipped or failed owner is reported. Re-running
reuses matching cards. Use `--organization-id` to limit it to one organization;
Krabiclaw's own site is an ordinary organization here.

Approved `client:import --apply` runs this same generator for the imported site
and then `client:verify`; failed generation or verification prevents handoff.
It requires the target Worker to be running and `CANARY_LOGIN_PASSWORD` for the
authorized account (`--email` selects it). Remote targets also require an explicit
`--base-url`.

Only production runs the `social-card-backfill` task: staging sets
`crons = []`, and it is bounded to a small number of owners per night.

An explicitly requested ordinary staging refresh uses `corepack yarn db:pull:staging`.
It reads the deployed production Worker's `DB` source and preserves staging's `jwks` signing
keys. It performs a full content/data refresh, so do not run it for a scoped media
repair or add it to recurring schedules or every deployment. Staging deploys
apply migrations; they do not refresh production data. A same-environment
replacement names its previous database with `--source`, carries that source's
keys, and follows the release contract. Replacement deltas require an explicit
source; production loads always require one.

Local setup copies production through `db:pull:local`.
One SQL read captures the tables and rows from the same database revision.
D1 exports block concurrent application queries, so setup does not use that
operation. Changed schema, incomplete results, oversized copies, or failed
integrity checks on the copy stop setup before it writes the target. Existing
bookings retain their
original dates; setup does not manufacture current activity. For date-sensitive
Today or Calendar checks, create bookings through the guest flow in the local
environment.

## Signing in

Use the dedicated production review account configured by `CANARY_LOGIN_EMAIL`
and `CANARY_LOGIN_PASSWORD` in `.env` for local development, browser verification,
and app submission review. Provision that account through Better Auth's admin
API with an email alias the operator owns. Better Auth owns its password,
verification status, permissions and sessions.

Local setup copies the account from production and verifies the configured
password. It does not create a separate developer identity or reset this
password. Sign in through the normal `/login` page; there is no developer-login
shortcut. Test identities used for explicit authorization scenarios remain local
fixtures for role and access tests. Playwright creates these through Better Auth using the same configured password. Their provisioning through Better Auth does not alter the review account.

For buyer journeys sign in as `buyer@playwright.example` with `CANARY_LOGIN_PASSWORD`:
a verified account with no organization. Playwright provisions it before every
suite; after `local:setup`, create it for manual use with the Worker running:

```sh
corepack yarn local:actors
```

`schema:local` applies new forward migrations when the schema changes. A rare
replacement baseline, such as the v6 WNAM cutover, starts a new migration
history; a local D1 created under the prior baseline then fails the schema
check. Local data is a copy, so delete `.wrangler/state/v3/d1` and run
`corepack yarn local:setup` again in that case. When local review data needs
preserving across a replacement, retain a SQLite backup of the previous local
D1, apply the current migrations to the new local binding with `schema:local`,
and use the same audited transfer:

```sh
node --experimental-strip-types scripts/pull-production-snapshot.ts --local --source-file /absolute/path/to/local-backup.sqlite
```

This reads the saved local database, verifies its recorded migration chain,
and loads only a destination carrying the current schema and migration ledger.

To refresh local auth while retaining review data, stop the local app, export
its database, and pass that export through the full setup:

```sh
corepack yarn wrangler d1 export DB --local --output /absolute/path/to/local-backup.sql
LOCAL_DATABASE_SOURCE_FILE=/absolute/path/to/local-backup.sql corepack yarn local:setup
```

`LOCAL_DATABASE_SOURCE_FILE` applies only to local setup, using the same audited
transfer as `--source-file`. Without it, setup copies production. Test credential
provisioning through Better Auth does not alter the review account.


## Dashboard URLs

Follow links rendered by the dashboard whenever possible. A dashboard route
carries one tenant segment, the organization's slug.

| Tenant | Organization segment (`orgSlug`) |
| --- | --- |
| Ember & Slice | `ember-slice-demo` |
| Pottery House | `org-user-pottery-house` |
| Kikuzuki | `org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX` |
| NCLS | `north-carolina-legal-services` |

For example, Kikuzuki starts at:

```text
http://localhost:3000/dashboard/org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX
```

The subdomain is the tenant's public address, not a dashboard segment: Kikuzuki
serves its website at `kikuzuki-krabi-thailand.localhost:3000`.

## Before pushing

Pull-request E2E uses the isolated Stripe Sandbox credentials in
`STRIPE_SECRET_KEY_E2E` and `NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_E2E`. The workflow
binds these to the ordinary application variables. Staging's configured account
and its existing customers remain separate. Native Payments qualification uses
the same isolated Sandbox, the reviewed catalog, dedicated local webhook
listeners and the normal Better Auth subscription flow.

```sh
corepack yarn quality && corepack yarn test:unit && corepack yarn test:d1 && corepack yarn test:migrations && corepack yarn test:mcp
corepack yarn chatgpt:submission:check && corepack yarn lint:migrations && corepack yarn lint:schema-drift
```

These cover the static, D1, and migration checks before pushing. Pull-request
CI also runs the full E2E suite against a local Worker and D1 copy. `test:unit`
alone is not enough: D1 and migration checks cover persistence behavior that
typecheck and unit tests cannot see.

Changing the MCP tool surface makes two generated artifacts stale. Regenerate
and commit both:

```sh
corepack yarn mcp:catalog:write
corepack yarn chatgpt:submission:write
```

Dependency patches (`patches/*.patch`) are applied by Yarn's `patch:` protocol
from `package.json`, so every `yarn install` applies them and fails if one no
longer applies. To change one, run `corepack yarn patch <package>`, edit the
printed folder, then `corepack yarn patch-commit -s <folder>` and move the
generated file from the ignored `.yarn/patches/` into `patches/`, updating its
`package.json` reference.

## Isolated MCP verification

Set `PLAYWRIGHT_PORT` to an unused local port when another checkout is running,
for example `PLAYWRIGHT_PORT=3107 corepack yarn playwright test tests/e2e/mcp-owner-tools.spec.ts --workers=1`.
The standard local Worker preparation and worktree-local D1 storage remain in use.

The diagnostic `test:mcp:edit` script requires `--organization-id`. The `test:mcp:image`
and `test:mcp:ops` scripts require both `--organization-id` and `--location-id` for
explicit disposable fixtures provisioned through the approved setup/CMS path;
they no longer create organizations or locations through MCP. `test:mcp:app`
checks the MCP Apps contract. All four read `--base-url` (default
`http://localhost:3000`), sign in with local credentials, and take
`MCP_BEARER_TOKEN` or `MCP_CREDENTIAL_LOGIN=1` for a remote target.

## Diagnostics

- `corepack yarn audit:media-placements [local|staging|production]` reports media
  placements whose owner is missing or belongs to another organization.
- `corepack yarn perf:lighthouse --url <url> [--runs 3]` reports the median of
  several Lighthouse runs against a live URL.
