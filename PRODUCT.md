# KrabiClaw

KrabiClaw helps restaurants, experience operators, law firms and lodging hosts
build and manage a website through the dashboard and compatible MCP clients,
including ChatGPT and Claude. All four verticals share one tenant backend for
locations, products, content, media and guest activity. The `service` vertical is
Legal Services. Public sites render on the server and use the template
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
KrabiClaw calendar and projects upcoming pending and confirmed bookings and
reservations. Connecting a member's personal account can exclude busy times from
new availability. Google event edits do not reschedule KrabiClaw bookings, and
personal event titles and descriptions are not imported.

Google Cloud Console reports branding and data access verified as of 2026-10-04.
Calendar uses non-sensitive scopes; the unused broad event scope was removed.
Calendar qualification and scope boundaries are recorded in
[Google Calendar](docs/integrations/google-calendar.md).
Online payments follow the [Payments contract](docs/payments/payments.md) and
their own plan and connected-account requirements.

## Lodging and direct stay bookings

A home is a place to stay, represented by a Product of kind `stay`, with its own
address, timezone, guest capacity, check-in window, checkout time, photos,
amenities and stay rules. Its calendar holds nights from check-in up to, but not
including, checkout. Hosts can set a base nightly price, override prices or
close nights, and set minimum/maximum stays and arrival/departure restrictions.

On the public site, guests choose available nights at a published home and pay
in full. New customers need Business and a ready Stripe connected account for
this direct booking flow. Checkout holds the selected nights; successful payment
confirms the stay. Recording a stay taken by phone or recording money received
outside KrabiClaw does not itself collect an online payment or send a guest email.

A home is live when it is active at its active location and either published on
the site or syncing through an enabled Channex mapping. Live homes count toward
the plan's home allowance. Every other home is a free draft, with no draft
limit. The home's location is excluded from the separate location count.
See [Plans](#plans) and the [native app contract](docs/shared-auth-contract.md#34-live-homes).

## Guest inbox

Contact messages, table reservations, product bookings and stays share one guest
inbox. A direct stay opens a conversation when the guest has a name and an email
or phone. An imported Airbnb conversation can be addressed through its channel
while the guest's contact details are withheld; the provider's conversation title
is a label, not a verified guest name. A later booking joins that same
conversation without discarding its recorded history.

Direct replies use email and mapped Airbnb replies use the channel. Delivery
receipts distinguish provider acceptance from delivery or reading. An attempt
whose outcome is unknown remains visible and requires review before sending
again. Provider messages are shown with their recorded time and exact source
timestamp when that timestamp has no established timezone.

A workspace can save guest replies. A saved reply can also be
scheduled for named homes: five minutes after a new direct reservation is
received, or at a local time a number of days before or after check-in or
check-out in the home's own timezone. Airbnb stays receive check-in and
check-out messages only, because KrabiClaw cannot tell an imported historical
reservation from a new one. A scheduled message goes through the
conversation's own address and records the same delivery receipt as a reply;
one that fails or whose outcome is unknown stays visible with its reason and is
never resent automatically. Each home holds a private arrival guide — check-in
method and instructions, wifi, directions, house manual and checkout
instructions — that the host chooses when to share.

Workspace members can receive owner notifications as push notifications on the
KrabiClaw iPhone app, per notification category, alongside email and WhatsApp.
A push that Apple refuses is recorded as failed.

## Airbnb listings

A host connects their Airbnb account through Channex and requests which listings
to sync. The request checks the resulting live-home allowance before queuing
anything. KrabiClaw imports new homes and completes their setup, mapping,
activation, future reservations and conversation feed in the background; the
app need not stay open or advance each stage. A draft is an intermediate state,
not a separate activation decision. Progress and failures are read from the
sync request's status. The import asks only for what Airbnb leaves out, using
the organization's contact details where available. A listing without a check-in
start or checkout time on Airbnb fails before creating a home, naming the field
to set there before requesting sync again. This connection applies to the
selected Airbnb account and listings, not every booking channel. See the
[Airbnb sync contract](docs/shared-auth-contract.md#35-airbnb-listings-sync-in-the-background).

The content stage copies the listing onto the home, one Airbnb field to one
home field:

- Airbnb's Listing description becomes the home's description. Its space,
  guest access, interaction, other details, neighbourhood, getting around and
  house rules become the home's sections of the same names. Airbnb's combined
  description text is not used.
- The check-in window (start, end or Flexible) and checkout come from Airbnb.
- Airbnb's pets, events and smoking answers and its quiet hours become the
  home's house rules.
- The check-in instruction becomes the home's check-in instructions. The house
  manual, directions and wifi details become the arrival guide's fields.
- Bedroom, bed and bathroom counts, amenities by Airbnb's own codes, and the
  check-in method where Airbnb's category has a verified counterpart.
- Photos come in Airbnb's order with their captions, fetched at 2560 px.

Nothing is filled in. A text Airbnb has no value for leaves the home's own
alone. A text over the home's limit is cut. An amenity code the home
vocabulary lacks is not written. A photo the host deleted stays deleted, and
photos past the home's limit are not fetched. Airbnb's rooms are not created
as photo rooms, because its photos name no room. Each of these is recorded in
the import's content report, which the apps show the host. A photo Airbnb
cannot serve stops the stage, naming the image and the address tried. The
retry keeps every photo already stored.

A completed import can run its content stage again from the dashboard API.
`scripts/airbnb-content-backfill.mjs` does so for an organization's homes,
fetching photos stored by earlier imports again at full size into the same
photos.

## Team conversations

Members of one workspace message each other in team conversations, optionally
about one stay, with text and photos. Only the members in a conversation can
read it; leaving the workspace ends a person's place in it, while what they
wrote remains. Each member has their own unread state. A new message is pushed
to the other members' phones unless they switched team messages off; team
messages have no email or WhatsApp channel. Owners and admins choose which
homes a member looks after; each home has one assigned member. A member who
leaves, is removed or becomes an owner or admin looks after none.

Owners and admins add people with a single-use invite link that lasts seven
days. Whoever opens it sees the workspace and the role on KrabiClaw's invite
page, signs in or creates an account, and joins; the iPhone app accepts the
same link. A used, expired or withdrawn link says so.

## Plans

New subscriptions use `growth` ($49/month) and `business` ($149/month); `free` is
Basic with no subscription. Business includes Growth, online payments, direct stay
booking and managed advertising. Growth and Business include 2 locations, then $49
per additional location per month, and 2 homes, then $9 per additional home per
month, both billed at the end of the period. A home (a place to stay) is a
lodging unit counted as a home, not as a location: its location is not billed as
a location. Only live homes count; drafts are free and unlimited. Basic includes
2 locations and 2 live homes and refuses a third of either. Existing subscriptions
without the homes price keep their prices. The iOS app is a free companion to the
account where distribution access is available; this does not establish a public
App Store release. Commerce ($89), Marketing ($99) and Business subscriptions on the earlier
$99 price remain existing contracts with their original prices and entitlements. One organization
subscription covers its sites. Customer display names, Stripe product IDs, price IDs and lookup keys
are separate concepts. Renaming a plan label does not authorize an ID migration.

| Field | Canonical source |
| --- | --- |
| Paid plan name, description, image, marketing bullets | Stripe Product: `name`, `description`, `images`, `marketing_features` |
| Paid amount, currency and cadence | Stripe recurring Prices, validated by the application catalog contract |
| Paid display metadata | Stripe Product metadata read by `server/utils/billing-plans.ts` |
| Starter presentation and CTAs | `server/utils/billing-plans.ts`; Starter has no Stripe subscription product |
| Runtime entitlement policy | `server/utils/billing-entitlements.ts` |
| Current organization access | Better Auth subscription rows read by `server/utils/billing-access.ts`, then the actual operation gate |
| Public plan comparison rows | `shared/pricing-comparison.ts`, reading the runtime entitlement policy |

Paid billing surfaces consume `/api/billing/plans`. Entitlements grant capability,
not presentation copy. An active/trialing subscription must satisfy the canonical
billing projection; a declaration is not proof that a send or write enforces it.

## Decisions still open

Review-request sending is currently paid; the owner question about Free remains
open. WhatsApp business notifications require the paid `messaging` capability
at recipient selection and the defensive sender; authentication OTP is separate.
Saya and Blawby are both included on every plan. Documentation and the help form
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
