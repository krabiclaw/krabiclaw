# Testing strategy

Do not add a test by default. Add one only when it proves a named invariant more
directly than the existing build, browser, MCP, or database verification.

Browser and deployed MCP behavior are the release signal. Static checks and the
small unit suite are supporting diagnostics; they are not proof that a customer
can use the product. For release-qualified surfaces, follow
[release-and-outage-prevention.md](operations/release-and-outage-prevention.md).

## Choose the proof at the real boundary

Use the narrowest real boundary that proves the behavior:

1. Use typecheck, lint, or a canonical schema guard for structural rules.
2. Use a direct unit test for an isolated calculation, parser, normalization,
   serialization, validation rule, or security decision.
3. Use real local D1 and the Worker for persistence, transactions, and
   atomicity.
4. Use a browser against the local production Worker build for CMS and UI
   behavior.
5. Use the local E2E suite over a local D1 for release-critical customer
   journeys, and read-only checks against staging for anything only a
   deployment can answer.
6. Use an actual ChatGPT session only for ChatGPT-specific tool discovery,
   selection, attachments, and host-provided arguments.

Local browser verification uses the repository's exact Node version, fresh
local migrations and fixtures, a production Nuxt/Nitro build, and
`.output/server/index.mjs` through local Wrangler. Do not substitute
`nuxt dev`, component mocks, or a mock server and call it runtime proof.

## What an assertion has to be

A status code is not an outcome. Every one of these passed a green suite:

- `updateTenantPage` answered 200 while `canonical_url = ? = ?` aborted the batch
  on a binding count, so every tenant page edit was a silent no-op.
- `update_location` answered 200 and no test read the row back.
- `/policies/terms` rendered a hero, a divider and no body, and matched
  `/terms/i` — the word is in the footer of every page on the site.
- The shield divider rendered the wrong fill and leaked `block="[object Object]"`
  into the DOM for seven weeks.
- A booking answered 201 with the owner's email and WhatsApp both undelivered.

So:

1. **Assert the outcome a customer or tenant would notice.** A dish has a price
   and a photo. A class has a bookable time. A legal page has a body, not just a
   heading. A page renders a section that is not its hero and not the shared CTA.
2. **Read a write back through a different path than the one that made it.** A
   200 from the route that wrote is the route agreeing with itself.
3. **Assert the exact status.** `toBeLessThan(400)` passes on a redirect and on a
   304. Write `toBe(200)`.
4. **Make empty a failure unless the emptiness is the tenant's own data.** Pass
   the expected count in. "No availability in the next 31 days" is a valid 200
   and was wrong for a product with twelve scheduled sessions.
5. **Never assert only that a shape exists.** `toEqual(expect.any(Array))` passes
   on `[]`, which is what a tool that returned nothing produces.
6. **A test must not create the state it then asserts.** `ensureOrganization`
   re-provisioned the fixture tenant on every run, moving a live tenant's
   subdomain, and the assertion that followed only held because of it. Anything
   named `ensure*`, `getOrCreate*` or `*OrDefault` in a test is a prompt to check
   whether it is manufacturing its own premise.
7. **When a spec fails after a contract change, decide whether the spec or the
   app is wrong, and say which, before touching either.** Never loosen an
   assertion to get green. If the assertion's premise has genuinely become false,
   replace the premise and write down why — do not widen the tolerance.

## Failures are reported, never logged

A caught error that is written to a console and nothing else is invisible. There
is no "best effort" and no "transient" exemption: Cloudflare is not what fails
here, our code is, and a log is not a report.

`eslint.config.mjs` enforces the floor mechanically — a catch whose entire body
is a console call and which neither throws nor returns is an error. The rule is
narrow on purpose, so passing it is not evidence. A catch must do one of:

- throw, or
- return an error status, a failed result, or a recorded delivery outcome, or
- put the reason in state the caller reads — a returned field, a ref the UI
  renders, the structured line that already reports that operation.

Two corollaries, both learned the hard way:

- **A name ending in `Safe` is usually a swallow with a reassuring label.**
  `fireOrganizationEventSafe` dropped audit rows. `recordSubmissionConversionSafe`
  dropped a conversion written right after a booking. Both were deleted rather
  than fixed.
- **Missing required state fails; it is never defaulted.** A phone that would not
  parse became `phone-unknown@phone.krabiclaw.local`, which is an account key, so
  every such sign-up would have shared one account.

## Unit-test admission rule

A new unit test must name the invariant it proves and must fail only when that
invariant is broken. It must exercise exported behavior directly, without
reconstructing the surrounding application.

Do not add or retain unit tests that:

- read Vue, TypeScript, or JavaScript source and match strings, imports, SQL,
  component markup, or wiring;
- mock internal database, auth, MCP executor, domain, composable, or API
  modules;
- copy their expected result from the implementation or restate a constant,
  schema declaration, framework configuration, or type;
- add a regression test merely because a bug occurred;
- assert query counts or implementation shape instead of observable behavior;
- duplicate a deployed E2E journey with lower confidence;
- simulate an end-to-end workflow with hand-built fakes.

Do not automatically replace a deleted mock test. When a real risk is not
covered at the correct boundary, verify that boundary as part of the affected
feature work.

A test is admitted because it uniquely proves a current invariant, not because
a numeric budget permits it. There is no cap on test files, test count, or test
lines, and there never should be one: a cap makes deletion the cheapest way to
add coverage and turns the suite into a number to manage.

## Deletion history is not an invariant

> Deletion history is not a permanent product invariant. Once old behavior is
> removed and no external compatibility contract requires it, do not retain
> tests, linters, guards, snapshots, comments, or documentation whose only
> purpose is proving the old behavior remains absent.

Ask of any test or check: would a developer designing this product fresh today
write it to protect something that exists? If the answer is no, delete it.

Negative testing remains appropriate for active invariants — authentication,
authorization, validation, capacity, concurrency, isolation, and tamper
resistance. The distinction is whether an assertion protects a current
contract, not whether it expects success or failure.

## Release feedback loop

A pull request targeting `staging` runs `Checks` and the full E2E suite
against a local Worker and D1 copy. AI Search is production-only, so E2E has
no remote search prerequisite. There is no pull-request
preview deployment; `staging` is the first deployed validation.

The E2E suite runs locally, against a local D1 and a Worker the suite starts.
The local Worker uses the `e2e` Wrangler environment and its local D1 copy:

```bash
yarn local:setup       # once: migrate and copy the configured development data
yarn e2e:local:prepare  # verify the existing copy, remove test artifacts, build
yarn test:e2e:local
```

Ordinary browser and MCP journeys sign in with `CANARY_LOGIN_EMAIL` and
`CANARY_LOGIN_PASSWORD` from `.env` (CI uses the corresponding secrets).
Role, tenant-isolation and onboarding journeys need distinct actors; Playwright's
global setup provisions them through Better Auth's admin and organization APIs,
using the same configured password. It does not rebuild tenant fixtures or write
authentication rows directly. Preparation does not recopy production on each run.
It clears transient local rate counters so repeated runs exercise the real
limits with a fresh quota.

Local Playwright waits for the Worker's health endpoint before running specs.
The tests exercise cache invalidation without provisioning or indexing a remote
AI Search instance.

`staging` is the first deployed validation. A push to `staging` deploys it and
then runs read-only MCP discovery and tenant rendering against staging itself.
Production deploys what `main` holds once `main`'s own `Checks` pass; whoever
promotes decides the candidate is ready.

Staging and production remain read-only. Guest and MCP write suites run only
against local data.

Focused commands:

```bash
yarn test:unit
yarn test:e2e:local
yarn test:e2e:tenant-rendering
yarn test:e2e:guest-journeys
yarn test:e2e:mcp
```

Cloudflare Images credentials exist only in production, on purpose. Local, E2E,
staging and preview run on copies of production's rows, so a token there stores
into and deletes from production's images. Anything that stores an image outside
production (an upload, a social card) answers 503 "Cloudflare Images is not
configured in this environment, by design". That is the expected result, not a
missing setup step: a spec asserts against images the data already holds, and
never adds the token to pass.

The CIMD OAuth cases need `MCP_CIMD_CLIENT_URL` and
`MCP_PRIVATE_CIMD_CLIENT_URL` to name reachable public HTTPS metadata
documents, which localhost cannot be. Point them at the deployed staging
Worker's own test-client documents when running those cases.

Schema changes also run `yarn lint:migrations`, `yarn lint:schema-drift` and
`yarn test:migrations`: the chain must not drop a referenced parent table,
`db:generate` must emit nothing, and the chain must apply from zero.
