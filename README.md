# Blawby

[Blawby](https://blawby.com) runs the website, bookings, payments and messaging
for restaurants, experience operators, law firms and lodging hosts, managed from
the dashboard or from ChatGPT and Claude through one MCP service. Lodging includes
homes, nightly availability and prices, direct stay bookings and guest messaging.

Open source under [AGPL-3.0](LICENSE).

- **Report a bug or request a feature:** [open an issue](https://github.com/Blawby/blawby/issues/new/choose).
  Assistants filing for a user can prefill the form; see the field ids in
  [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE).
- **Account, billing or private data:** [blawby.com/help](https://blawby.com/help).
- **Security:** [SECURITY.md](SECURITY.md).
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md).

Nuxt 5 nightly + Nitro 3 + Cloudflare Workers + D1.

**Package manager: yarn only.** Never npm or pnpm.

---

## Scripts

| Command | What it does |
|---|---|
| `yarn dev` | Nuxt development server with HMR and locally emulated Cloudflare bindings at `http://localhost:3000`. |
| `yarn local:setup` | Reset local Wrangler state and migrate an empty local D1. |
| `yarn local:seed` | Build the synthetic E2E businesses in the running local Worker. |
| `yarn dev:worker` | Build and run the production-like Worker locally with Wrangler at `http://localhost:3000`. |
| `yarn dev:worker:start` | Run the existing `.output` Worker build locally without rebuilding it. |
| `yarn build` | Production build → `.output/` |
| `yarn db:generate` | Generate a new `migrations/*.sql` file from `server/db/schema.ts` |
| `yarn drizzle:check` | Verify `server/db/schema.ts` hasn't drifted from the live D1 schema |
| `yarn stripe:listen` | Forward Stripe webhooks to localhost (local dev only) |
| `yarn canary:prod` | Production-safe authenticated browser canary (read-only checks). |
| `yarn canary:notifications` | Production provider-level email/WhatsApp notification canary. |

---

## Local setup

```bash
corepack yarn install
cp .env.example .env        # then fill in the application secrets
corepack yarn local:setup   # empty local D1 at the current migration
corepack yarn dev           # http://localhost:3000; leave it running
```

In a second terminal:

```bash
corepack yarn playwright install chromium   # once
corepack yarn local:seed
```

Use the exact Node version in `.nvmrc`. `.env` is the single local
configuration for Nuxt, Wrangler, setup scripts and E2E tests; if an older
checkout has `.dev.vars`, move its values into `.env` and delete it, because
Wrangler skips `.env` when `.dev.vars` exists.

`local:seed` builds the same synthetic businesses Playwright uses
(`tests/e2e/seed`) through the app's own boundaries: Better Auth, provisioning,
MCP tools and editor uploads. Run `local:setup` again before reseeding, and
after a new migration baseline. No production data reaches a developer machine.

Sign in at `/login` as `platform-admin@playwright.example` with `E2E_PASSWORD`
from `config/development-auth-fixtures.ts`. That admin owns every seeded
business:

| Business | Dashboard | Website |
| --- | --- | --- |
| Ember & Slice | `/dashboard/ember-slice-demo` | `demo.localhost:3000` |
| Clayhouse Studio | `/dashboard/clayhouse-studio` | `clayhouse.localhost:3000` |
| Harbor Legal Aid | `/dashboard/harbor-legal-aid` | `harbor-legal.localhost:3000` |

`yarn dev` is the editing loop. Work on the realtime inbox under
`yarn dev:worker`: Nitro's dev server cannot upgrade the inbox WebSocket.
`yarn dev:worker:start` restarts the last build without rebuilding.

Stop a server by its port, never by process name; several worktrees can run
their own server at once:

```bash
lsof -ti tcp:3000 | xargs kill
```

On macOS, raise the file limit if the dev server runs out of handles:
`ulimit -n 65536`.

Yarn accepts new package releases only after seven days. For an urgent reviewed
security fix, `corepack yarn up <package>@<fixed-version> --no-time-gate` and
record the advisory in the pull request. Dependency patches live in `patches/`
and are applied by Yarn's `patch:` protocol on every install.

---

## Tests

Before pushing:

```bash
corepack yarn quality && corepack yarn test:unit && corepack yarn test:d1 && corepack yarn test:migrations && corepack yarn test:mcp
```

When the MCP tool surface changes, regenerate and commit the catalog:

```bash
corepack yarn mcp:catalog:write
```

`corepack yarn chatgpt:submission` writes the OpenAI app submission file when
you submit to OpenAI; it is not committed.

The E2E suite starts its own Worker on `PLAYWRIGHT_PORT` (default 3000) with its
own local D1, seeds it, and signs in as the fixtures:

```bash
PLAYWRIGHT_PORT=3107 corepack yarn test:e2e tests/e2e/<file>.spec.ts --project=chromium
```

Cloudflare Images credentials exist only in production. Outside it, uploads and
social cards that need Cloudflare Images answer 503 by design.

---

## Deployment

Deployment follows the branches in `.github/workflows/ci.yml`:

1. Pull requests run `Checks` and the `E2E` suite against a local Worker and a
   local D1 seeded with synthetic businesses. Nothing is deployed for a pull
   request, and no production data is read.
2. Pushes to `staging` run `Checks`, then deploy the staging Worker, apply
   staging migrations, and run read-only MCP and tenant rendering against
   staging itself.
3. Pushes to `main` run `Checks`, then deploy the production Worker, apply
   production migrations, and run read-only production browser verification.

During an incident, use Cloudflare's deployment history to restore the last
known-good production deployment without changing D1 data. Then land the source
fix through `staging` and `main`.

Production secrets live in Cloudflare → Workers & Pages → krabiclaw → Settings →
Variables. `CRON_SECRET` protects internal scheduled endpoints:

```bash
openssl rand -base64 32
yarn wrangler secret put CRON_SECRET
```

Real-send production canaries (auth OTP, notification email and WhatsApp) run
only on demand, from the `Production Real-Send Canaries` workflow.

Schema and database releases follow
[release-and-outage-prevention.md](docs/operations/release-and-outage-prevention.md).

---

## Schema

`server/db/schema.ts` is the only schema source of truth; `migrations/` holds
generated output. Hand-written migrations are prohibited.

---

## Stripe (local)

```bash
yarn stripe:listen
```

Copy the `whsec_...` signing secret it prints into `.env` as
`STRIPE_WEBHOOK_SECRET`. Connected accounts use a separate Accounts v2
thin-event destination and signing secret; see
[Stripe Connect](https://docs.stripe.com/connect).
