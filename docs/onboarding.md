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

Booky Boo renders website setup natively using the same server steps as web. The owner reports that
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
- `server/utils/onboarding-flow.ts` owns question order, applicability, labels,
  proposals, completion conditions and resume. Web and Booky Boo render this
  projection and use the existing draft save, restore and activation operations.
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
| Arrive or resume | `/api/post-login`, `/dashboard/onboarding`, and the iOS guide | A new owner starts on Business type with a neutral illustration. Selecting a type shows an example website. **Continue website setup** opens the saved question, or the first incomplete one if a prerequisite is missing. |
| Describe the business | Server flow projection, web step controls and native iOS views | Collect type, name, country, a time zone, website language and pricing currency. Address fields are optional. An unambiguous time zone appears in the address screen. |
| Save | **Save & exit** or **Finish**, through the shared draft operation | Save answers from Business type onward. A partial save leaves organization creation until the answers are complete. Read the saved draft through the active-draft endpoint. The same draft retains prior contact, hours, brand and authored products. |
| Finish | Existing activation operation | Activate the organization, set session scope and close the draft. The site is private. The server routes the owner to their first offering where applicable. |
| Personalize the account | `/dashboard/account/profile/personal`; `AccountProfilePage` | Save name through Better Auth, photo through the account-avatar operation, and phone through verification. |

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

Manual lodging setup in Catalog uses the same server steps on web and iOS:
address, property, space, map pin, location sharing, capacity, amenities,
photos, title, description highlights, description, minimum stay, prices,
discounts, and safety disclosures. Finish creates a private listing. The public
listing shows the saved safety details before guests book.
The listing editor owns publication and subsequent changes. Weekly, monthly,
and last-minute discounts apply to direct booking quotes, using the largest
eligible percentage. They do not change channel rates.

Each question occupies one screen. The web paths live under
`/dashboard/onboarding`. Booky Boo renders the same ordered questions.

| Step | Question | Answer |
| --- | --- | --- |
| `type` | What kind of business do you run? | Select the business type. Continue after reviewing the example website. |
| `business` | What’s your business called? | Enter the name, or select a Google Maps business to seed the details. |
| `location` | Where is your business based? | Select a country. Add an address if useful. Edit the time zone here if the server can propose one or the draft already has one. |
| `timezone` | What time zone do you use? | Choose a time zone if one could not be determined on Location. |
| `language` | What language is your website in? | Select a supported language. The source language of existing draft content is fixed. |
| `currency` | What currency do you price in? | Confirm or change the proposed pricing currency and select **Finish**. |

`GET /api/post-login` sends new owners to the business picker. iOS requests
`?format=json` to read the same destination without changing the active
organization. `GET /api/dashboard/onboarding/drafts/active` supplies the saved
answers and the **Continue website setup** action for both clients.

`POST /api/dashboard/onboarding/flow` evaluates the current answers and returns
the ordered steps, field labels, business and language choices, currency and
time zone proposals, and the resume step. **Exit** closes setup before a type
is selected. **Save & exit** saves the current answers and question once a type
is selected. A failed save leaves edits and the error visible.

- **Import from Google Maps** uses the existing Places autocomplete and
  details operations. The chosen place seeds editable name and location fields.
  The save passes the place ID and edited answers. The server fetches the
  provider's phone, hours and reviews.
- The first complete save through `POST /api/dashboard/onboarding/drafts/active`
  provisions a pending tenant and claims its included address. Subsequent
  saves use the same draft revision and tenant. A failed revision check keeps
  the newer saved answers.
- **Finish** saves and activates through
  `POST /api/dashboard/onboarding/drafts/[draft_id]/activate`. The organization
  joins the active workspace list with the website private. Today shows the real
  tenant and opens Website status to publish it on the included address.
  Discarding a draft removes its pending site.
- Adding a location to an existing organization has its own flow
  (`business → location → hours → contact → review`) in
  `pages/dashboard/[org_slug]/locations/new.vue`. It creates the location
  through `POST /api/dashboard/locations`.

## Content state model

Generated placeholder rows are no longer part of onboarding or site creation. Tenant pages, menu items, and media are either owner/imported records or absent. Missing content is omitted or returned as an explicit empty/error state.

## After website setup

Brand, hours, contact, catalog, connections and team are available in their
dashboard editors. The website preview is available on Today once the site is
created.

### Location-level (once per location, including the first)

Only asked again on **add-location** (the `add-location` flow), which never re-collects site-level brand/ops:

- Location title, address, hours, phone
- Notification routing for this location
- Location hero/media (uses location media only; it remains empty until supplied)
- Optional location-specific notes

After creating a lodging website, Catalog shows **Add your first home** and
**Import from Airbnb**. Booky Boo uses the same choices from the stay-homes
response. Manual setup starts with the address, then asks for property type,
rooms and capacity. Both clients use the steps returned by the server and save
the home as an unpublished draft. Airbnb sync requires Business and opens the
existing connection and listing picker.

After creating a private website, the server opens its first offering guide
when the business needs one. A restaurant or experience with a saved offering
can continue managing it from Catalog.

- **Restaurant** resolves the menu section and asks for a dish name, photo,
  description and price. Photo, description and price are optional. **Finish**
  opens the saved dish editor scoped to its menu location.
- **Experiences** asks for a title, resolves venue and host, then collects
  duration, capacity, an optional photo, description, price and first session.
  **Finish** saves the scheduled session and opens the draft experience editor.
- **Legal Services** asks for the practice area, description, consultation
  format and attorney. It collects a public name and working hours when
  needed, then duration, any office-specific availability, and fee. **Finish**
  opens the draft practice area with consultation requests configured for firm
  confirmation. Website visibility and accepting requests are separate actions.

Today links owners back to the server-selected resume step. Web and Booky Boo
render the same guide response from `/api/dashboard/onboarding/offering`. On
iOS, the guide opens the existing dashboard editor after saving.

Lodging homes have their own addresses and timezones. Add a home as a draft,
configure its listing and nightly calendar, then publish it. For Airbnb listings,
request synchronization: the live-home allowance is checked before work is
queued, and KrabiClaw imports and activates selected listings in the background
without a separate activation request. See the [Airbnb sync contract](shared-auth-contract.md#35-airbnb-listings-sync-in-the-background). Drafts are free and unlimited. Basic includes
1 live home; Growth and Business charge $4 per home per month at period
end. Locations are not billed on any plan, and a home's location
is not a second charge. See
[Plans](../PRODUCT.md#plans) and [live homes](shared-auth-contract.md#34-live-homes).

## Moving existing stays from Hostaway

Owners and admins with operations-update permission can open the one-time
migration task under **Connections → Migrate from Hostaway** after setup.

The host pauses affected Airbnb listings before connecting or switching the
channel manager, downloads Hostaway's complete-field reservation CSV, and
uploads it. The walk confirms column meanings, date and decimal formats, and
explicit property matches. It includes guests already checked in as well as
future stays, preserves actual payment state, and shows duplicates and
conflicts before import. Missing facts require source review rather than
defaults. Every matched home's manually blocked dates are checked separately;
a reservation export is not assumed to include them. Homes absent from that
export can be selected separately for their manual closures.
The host compares every Hostaway calendar; verification covers only the homes
and source records explicitly included in the migration.

Import writes the existing stay and night records. Reuploading the source file
resumes against those records without duplicate stays; no guest records or CSV
contents are retained in browser storage. The import does not send a new-booking
confirmation or collect payment. Normal future check-in and checkout message
schedules still apply; arrival instructions should be reviewed before import.
The final step distinguishes saved data from
actual Airbnb calendar readback and shows uncovered dates and mismatches. The
host keeps listings paused until checks pass, reviews arrival instructions and
conflicts, and confirms reopening the desired listings in Airbnb. A failed or
incomplete verification does not mark the move complete.

## Deleting a tenant

Saving completed answers with **Save & exit** leaves a pending site holding a
subdomain. Abandoning the draft through
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
