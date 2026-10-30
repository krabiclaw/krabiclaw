# Local development

**Status: Contract**

There is one local setup path for humans and agents:

```sh
corepack yarn install
corepack yarn local:setup
corepack yarn dev
corepack yarn playwright install chromium   # once: the seed visits the sites as a guest
corepack yarn local:seed   # with `yarn dev` serving port 3000
```

Copy `.env.example` to `.env` and fill the required application secrets before
setup. `.env` is the single local configuration for Nuxt, Wrangler, setup scripts,
and E2E tests; `.env.example` is the maintained template. Both `yarn dev` and
`yarn dev:worker` use port 3000 by default.

The built local Worker must receive each tenant's `<subdomain>.localhost`
hostname, including onboarding and editor preview iframes. Leave Wrangler's
`dev.host` and `--host` unset: these override the forwarded hostname rather
than choosing the local listening address. The `e2e` environment sets
`routes = []` so Wrangler does not infer a production upstream hostname from
inherited deployment routes. Use `--port` to choose another local port.

`yarn dev` also starts a second local Worker, `krabiclaw-guest-inbox-hub`, from
`server/cloudflare/dev/wrangler.toml`. Wrangler's platform proxy cannot host a
Durable Object whose class lives in the proxied Worker, so under `nuxt dev` the
`GUEST_INBOX_HUBS` binding (`[env.dev]` in `wrangler.toml`) reaches that Worker
through Wrangler's dev registry instead. The built Worker (`yarn dev:worker`,
staging, production) exports the class itself and never uses it.

`build/guest-inbox-hub-dev.ts` starts that Worker once for the life of the
`nuxt dev` process and stops it when Nuxt closes; a Nitro rebuild does not
restart it. Wrangler's registry will not hand a name to a new instance while
another instance touched it in the last 90 seconds, so a hub restarted per
rebuild left every call going to the dead one for that long. After a server
that was killed rather than stopped, the same 90 seconds apply once.

Nitro's dev server runs the app in a worker thread and replaces that thread on
every rebuild. `patches/env-runner-npm-*.patch` makes it shut the old thread
down through its own close hooks rather than terminating it, so the Wrangler
platform proxy that `server/plugins/00.cloudflare-dev-bindings.ts` starts in
each thread is disposed with it. Without that, each rebuild left another
Miniflare holding the local D1 file until queries failed with `SQLITE_BUSY`.

The auxiliary Worker loads the same root `.env`, derives its database binding
from the root Wrangler `dev` environment, and shares the root local persistence
directory. Its broadcasts authorize connected members through Better Auth
against the same local database as the application.

That covers every server-side call to the hub, so opening a conversation with
unread notifications works under `yarn dev`. The dashboard's live inbox socket
does not: Nitro's dev server answers the WebSocket upgrade with a plain 200.
Under `nuxt dev` the dashboard therefore does not open the socket at all, shows
no live-connection banner, and refreshes on navigation only. Use
`yarn dev:worker` to work on the realtime inbox.

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

`local:setup` deletes the local Wrangler state and applies the migration chain
to an empty D1. `local:seed` then builds the same synthetic businesses Playwright
builds before every E2E run (`tests/e2e/seed`): a platform administrator, the
KrabiClaw platform organization, and Ember & Slice (restaurant), Clayhouse
Studio (experience) and Harbor Legal Aid (legal services). Every row is written
through the app's own boundaries — Better Auth, provisioning, MCP tools and the
editor's uploads — so local data is what the application itself produces. The
seed runs against an empty database; after a failed or finished seed, run
`local:setup` again before seeding.
No production data reaches a developer machine or a pull request.

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

`corepack yarn local:cards` regenerates every tenant's social cards through the
same endpoint the dashboard's own button uses. Locally, pass the seeded
administrator: `--email platform-admin@playwright.example --password '<E2E_PASSWORD>'`
(see `config/development-auth-fixtures.ts`). It needs the Worker up, because
rendering a card runs in the Worker. Each generated or reused PNG is fetched and
its 1200×630 dimensions checked; every skipped or failed owner is reported.

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
source; production loads always require one. Follow a staging refresh with
`corepack yarn billing:test-mode`: the copy carries production's live-mode
Stripe subscriptions, which staging's test-mode key cannot read, and that step points
each one at a test-mode equivalent at the price Better Auth knows its plan by: an
offered plan's current price, a retired plan's own contract price.

`db:pull:staging` reads the live database a page of rows at a time over the D1
API into a SQLite copy, never through D1's native export: creating an export
blocks every other request to its source database, and production served those
requests as 500s. Pages are not one consistent revision; a row written during
the copy can fall either side of it, and the transfer refuses a copy whose
foreign keys disagree. An explicit `--source` uses the same paged read because
an epoch source can still be serving customers. The transfer validates the schema, rows and integrity of the
copy before writing the target, and ordinary refreshes retain the destination's
signing keys.

## Signing in

Sign in through the normal `/login` page as a seeded fixture from
`config/development-auth-fixtures.ts`, with the shared `E2E_PASSWORD` there.
`platform-admin@playwright.example` is a Better Auth admin and owns every seeded
business; the other fixtures hold the memberships their names describe. There
is no developer-login shortcut.

### Native app development accounts on staging

Debug builds of the native app sign in to KrabiClaw **staging** with email and
password (`docs/shared-auth-contract.md` D9). A platform admin creates these
accounts once on staging
through Better Auth's admin API, verified so they can sign in immediately. Use
addresses at an alias the operator owns, and a password kept with the team's
credentials, never in the repository:

```sh
STAGING=https://staging.krabiclaw.com
curl -sS -c /tmp/staging-admin.jar -H "origin: $STAGING" -H 'content-type: application/json' \
  -d '{"email":"<platform admin email>","password":"<platform admin password>"}' \
  "$STAGING/api/auth/sign-in/email"
curl -sS -b /tmp/staging-admin.jar -H "origin: $STAGING" -H 'content-type: application/json' \
  -d '{"email":"<native-owner alias>","name":"Native Owner","password":"<shared dev password>","role":"user","data":{"emailVerified":true}}' \
  "$STAGING/api/auth/admin/create-user"
rm /tmp/staging-admin.jar
```

Repeat the second call for each role the app needs to exercise (an owner who
creates a lodging organization, and a co-host and cleaner who join it through an
invite link). Each answers `{"user":{…}}`; then sign in once from the app to
confirm.

`schema:local` applies new forward migrations when the schema changes. After a
replacement baseline, such as an epoch cutover, a local D1 created under the
prior baseline fails the schema check; run `local:setup` and `local:seed` again.

## Dashboard URLs

Follow links rendered by the dashboard whenever possible. A dashboard route
carries one tenant segment, the organization's slug.

| Business | Organization segment (`orgSlug`) | Website |
| --- | --- | --- |
| Ember & Slice | `ember-slice-demo` | `demo.localhost:3000` |
| Clayhouse Studio | `clayhouse-studio` | `clayhouse.localhost:3000` |
| Harbor Legal Aid | `harbor-legal-aid` | `harbor-legal.localhost:3000` |

For example, Ember & Slice starts at `http://localhost:3000/dashboard/ember-slice-demo`.

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
CI also runs the full E2E suite against a local Worker and a freshly seeded D1. `test:unit`
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
