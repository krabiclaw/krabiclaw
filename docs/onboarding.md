# Onboarding

## Principle

Global first, local second, persistent after that.

- **Site/org level** (once per site): brand, currency, reporting timezone, team, ChatGPT app, core offering. Social profiles are the accounts connected in Integrations.
- **Location level** (once per location, repeats on every new location): hours, contact, notification destination, location hero/media, location-specific copy.
- Onboarding is not a single linear flow that ends at "Create site." It collects the first handful of critical steps; everything else is done from the dashboard after the site exists. The flow itself loads no checklist.

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

- The `business` step is one search, `lib/components/workspace/location/GooglePlacePicker.vue`, the same picker add-location and Settings → Integrations → Google Maps use. It calls Places API (New) Autocomplete through `POST /api/dashboard/google-places/autocomplete` and, for the chosen prediction, Place Details through `POST /api/dashboard/google-places/details`, both with one client-generated session token that the Details call ends; the API key stays on the server. Picking a prediction is the confirmation: it records the `placeId` and seeds the location, contact and hours screens, which stay editable. "Enter details manually", under the predictions, keeps the typed name instead. No surface accepts a Google Maps link.
- The first save, on leaving the currency step, creates the active draft through `POST /api/dashboard/onboarding/drafts/active`: a manual draft, or a Google Places draft carrying only the `placeId`, for which the server fetches the full Place Details, reviews included. That same first save also provisions the **real tenant**, pending, as a new organization named after the brand, created through Better Auth with the currency and timezone it cannot exist without (both required organization fields, so the hours and currency steps come before it), through the same `provisionOrganization()` the only other entry point uses, `POST /api/organizations`, with `activate: false`. Both pass the target organization explicitly — `/dashboard/onboarding` is the "New Organization" entry point, so a draft never carries one and the first save creates it and records it on the draft; `POST /api/organizations` takes the organization from the dashboard route's `org` query or an explicit `organizationId`.
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
2 live homes; Growth and Business then charge $9 per additional home per month
at period end. Homes are counted separately from the 2 included business
locations; a home's location does not also count as a business location. See
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
