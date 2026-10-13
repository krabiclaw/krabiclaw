# MCP

Krabiclaw ships one MCP surface. Every site, Krabiclaw's own included, is managed
through it with the same tools.

## Surface

- Endpoint: `/api/mcp`
- Protected resource: `/.well-known/oauth-protected-resource`
- Server entrypoint: `server/api/mcp.ts`
- Scope: `tenant`
- Exposes: existing-tenant content management, menus, experiences, posts, articles
  (blog and, on Krabiclaw's own site, documentation), media, reviews,
  customer inquiries, Q&A, analytics, bookings, guest change proposals, member
  availability and financial reads
- Site creation and location creation, copying, and deletion are CMS-only. MCP
  retains daily content operations, including media asset and experience deletion.
- Google Places lookup and domain setup are CMS-only. Connecting a Facebook Page,
  Instagram account or Discord channel is a Better Auth sign-in in the dashboard;
  `get_social_connections` returns the `connect_url`. Manual locale management remains available as ordinary content editing.
- Posts: `create_post` makes a draft (pass a new `idempotency_key`); `publish_post` publishes to
  exactly the `targets` named — `{"channel":"organization"}` and the `target_id` and
  `connection_revision` from `get_social_connections` — and returns one outcome per target.
  `processing` is finished by calling `publish_post` again; `unknown` is resolved only by
  `reconcile_post_publication`, never by publishing again. Nothing is scheduled: a client that
  wants a post out later calls `publish_post` then.

Krabiclaw's marketing site is an ordinary organization running the platform
template. Its blog and documentation are article collections on that
organization and are edited with the same tools as any tenant's articles, using
its `organization_id`.

## Member availability and Google Calendar

`get_member_scheduling` lists accessible members or reads an explicitly named
member. `set_member_scheduling` saves timezone, hours, time off and public profile
using the latest `expected_updated_at`. Members can manage only their own record;
owners and admins can manage their team and approve public profiles. Profile edits
revoke approval unless an admin explicitly approves them.

Google consent and account linking happen through Better Auth in the dashboard.
`set_member_busy_calendars` selects explicit calendar IDs on the member's own
already-linked account; it never grants OAuth permission. Empty IDs pause busy
checking, and a null account with empty IDs disconnects it. Busy results contain
intervals, not personal event titles or descriptions. Failed or stale selected
calendar reads block new availability rather than treating unknown time as free.

The CMS selects the primary personal calendar and offers **Avoid double bookings**.
The business connection creates or reuses its **Krabiclaw** calendar automatically.
Neither flow requires a calendar picker. Google event edits do not change bookings.
See [Google Calendar](integrations/google-calendar.md) for projection and cleanup.

## Auth Model

- AGENTS.md's "Platform and authorization boundaries" is the canonical statement
  of Better Auth authorization scope.
- MCP requires Better Auth Organization permissions and, for scoped editors, the
  matching Better Auth Team membership.
- Org member roles (`owner`, `admin`, `editor`, optional read-only `member`) are
  tenant-scoped only.
- A Better Auth admin (impersonation rights) does not receive MCP access to a
  site from that role alone. Access requires real organization/team membership or
  a Better Auth impersonation session for a member of that organization.
- The real runtime boundary is the token `aud` claim bound to the MCP resource
  URL, plus the server-side membership checks. Never rely on scope presence or
  tool filtering alone.

## User-Facing URL

- MCP app URL: `https://krabiclaw.com/api/mcp`

## Tool catalog

Krabiclaw exposes one canonical tool contract. Every tool name, input schema,
output schema, and executor must agree. Unknown tool names return JSON-RPC
`-32601` over HTTP 200.

### Operation names

- `list_*` discovers a collection; `get_*` reads a selected record or aggregate.
- `preview_*` computes a proposal without saving; `update_*` saves supplied changes.
- `update_product` merges supplied variants and prices by ID. Omitted siblings,
  their prices and option selections remain. `variants_mode: "replace"` and each
  variant's `prices_mode: "replace"` explicitly remove omitted entries. Supplied
  options and details remain complete replacement values.
- `reconcile_products` synchronizes supplied complete catalog entries. Supplied
  options, variants and prices replace their corresponding lists. Omitted
  products remain unless `deactivate_missing: true` disables their sale.
- `replace_resource_localizations` replaces only the submitted resources’ translations for one resource type and locale; omitted resources are untouched.

MCP names map to shared domain functions. REST uses HTTP methods on the same resources; it does not need duplicate verb-named endpoints. `get_organization`, `list_organizations`, and workspace context expose the canonical public site URL; publishing a post returns its full public URL. DNS setup remains in the CMS.

`set_workspace_context` saves the signed-in user's organization and location
preference across connections. Explicit organization/location arguments always
control the current operation.

Every retained tool declares `readOnlyHint`, `destructiveHint` and `openWorldHint`
explicitly. A tool is classified against all supported branches, including optional
guest email and explicit record/content replacement. Confirmation metadata does
not replace server permissions or financial approval. Provider hosting alone is
not open-world: the selected business's Stripe account, media storage and linked
accounts remain bounded targets. Guest email, host attachment downloads and
external social audiences cross that scope.

The [metadata evaluation corpus](mcp-metadata-evaluation.md) contains direct,
indirect and nearby negative prompts for every retained tool. Its prompts are
prepared checks; selection outcomes require an actual refreshed ChatGPT session.

### Release sequence

1. Update the canonical definition and executor together.
2. Update the owning invariant test.
3. Run `yarn mcp:catalog:write` and review the catalog snapshot diff.
4. Run `yarn mcp:catalog` and the affected MCP integration tests.
5. Run the local Worker and verify `tools/list`, the changed tool call, and
   `_meta["krabiclaw/catalogFingerprint"]` through the real client.
6. Refresh and publish the ChatGPT app action catalog when its schema changed
   (`yarn chatgpt:submission:write`).
7. Verify the deployed staging MCP app before promoting to production.

Do not use `serverInfo.version` as a catalog boundary. The endpoint, live
`tools/list` response, and reviewed snapshot define the contract.

### Catalog enforcement

The public catalog is snapshotted in `server/utils/mcp-catalog-snapshots/`.
`yarn mcp:catalog` requires every public tool to be dispatchable and rejects
snapshot drift.

### Incident queries

Use `mcp_tool_call_events` to find unknown tools and repeated failures:

- group unknown tools by `unknown_tool_name`, `oauth_client_id_hash`, and `catalog_fingerprint`
- group repeated failures by `session_id_hash`, `method`, `tool_name`, and `jsonrpc_error_code`
- verify protocol errors use HTTP 200 unless authentication or authorization requires an HTTP error

Telemetry stores hashed session and client identifiers. Never log raw session
ids, OAuth client ids, bearer tokens, authorization headers, full arguments,
article bodies, or upload URLs.

## Product bookings and restaurant table Reservations

Consultations use Product → Variant → Price → Session → Booking. Product bookings
are managed with `list_product_booking_sessions`, `list_product_bookings`,
`get_product_booking`, `create_product_booking`, `confirm_product_booking`,
`reject_product_booking`, `cancel_product_booking`, and
`request_product_booking_change`. These require tenant admin/owner access. Select a
real Session ID from the canonical session listing; it includes pending capacity
and tenant-scoped cross-Product online calendar exclusion. `reassign_product_booking`
changes a whole session's assigned member after atomic availability checks; it
requires the current timestamp and a caller idempotency key. Booking list results
include `assigned_member_id` and accept that explicit member filter.

Booking list results expose parsed `guest` and `provenance` objects (or null), matching booking detail
readback.

Creation uses `server/domain/product-bookings.ts#createProductBooking`, the same
service as the public Product booking route. It derives pending/confirmed status
from Product confirmation policy. A positive Price supports pay-later when online
collection is disabled. Required positive online collection returns
`financial_action_required` with an authenticated product booking dashboard URL
before allocating capacity or creating a Booking, request, Checkout, hold, payment
or authorization. Only a valid explicit zero Price skips required collection.
MCP never changes the payment requirement to make a booking succeed.

Every creation requires a caller `idempotency_key`, `source`, and explicit
`guest_acknowledgement` boolean; `external_reference` and `guest_phone` are optional.
The tenant/key-derived request ID and existing unique constraints protect the
atomic claim/thread batch from concurrent duplicate creation. A durable
normalized fingerprint rejects reuse with different details. Provenance is in
`requests.payload_json.provenance`, including operator, source, external reference,
acknowledgement choice and `creation_kind: ordinary`. Failed follow-up delivery
remains incomplete and may be resumed with the same key using canonical delivery
receipts. Successful replay does not send again. The canonical cancellation-token utility signs a stable per-request capability using the existing email signing secret so a failed guest acknowledgement can retry with the original cancellation link; only its hash is stored. Owner alerts, inbox and audit
remain when guest acknowledgement is false. Guest `user_id` is null for MCP; the
operator is recorded as the member actor, and a matching email never links identity.

These tools create ordinary bookings. They do not offer audited appointment
imports, source-owned calendar reconciliation, or existing-payment conversion.
An existing appointment import must have a separately supported audited contract;
it must never be represented as a new payment or fabricated paid Stripe record.

`operational_booking_id` means `bookings.id`. `request_id` means the guest inbox
thread ID; the legacy public `booking_id` continues to mean that request ID.
Review confirmation/rejection and cancellation invoke the canonical guest-thread
operation service with durable operation keys and guest status messages. Confirm
approves a pending booking; reject declines a pending booking; cancel ends a
pending or confirmed booking. If cancellation or rejection requires a refund,
MCP returns the existing authenticated booking dashboard URL before changing the
Booking or creating financial records. Repeating this handoff creates no refund
authorization. The result states `success: false`, `operation_completed: false`,
`action_required: true` and `code: "financial_action_required"`; clients must keep
the absolute `dashboard_url` and report the operation as incomplete. Changes
invoke the existing immutable guest proposal flow: they do not mutate the booking
until guest acceptance, and acceptance retains review status and operational ID.

Restaurant table Reservations remain separate. `cancel_table_reservation` takes
`operational_reservation_id` (`reservations.id`);
`request_table_reservation_change` proposes location/date/time/party changes through
the same guest approval flow. Restaurant Reservations have no pending review
confirmation/rejection tools. `list_reservation_inquiries` reads them.

## Financial reads and dashboard actions

`list_payments` lists customer transactions, `get_payment` reads one purchase and
its refunds/disputes, and `get_payment_summary` reports period totals per currency.
`get_payment_payouts` reads the connected account's balance and payout history;
`get_payments_usage` reads Payments operating usage and invoices. These calls do
not mutate finance records or move money. Existing records remain readable after
a plan downgrade, subject to the same payment/billing permissions.

`get_payments_dashboard_link` is an owner-only read that returns the authenticated
Payments integration URL. It does not start onboarding or create an account.
Refund preparation/execution, Checkout creation, transfers and payouts are not
MCP operations. Financial approval, execution and interrupted-refund recovery
remain in the authenticated dashboard and canonical Payments service.

Writes declare their MCP annotations. Clients apply their app permission settings;
a model-supplied `confirm: true` field is not authorization.
