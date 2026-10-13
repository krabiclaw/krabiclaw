# Krabiclaw

Krabiclaw helps local and professional-service businesses build and manage a
website through the dashboard and the ChatGPT app. Restaurant, experience and
service businesses share one tenant backend for locations, products, content,
media and guest activity. Public sites render on the server and use the template
registry; the platform marketing site is an ordinary platform-template site.

The dashboard handles onboarding, billing, organization settings and the guest
inbox. Authorized MCP operations manage existing tenant resources on the same
backend. A tool name alone does not establish plan availability, provider
success, a quota or a customer-facing promise.

## Calendar and bookings

Services can use the business schedule or one assigned Better Auth organization
member's working hours, timezone and time off. Existing bookings keep their
assignment until an explicit reassignment. Approved member profiles introduce
the person guests will meet on the service page.

Google Calendar is optional. Connecting the business creates or reuses its
Krabiclaw calendar and projects upcoming pending and confirmed bookings and
reservations. Connecting a member's personal account can exclude busy times from
new availability. Google event edits do not reschedule Krabiclaw bookings, and
personal event titles and descriptions are not imported.

Google Cloud Console reports branding and data access verified as of 2026-10-04.
Calendar uses non-sensitive scopes; the unused broad event scope was removed.
Calendar qualification and scope boundaries are recorded in
[Google Calendar](docs/integrations/google-calendar.md).
Online payments are delivered by the separate Payments change; Calendar does
not establish Checkout, refund or buyer-account availability.

## Plans

Runtime identities are `free`, `growth` and `commerce`; one organization subscription covers
its sites. Customer display names, Stripe product IDs, price IDs and lookup keys
are separate concepts. Renaming a plan label does not authorize an ID migration.

| Field | Canonical source |
| --- | --- |
| Paid plan name, description, image, marketing bullets | Stripe Product: `name`, `description`, `images`, `marketing_features` |
| Paid amount, currency and cadence | Stripe recurring Prices, validated by the application catalog contract |
| Paid display metadata | Stripe Product metadata read by `server/utils/billing-plans.ts` |
| Basic presentation and CTAs | `server/utils/billing-plans.ts`; the free plan has no Stripe subscription product |
| Runtime entitlement policy | `server/utils/billing-entitlements.ts` |
| Current organization access | Better Auth subscription rows read by `server/utils/billing-access.ts`, then the actual operation gate |
| Basic/Growth/Commerce comparison rows | `shared/pricing-comparison.ts`, reading the runtime entitlement policy |

Paid billing surfaces consume `/api/billing/plans`. Entitlements grant capability,
not presentation copy. An active/trialing subscription must satisfy the canonical
billing projection; a declaration is not proof that a send or write enforces it.

Commerce enables online payments; Basic and Growth retain bookings without
online payment. Payments also requires the merchant's Stripe setup and the
relevant product booking/payment configuration. The production pricing page
and Payments help category were read in Chrome on 2026-10-07; this was a
read-only availability/copy check, not a new transaction qualification.

## Decisions still open

Review-request sending is currently paid; the owner question about Free remains
open. WhatsApp business notifications require the paid `messaging` capability
at recipient selection and the defensive sender; authentication OTP is separate.
Saya and Blawby are both provisioned without a billing check, while Blawby's
marketing currently describes Growth inclusion. Documentation and the help form
exist; Community/Priority support wording does not establish a service promise.
These discrepancies must be resolved before publishing comparison claims.

A [read-only Stripe catalog snapshot](docs/product/stripe-catalog-verification.json)
records the verified provider catalog and discrepancies at its stated timestamp.
It is audit evidence, not a replacement catalog. Paid bullets and prices remain
provider-owned; this foundation does not edit pricing or synchronize marketing.

## Implementation context

- [MCP contract](docs/mcp.md) and `server/utils/mcp-tools/index.ts` define the public tool surface.
- `utils/template-registry.ts` owns customer template routing and presentation.
- `server/domain/requests.ts` and `server/domain/guest-threads/` own guest activity and delivery receipts.
- [Testing strategy](docs/testing-strategy.md) defines proof at real runtime boundaries.
- [Local development](docs/local-development.md) defines the current Worker setup.
