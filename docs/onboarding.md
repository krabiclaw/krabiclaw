# Onboarding

## Principle

Global first, local second, persistent after that.

- **Site/org level** (once per site): brand, currency, reporting timezone, team, ChatGPT app, core offering. Social profiles are the accounts connected in Integrations.
- **Location level** (once per location, repeats on every new location): hours, contact, notification destination, location hero/media, location-specific copy.
- Onboarding is not a single linear flow that ends at "Create site." It collects the first handful of critical steps; everything else is done from the dashboard after the site exists. The flow itself loads no checklist.

## Foundation and first visual slice

Owner direction, 2026-10-26: keep a stable, measurable product foundation so
the presentation can evolve. Organization creation and account personalization
are the first experience to review for a warmer, more enjoyable CMS. Build on
the existing setup, brand controls and real-site preview.

Booky Boo currently serves lodging on iOS; eventual web/app parity means shared
domain behavior, authorization and outcome meanings. The owner reports that
Kikuzuki, NCLS and Pottery House use Android, with active usage currently
reported for Kikuzuki's messenger inbox and NCLS's MCP blog updates. These are
owner-reported observations, not measured adoption or validation of a redesign.
Evaluate the CMS on Android as well as desktop.

### Stable ownership

- Better Auth owns the person, organization, membership and session. Account
  personalization edits the existing user; it does not create onboarding-only
  identity or a second profile.
- Personal name/photo, an organization's brand and a member's public
  professional profile have different owners. Connect their entrances where
  useful while preserving their explicit scope and canonical operations.
- `ONBOARDING_STEPS` owns sequence, applicability and completion conditions;
  `useOnboardingDraft` owns draft save, restore and activation calls. Brand
  media uploads use the existing draft-media operation and update its revision.
  The shell and step controls render those decisions. A reskin adds no
  provisioning or persistence path.
- The existing pending organization is the eventual active organization, and
  its preview is the real website renderer. Saved answers and imported or
  owner-supplied content remain the source for the preview.
- Owner goals are distinct from account identity and business facts. Their
  capture and the recommendation strategy remain decisions in
  [#1606](https://github.com/krabiclaw/krabiclaw/issues/1606) and
  [#1607](https://github.com/krabiclaw/krabiclaw/issues/1607); a new profile field
  or mandatory setup question is not implied by this first slice.

### Existing journey and verification boundaries

| Moment | Existing surface / owner | Outcome and independent readback |
| --- | --- | --- |
| Arrive or resume | `/dashboard/onboarding` welcome; onboarding shell and active-draft reader | **Get started** opens type; **Pick up where you left off** opens the persisted draft's applicable incomplete step. Welcome arrival and the start/resume action are distinct observations. |
| Describe the organization | `/dashboard/onboarding/:step`; `ONBOARDING_STEPS` and `OnboardingStepScreen` | Collect type, language, name, optional address, required timezone and currency. Before the first save, answers are client state. |
| First save | Currency advance or Save & exit when required details are complete; `useOnboardingDraft.save()` and shared provisioning | Create one real pending Better Auth organization. Read its draft and tenant through the existing readers; missing required state is an error. |
| Make it theirs | Contact, applicable products and look steps; existing location/catalog/brand writers | Save answers to that same organization. Read the saved content and its real-site preview. Legal Services and lodging skip initial products. |
| Inspect the site | Existing desktop preview pane and narrow-screen Site preview action | Render the pending tenant with its preview access. A preview is distinct from publication. |
| Activate | Review; `useOnboardingDraft.activate()` and `activateOrganization` | Activate the organization, set session scope and close the draft. Independently load the public site and organization state. |
| Personalize the account | `/dashboard/account/profile/personal`; `AccountProfilePage` | Save name through Better Auth, photo through the account-avatar operation, and phone through verification. Read the session afresh and inspect the rendered profile. |

### Bounded first presentation work

The first visual pass changes the existing welcome and personal-profile
surfaces: show the saved organization's name when resuming, strengthen the
account photo/name presentation, and improve hierarchy and spacing through the
shared controls described in [DESIGN.md](../DESIGN.md). Continue into the
existing look/review controls and real-site preview. Keep optional
personalization skippable and revisitable through its existing editor.

Save, exit and resume use the existing draft operation and its required-state
rules, described below. Saving and uploads finish before navigation, and a
failed save leaves the edited answers and error visible.

### Measurement and evidence

Reuse the [event measurement contract](operations/event-measurement.md), its
catalog, D1 writer and authorized query/report path. Preserve server outcomes
across layouts and surfaces:

- `sign_up` is once per registered user, recorded by Better Auth's server hook.
- `onboarding_complete` is once per activated organization, recorded by the
  server. It measures activation, not pending-organization creation.

Current `organization_created` instrumentation is a browser interaction emitted
after activation, not the canonical activation count or a native-app coverage
claim. Retain it only if it answers a distinct measurement question; otherwise
use the canonical activation outcome.

Existing dashboard routes are excluded from pageview collection. Step dropoff,
save failures and successful profile edits cannot be inferred from those
pageviews or from an assumed "profile complete" state. This visual pass retains
the existing signup and activation measurements.
Step-entry, action-result and changed-profile-save observations remain proposed
extensions through that same catalog and pipeline in #1607. Define their
bounded step/action/result codes and surface provenance before instrumenting.
Keep entered names, contact details, goal text and error messages out of
analytics. Preserve operational diagnostics in the existing error pipeline.

Use the existing signup/activation outcomes alongside direct walkthroughs and
feedback about clarity and enjoyment. Timing, save-failure and resumption
counts remain unknown where instrumentation is absent. Define an observation
window before calling a stalled journey abandonment. Organization setup
measures site activation; account registration
and successful profile changes remain separate outcomes. Useful inbox/content
work and returning use need their own outcome measures. Small-sample counts
alone do not establish delight or retention improvement.

Review evidence on 2026-10-26: source at `0755ab851`, plus read-only production
inspection of account settings, personal information, onboarding welcome and
the type question at a 390 × 844 viewport. The production build revision was
not established. No account/organization write, preview session, activation or
new event was exercised during that inspection. Existing verification lives
in `tests/e2e/onboarding.spec.ts`, the profile journeys in
`tests/e2e/dashboard-layout.spec.ts` and the D1 analytics suites; source
inspection of those tests is not a fresh passing run. The Save & exit hotfix
was subsequently exercised through the local production Worker:
saved-answer readback, cold resume, revision conflicts, upload recovery
and publication passed; the full local suite passed with 194 tests and 4
skipped. That verifies the hotfix, not owner validation of the visual design.
The visual pass retains the existing account/draft operations and outcome
semantics; its own browser and profile-save verification is recorded with its
pull request.

## Current flow

The flow is draft-first, and this is the one and only new-site creation path:

The business types are restaurant, experience, Legal Services (`service`) and
lodging, from `ALL_VERTICALS` in `utils/vertical-copy.ts`. Lodging uses the shared
customer-site renderer and its stay routes. Creating the site does not create a
home or enable online payments: homes and their calendars are configured after
site setup, and direct paid stay bookings require Business and Stripe setup.

One screen per question, one question per URL, under `/dashboard/onboarding`: `type → language → business → location → hours → currency → contact → [products] → look → review`. `ONBOARDING_STEPS` in `composables/useOnboardingFlow.ts` is the only place that order is written down — Back, Next, the skipped steps and where a resumed draft lands all read it. `composables/useOnboardingDraft.ts` owns every server call; the step screens own presentation and nothing else.

The header offers **Exit** while the required creation details are incomplete,
with explicit notice that answers have not been saved. Once those details are
complete, **Save & exit** saves through the same draft operation and navigates
only after success. A failed save keeps the current answers and its error on
screen. An existing draft with incomplete required edits must be corrected
before saving and exiting; restoration failures cannot overwrite it. Saving
blocks editing and duplicate navigation until the operation finishes. An image
upload must finish before saving or navigating away from its editor.

- The `business` step starts with a manual Name field and an **Import from Google Maps** action. Import opens `lib/components/workspace/location/GooglePlacePicker.vue`, the same picker add-location and Settings → Integrations → Google Maps use. It calls Places API (New) Autocomplete through `POST /api/dashboard/google-places/autocomplete` and, for the chosen prediction, Place Details through `POST /api/dashboard/google-places/details`, both with one client-generated session token that the Details call ends; the API key stays on the server. Picking a prediction is the confirmation: it records the `placeId` and seeds the location, contact and hours screens, which stay editable. **Enter details manually** returns to the manual path with the typed name. No surface accepts a Google Maps link.
- The first save requires the creation details to be complete, normally on leaving the currency step or through **Save & exit** once those answers are available. It creates the active draft through `POST /api/dashboard/onboarding/drafts/active`: a manual draft, or a Google Places draft carrying only the `placeId`, for which the server fetches the full Place Details, reviews included. That same first save also provisions the **real tenant**, pending, as a new organization named after the brand, created through Better Auth with the currency and timezone it cannot exist without (both required organization fields, so the hours and currency steps come before it), through the same `provisionOrganization()` the only other entry point uses, `POST /api/organizations`, with `activate: false`. Both pass the target organization explicitly — `/dashboard/onboarding` is the "New Organization" entry point, so a draft never carries one and the first save creates it and records it on the draft; `POST /api/organizations` takes the organization from the dashboard route's `org` query or an explicit `organizationId`.
- Every following save re-applies the whole draft to that site through `applyOnboardingDraftToSite()`, which is a full rebuild and idempotent. The preview pane frames the site itself, on its own subdomain, carrying the site's preview token — there is no separate draft renderer. The site's address is claimed at the first save and does not change if the brand name does.
- `activate()` makes it public via `POST /api/dashboard/onboarding/drafts/[draftId]/activate`: it re-applies the draft, flips `onboarding_status` to `active`, makes the organization the session's active one, and closes the draft. Abandoning the draft removes the pending site through `DELETE /api/dashboard/onboarding/drafts/active` (see [Deleting a tenant](#deleting-a-tenant)).
- Adding a location to an *existing* organization walks the same step table, as the `add-location` flow: a strict subset — `business → location → hours → contact → review`, with no business type, no brand and no activation, because the organization already has all three. It is not routed; `pages/dashboard/[orgSlug]/locations/new.vue` is the whole walk and holds the current step itself. It writes nothing until the last step, and creates exclusively through `POST /api/dashboard/locations`, which takes either the picked `placeId` (fetching Place Details and importing its reviews) or a typed `name`.

## Content state model

Generated placeholder rows are no longer part of onboarding or site creation. Tenant pages, menu items, and media are either owner/imported records or absent. Missing content is omitted or returned as an explicit empty/error state.

## Step inventory

### Site-level (once per site)

| # | Step | Required | Lands on |
|---|---|---|---|
| 1 | Business type, source language and name (Google Maps search or manual) | Required; address and contact are optional later steps | `/dashboard/onboarding` |
| 2 | Site preview (the pending site on its own subdomain, preview token) | Available after the first save on leaving the currency step | `https://<subdomain>/` |
| 3 | Brand and homepage hero — colour, logo, photo, headline, description | Optional (skippable) | `/dashboard/onboarding/look` |
| 4 | Timezone and pricing currency (before the first save) | Required; opening hours and the business contact number are optional | `/dashboard/onboarding/hours`, `/dashboard/onboarding/currency`, `/dashboard/onboarding/contact` |
| 5 | Initial catalog entries — restaurant menu items or experience offerings; Legal Services and lodging skip this step | Optional; lodging homes and their stay settings are added in Catalog after site setup | `/dashboard/onboarding/products` |
| 7 | Story — about, founder story, FAQ seeds | Optional | Dashboard CMS |
| 8 | Channels — Facebook/Instagram, ChatGPT app install, ChowBot intro | Optional | Dashboard (not part of the onboarding flow) |
| 9 | Team — invite admins/editors | Optional, explicitly skippable | Dashboard settings |
| 10 | Final review and **Create my site** | Required to publish on the included site address; a custom domain is optional after setup | `/dashboard/onboarding/review`; optional domain setup at `/dashboard/[orgSlug]/website/domains` |

### Location-level (once per location, including the first)

Only asked again on **add-location** (the `add-location` flow), which never re-collects site-level brand/ops:

- Location title, address, hours, phone
- Notification routing for this location
- Location hero/media (uses location media only; it remains empty until supplied)
- Optional location-specific notes

Lodging homes have their own addresses and timezones. Add a home as a draft,
configure its listing and nightly calendar, then publish it. For Airbnb listings,
request synchronization: the live-home allowance is checked before work is
queued, and KrabiClaw imports and activates selected listings in the background
without a separate activation request. See the [Airbnb sync contract](shared-auth-contract.md#35-airbnb-listings-sync-in-the-background). Drafts are free and unlimited. Every plan includes
2 live homes; Growth and Business then charge $4 per additional home per month
at period end. Locations are not billed on any plan, and a home's location
is not a second charge. See
[Plans](../PRODUCT.md#plans) and [live homes](shared-auth-contract.md#34-live-homes).

## Deleting a tenant

Onboarding creates the site before the owner has finished answering, so leaving
the flow leaves a pending site holding a subdomain. Abandoning the draft through
`DELETE /api/dashboard/onboarding/drafts/active` removes it at once. Owners
delete a live workspace from Site settings → Delete workspace, and their account
from Account → Delete account; both are Better Auth's own delete endpoints and
take effect immediately. Every path runs `cleanupOrganizationBeforeDelete` in
`server/utils/tenant-deletion.ts` first, which releases the Cloudflare custom
hostnames and the Cloudflare Images the organization is the last holder of.
Better Auth then deletes the organization, and D1's `ON DELETE CASCADE` takes
the domains, locations, content, bookings, reservations, integration
selections, media and the onboarding draft that created the site with it, so
signing up again starts a new draft rather than resuming the deleted site. The
user's linked provider accounts belong to the user, not the organization, and
remain. Deleting an account first deletes its Customers on businesses' connected
accounts, with the cards saved there; see Saved cards in
`docs/payments/payments.md`.
