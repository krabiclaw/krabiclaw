# KrabiClaw — agent instructions

## Completion standard

Complete the requested outcome end to end.

Do not stop at code that compiles, a partial implementation, a passing unit test,
or a workaround. The affected runtime behavior must work through its real boundary.

A defect discovered while doing the work is part of the work when it:

- exists in code or data being changed;
- affects the execution path being changed;
- violates an invariant the change depends on;
- prevents correct verification of the requested outcome; or
- reveals that the proposed implementation is built on an incorrect assumption.

Fix those defects before declaring the task complete.

"Pre-existing", "unrelated to my diff", "follow-up", "flagged for later", and
"outside scope" are not valid reasons to leave broken behavior in a path the task
depends on.

Do not leave TODOs, disabled behavior, compatibility branches, temporary
workarounds, duplicated implementations, or half-completed migrations as a
substitute for finishing the work.

Do not broaden the task into unrelated cleanup that the requested outcome does
not encounter or depend on.

## Operator authority

The repository owner operates this repository and its configured infrastructure.

An explicit owner instruction authorizes the named operation and target. Do not
require repeated confirmation solely because the target is production, staging,
remote infrastructure, billing, customer data, or a deployment.

Repository rules constrain actions the agent invents or infers. They do not
silently override an explicit owner instruction for a clearly identified
operation.

If a destructive target is genuinely ambiguous, resolve it from repository or
runtime state where possible. Ask only when the target cannot be determined.

## Canonical implementation

Every concept has one canonical implementation and every value has one canonical
source.

Fix the canonical source rather than adding a second path around it.

Do not add shadow models, duplicate APIs, parallel services, compatibility
layers, alternate data sources, or silent fallback behavior when the canonical
path can be corrected.

Do not infer a target the caller did not provide merely because one candidate
looks likely.

Missing or invalid required state must fail visibly or be fixed at its source.
Do not manufacture plausible state to conceal the failure.


Existing repository code is evidence, not authority.

Agents often find a local implementation first and extend it because it appears
established, tested, or production-proven. Do not assume that makes it
canonical or correct. Before building on local code for behavior that an
installed dependency, framework, SDK, or external provider may already own,
inspect the current documented API and, when behavior is version-sensitive, the
installed version's implementation.

Search dependency/provider capabilities before extending a repository wrapper.
A dependency is an existing implementation even when the repository has no
helper around it yet.

If repository code duplicates behavior already owned by the configured
dependency/provider, prefer deleting or reducing the repository implementation
to the provider boundary. Passing tests, recent implementation, production use,
or reviewer familiarity are not reasons to preserve duplicated lifecycle logic.

## Complexity

Default order:

1. delete;
2. reuse;
3. modify;
4. add.

Before adding an abstraction, find the existing implementation of the behavior.

Evidence comes from running what already exists and from loading the real
surface. A scratch spec, a temporary helper, a one-off script, or a fixture
written to observe behaviour is not evidence and is not part of the work.

Prefer the version of the change with
fewer files, fewer names and fewer lines than the one it replaces.

A refactor removes the implementation it replaces in the same change. Do not
leave old and new paths operating in parallel.

Prefer fewer concepts, fewer names, fewer state representations, and fewer
execution paths.

## Database and releases

Every Cloudflare D1 database must use Western North America (`wnam`).
Create databases, including epoch replacements, with `wrangler d1 create
<name> --location wnam`. Never omit the location hint or create an APAC
(`apac`) database. Verify Cloudflare reports WNAM before binding or loading it.

Use the repository's canonical database, migration, deployment, rollback, and
incident-recovery mechanisms.

Do not invent a parallel mechanism when an existing repository mechanism can
perform the operation.

Schema changes originate from the canonical schema and use the repository's
migration tooling.

A scoped data repair is valid when explicitly requested or when it is the
existing mechanism required to restore the requested behavior. Verify the
persisted result and the affected runtime behavior afterward.

Do not mutate data merely to hide a reproducible application defect. Fix the
application source when the source is wrong.

Authoritative operational contracts:

- `docs/operations/release-and-outage-prevention.md`

## Failure reporting

A caught error is reported or it is not caught.

A `catch` that writes to a console and continues is a failure nobody learns
about. It is refused mechanically by `eslint.config.mjs` and it is refused here.
Every `catch` must throw, return an error status or failed result, or put the
reason into state the caller actually reads.

There is no "best effort", "non-fatal" or "transient provider" exemption. The
infrastructure is not what fails; the code is. Do not add a tolerance, a retry
that gives up quietly, or a comment attributing a failure to a provider without
evidence that the provider was at fault.

A name ending in `Safe`, or a wrapper whose body is a try/catch around one call,
is a swallow with a reassuring label. Delete it and let the call fail.

Do not default, placeholder or fabricate state that could not be read. Missing
or invalid required state fails visibly — a manufactured value is worse than an
error because it is indistinguishable from a real one.

A write that succeeded while the work that makes it visible failed has not
succeeded. Cache purges, index refreshes, reconciliations, notifications and
audit rows are part of the operation that asked for them.

## Evidence

A claim about data comes from querying the data.

A claim about a surface comes from loading the surface.

A claim about behavior comes from exercising the behavior.

Compilation, linting, typechecking, builds, and unit tests are supporting
evidence, not substitutes for verifying the real runtime boundary.

Exercise the behavior with what the repository already has. Writing something
new to observe it is an addition and is gated — see Complexity.

A test must not create the state it then asserts. A helper named `ensure*`,
`getOrCreate*` or `*OrDefault` in a test is a prompt to check whether it is
manufacturing its own premise — one of them re-provisioned a live tenant on
every run so that the assertion after it would hold.

Assert the outcome, not the status code. Read a write back through a different
path than the one that made it. Assert the exact status rather than "not an
error". Never loosen an assertion to make it pass: decide whether the spec or
the application is wrong, say which, and fix that.

Follow `docs/testing-strategy.md`.

Do not declare success while the affected path still contains a known failure,
even when that failure predates the current change.

## Authentication and authorization

Better Auth owns identity, sessions, OAuth state, organizations, memberships,
roles, permissions, impersonation, and Teams.

Use the documented Better Auth mechanisms and the repository's shared permission
utilities.

Do not create shadow authentication state, custom membership systems, tenant
bypasses, undocumented support principals, or parallel authorization logic.

Dashboard, MCP, WhatsApp, and other application surfaces must share the same
canonical authorization and domain behavior.


### External accounts and provider credentials

When a configured auth/provider library can own an external identity or
credential lifecycle, it owns that lifecycle.

For OAuth integrations, use Better Auth linked accounts, social providers, or
Generic OAuth before implementing provider OAuth directly. Wherever Better
Auth's documented provider mechanism supports the required flow, Better Auth
owns:

- authorization redirects, callback and state handling;
- provider account identity;
- access and refresh token storage;
- token encryption and expiry;
- granted scope tracking and incremental scopes;
- access-token refresh; and
- account link/unlink lifecycle.

Application code may store only domain state Better Auth cannot represent, such
as which Google Analytics property, Search Console site, Facebook Page, or
Instagram professional account an organization selected.

Before writing OAuth URL construction, authorization-code exchange,
access/refresh-token persistence, token encryption/decryption, scope merging,
token refresh, or provider-account identity state, verify from the installed
Better Auth version's documented API/source that Better Auth does not already
provide the operation. A provider-specific API requirement is not permission to
duplicate the surrounding OAuth lifecycle.

The same rule applies to other configured provider integrations. For example,
Better Auth Stripe owns subscription lifecycle and subscription state where the
plugin provides the operation. Do not read provider-owned state and recreate
its state machine in application code merely because the data is accessible.

Do not preserve custom credential or lifecycle infrastructure merely because it
already exists. If a canonical provider/library mechanism supersedes it, delete
the custom implementation in the same change.

## Tenant integrity

Tenant boundaries are strict.

Render and mutate the tenant explicitly targeted by the operation.

Do not fabricate tenant content, silently substitute another tenant's data, or
use unrelated placeholder content when required tenant state is missing.

Preserve existing customer data unless the requested operation explicitly
changes it.

After a tenant write, verify the affected persisted state and customer-facing
behavior.

## Pricing copy

Use Stripe and Metronome's exact pricing terms, phrasing and breakdown wherever
they apply. This governs public pages, SEO metadata, LLM-readable content,
customer-facing billing and documentation. Do not replace their wording with
technical jargon or invent a different pricing tone. Add plain wording only for
KrabiClaw's own subscription and fee.

Read the current primary [Stripe pricing](https://stripe.com/pricing) and
[Metronome pricing](https://metronome.com/pricing) before changing pricing copy.
Preserve the actual amounts, charge basis, currency, billing interval and
conditions. Public pages and their Markdown, SEO and LLM projections use the
same canonical published pricing content.

## Dashboard CMS

CMS work starts from `DESIGN.md`: its workspace map, its ownership table and
its rule for admitting a new concern. Read the generated route tree and the
existing editor and domain operation before adding a file, and remove what the
change replaces in the same change.

## Customer documentation

When creating or editing customer help articles, read
`.agents/skills/write-help-docs/SKILL.md`. Relevant workflow sections require
screenshots captured from the running application and published with the article.

## Local development

Follow `docs/local-development.md`.

Use the repository's documented setup, fixtures, authentication, and local
runtime paths rather than recreating their individual steps manually.

## Marketing execution

For feature launches, blogs and social distribution, read
`.agents/skills/krabiclaw-publishing/SKILL.md` before publishing. It covers
content selection and automatic Product News broadcast consequences.

For KrabiClaw marketing videos, use `.agents/skills/krabiclaw-marketing/SKILL.md`.
Product facts and voice remain in `docs/marketing/product-profile.md`.

The relevant official HyperFrames skills are tracked in `.agents/skills/hyperframes*/`, `.agents/skills/product-launch-video/` and `.agents/skills/media-use/`; load their `SKILL.md` through the marketing wrapper as needed. Upstream provenance and licenses accompany each.
