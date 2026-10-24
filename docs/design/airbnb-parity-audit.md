# CMS parity audit and approved cleanup

**Reference checked: October 24, 2026.** This replaces the October 1 proposal.
`DESIGN.md` is the contract; this document records the live evidence behind its
shared CMS rules and the scope approved for one cleanup PR.

## Reference and coverage

The authenticated Airbnb host tools were inspected at desktop and phone widths:
Today, Listings, the listing editor, Title, Description, Amenities and its
chooser, safety, Arrival guide, Calendar, Menu, Account, Messages/Notifications,
Earnings, Performance, Reports and Insights. Most paired captures used
1440 x 1000 and 390 x 844; some early references used 375 x 812. The local CMS
baseline was staging `3a18687931afb35d4cc165c8233bbf8c2efd46a8`.

The CMS pass covered all four current-client verticals (Restaurant,
Experiences, Legal Services and Lodging), shared Today/Calendar/Catalog,
Messages, Menu, Website content and settings, Locations, Team, Integrations,
financial settings and existing personal-buyer activity. Representative empty,
populated, creation and operational states were loaded. The generated router
contained 261 dashboard route records, including aliases and reused concerns;
that is an inventory, not a claim that every route/state was separately tested.

Source and existing D1 reads confirmed saved-price scope, Location overview
counts, optional authored facts and real collection memberships. No application
or tenant content was changed during the audit. Raw captures and the complete
local report are review artifacts, not a new application data source.

## What the live reference actually establishes

| Concern | Observed behavior | Shared CMS decision |
| --- | --- | --- |
| Saved editor navigation | Concise saved-summary cards; focused detail editors | Keep the approved editor shell and selective icons; correct shared truncation |
| Title versus description | Title has outlined fields and embedded labels; description is plain | Choose the installed control by task; no blanket ban on borders |
| Amenities | Saved rows include explanations; chooser has plain labels, category pills and search | Retain useful descriptions and canonical selection across filters |
| Commit state | Unchanged text editors disable Save | Save requires valid pending changes; failed writes remain actionable |
| Notifications | Bell destination separate from conversations | One Notifications list per explicit scope, no duplicate Updates mode |
| Earnings and Reports | Distinct working destinations | Remove Reports links that merely reopen Performance; retain actual financial reads |
| Responsive behavior | Phone sheets and desktop editor context | One component and draft per concern across the existing breakpoints |

Airbnb has no direct equivalent for KrabiClaw's multilingual CMS, MCP authoring,
Legal practice areas, restaurant menus or all provider settings. Their data
owners and domain vocabulary remain KrabiClaw's; the shared interaction
patterns do not justify inventing parallel models or workflows.

## Approved correction scope

1. Repair the real Location overview contract and closed-day Hours destination.
   Summarize actual scoped prices and saved Page fields truthfully. Keep a
   visible destination/loading/error state during pending payment reads.
2. Remove empty optional Product concerns, empty grouping destinations,
   single-choice existing-record Type, repeated Team framing, implementation
   provenance badges and irrelevant context rows. Preserve authored typed
   facts, memberships, historical activity and canonical audit records.
3. Reuse installed narrative, form-validation and sizing APIs. Correct shared
   summary truncation, exact dirty state, premature errors and inaccessible
   article actions. Remove inert and unavailable commit footers. Invitations
   start with the existing Member role; elevated access is deliberate.
4. Reuse one preview interaction for supported saved customer-facing content.
   Remove external preview rows, duplicated URL controls and image-only Share
   preview. Keep public Share separate from private credentials and arrival facts.
5. Make Languages an index with explicit actions. Give translations human
   language/content context while preserving whole canonical snapshots,
   version checks and private authoring across dashboard and MCP.
6. Use real configured or historical Calendar activity and domain labels.
   Distinguish Articles from short Posts. Label financial intervals honestly
   and remove redundant reports/analytics presentation.
7. Keep these rules in `DESIGN.md`. Qualify the retained paths through the
   repository's production Worker, browser, D1 and MCP journeys; read writes
   independently. This scope is one PR, not seven releases.

## Boundaries and limits

- The connected Airbnb account has a home and Experience/Service drafts, but no
  published Experience calendar. No exact live scheduling parity is claimed.
- Airbnb's Team entry redirected to Hosting in this account; a populated Team
  state was unavailable.
- Local data had no authored room rows. Current empty room-tour/accessibility
  states were inspected; earlier committed populated-room captures are
  historical evidence, not a fresh audit of that state.
- The restricted browser Maps key remains absent. The owner accepted skipping
  draggable-pin work rather than enabling billing; the server Places credential
  remains private.
- The audit was read-only and did not qualify every write, permission role,
  provider failure or refund. Implementation qualification uses the existing
  journeys and records their actual results in the PR.
- A blank cross-origin Legal preview in background captures resolved when the
  same tab was foregrounded. It was a browser-capture limitation, not evidence
  for weakening framing security or changing publication data.
- The locally observed long successful Payments read establishes the need for
  pending UI; it does not establish production latency or provider fault.

Publication, booking availability and customer-facing content are independent.
For example, the retained Family law Product was inactive while its authored
Page was published. A signed preview may show withheld Product facts; that is
not permission to activate the Product or change the public readiness gate.
