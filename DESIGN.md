# CMS navigation and editing patterns

**Status: Contract**

The vocabulary the dashboard CMS is built from. It exists so a new screen is a
choice between named, already-built patterns rather than a fresh invention, and
so review can say "that is an index, indexes do X" instead of arguing from
taste.

Airbnb's host tools are the reference. The goal is **parity of behaviour**, not
pixel copying, and where Airbnb has no equivalent this document says so rather
than forcing an analogy.

**There are no exceptions to this document.** Products, bookings, posts, Q&A,
photos and every surface added later obey the same rules. A screen that cannot
be built from the patterns here is a gap in this document to be argued and
written down — not a one-off. Every previous "this one is different" is what
produced the inconsistency the redesign exists to remove.

### Product page presentation

Product hero captures, image proportions/focus, editorial story layouts and
open feature columns belong to the existing page blocks. Their controls are
declared in `utils/tenant-page-blocks.ts` and rendered by the existing
`TenantPageFieldControl` under Pages → page → section; no new editor route or
writer is introduced. The owner is the explicitly selected organization's
`content_block`, under its page document. The existing page update operation
and media placement operation enforce that organization's website permissions;
CMS and MCP use those same operations. Read the saved page and its public route
back after a change. A hero's product image uses its own `featured` placement,
separate from its background `media`; it never borrows another block's image.
Image crops change presentation only and retain the original uploaded capture.

## The two axes

Navigation questions are almost always one of these two, and confusing them is
what produced the CMS's earlier inconsistency.

**Chain** — how deep the content nests. Unbounded, driven by the domain: an
index may open another index. `Menu > Website > Pages > page > section > field`
is six levels and that is fine.

**Presentation** — how one node renders. Exactly two renderings, chosen by
viewport width, never by depth.

A node's place in the chain never changes how it renders, and its rendering
never limits how deep the chain goes.

## Chain vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| **Root** | The scope switcher. Not editable content. | Organization, Personal |
| **Index** | A screen whose job is to route onward. Its rows are links, and each row previews its current value. | Location, Menu, one dish |
| **Leaf** | A screen that edits **one concern** and commits. | A dish's price, a post's body |

An index may contain another index. A leaf never contains navigation to a
deeper editor — if you need one, the "leaf" is an index and should be named as
one.

There are two words here and they are the same two everywhere: **index** and
**leaf**. Each is a kind of level, each has exactly one shell, and nothing in
the dashboard is a third thing.

**A level owns something.** A new destination must own a coherent task,
entity or set of settings — a thing the owner names, orders, deletes or
configures as one. A navigation layer that exists only as a decorative
category is not a level. A navigation list has no inert headings: every row is
a destination or an explicit action. An ordinary heading inside an article, a
preview or a form is not navigation and stays text.

**Admitting a new concern.** Before adding one, name its data owner, its
canonical operation, the editor or control that already edits it, its
canonical parent, its explicit scope, its permission or entitlement, and how
its write is read back. Add it beneath that owner, or link to the editor that
already exists. A new Product kind adds its rows to the one Product editor,
not another editor tree; a new theme adds no CMS route or writer. A real gap
is resolved here and in the shared implementation together.

## The organization's workspace

`docs/design/airbnb-navigation-map.md` is the captured Airbnb host map. It is
evidence; the decisions below are KrabiClaw's. `O` is `/dashboard/:orgSlug`.

**Primary navigation** is the same five destinations, in this order, for every
theme:

| Tab | URL | Holds |
| --- | --- | --- |
| Today | `O` | the day's agenda |
| Calendar | `O/calendar` | bookings and availability by day |
| Catalog | `O/products` | what the organization offers |
| Messages | `O/messages` | guest and internal member conversations; Team settings owns membership and access |
| Menu | `O/menu` | a launcher |

**Menu is a launcher, not a parent.** It lists the Earnings and Insights cards,
then Website, Locations, Team, Integrations, Plan and billing (owners and
admins), Platform accounts (Better Auth admins, inside KrabiClaw's own
organization only), Account settings,
Switch to Personal and Log out. Each row opens a destination of its own; none
is nested under Menu. The desktop slideover and the narrow Menu page render the
one model in `useOrganizationSettingsNavigation`.

The destinations are files under `O`, and their URLs are their files:

| Destination | URL |
| --- | --- |
| Website | `O/website` — Pages, Blog, Posts, Reviews and Q&A, Brand, Status, Domains, Languages, Currency, Website booking |
| Pages | `O/website/pages`, a page `O/website/pages/:pageId`, the Links page `O/website/pages/links` |
| Blog | `O/website/blog` |
| Reviews and Q&A | `O/website/qa` |
| Brand | `O/website/brand` and its leaves |
| Posts | `O/website/posts` — short posts to the site and its connected social accounts |
| Locations | `O/locations`, a location `O/locations/:locationSlug`, `O/locations/new` |
| Team | `O/team` |
| Integrations | `O/integrations` |
| Earnings | `O/earnings` |
| Payments | `O/payments` — the organization's own Stripe account and payouts |
| Plan and billing | `O/billing` — the plan as one card with its one change (Upgrade to Business, Choose a plan), the locations it bills, the services sold beside it, and Stripe's portal for the card, invoices and cancelling |
| Insights | `O/insights` |
| Notifications | `O/notifications` |
| Platform accounts | `O/platform-accounts` |

Notifications have one destination in each scope, reached by the Menu bell.
Personal uses `/dashboard/account/notifications` and the same notification
reader with explicit personal scope. They are not a Messages filter. Insights
holds performance and reviews; canonical audit records do not need a second
generic Activity feed. A Reports link must open an actual report concern, not
another copy of Performance. Financial range labels name the interval read.

**The shell is the active organization's.** Tabs, Menu and where a root exits
follow Better Auth's active organization — the route's, otherwise the
session's. Account settings (`/dashboard/account/profile`) and Past activity
(`/dashboard/account/activity`) are one user page each at one URL, and opened
from an organization they keep that organization's tabs, light its Menu and
exit to it: a lawyer setting their Google Calendar is still in their firm, and
its Calendar tab is the firm's. Personal — the buyer's Today, Calendar,
Messages and a launcher Menu at `/dashboard/account/menu` — is reached only by
Switch to Personal, which sets the active organization to none. Opening a page
never changes it.

### Today and Upcoming

Today is the viewer's current work and booked activity. Upcoming is the same
card list for future occurrences and preparation tied to real dates. Both use
the existing `TodayAgendaCard` presentation: one small time or status line,
headline, location or context, image and badge, with the entire card a link.
An undated task states its status rather than inventing an appointment time.

Owner/admin cards order outstanding decisions, replies and current failures
before scheduled activity, then at most two factual performance or content
opportunities. Assigned service members see only
their own authorized appointments and related work. Lodging members see only
the arrivals and departures at homes assigned to them through Better Auth
members or teams. Owners and admins also see guests currently staying, between
their arrival and departure days; these are not extra cleanings for assigned
members. A departure notes when another noncancelled stay at that same home
arrives on its checkout date.

The card is an entrance to its data owner, never a second editor or task
database. A reply opens its conversation; a decision opens its booking; a
missing photo opens that Product's photo; a draft opens its article or post.
An article-to-Facebook suggestion opens the canonical short Post creation
flow with that article prepared, then the existing publishing controls for
review. A performance card retains its exact reporting dates in Insights.

Current domain state determines whether work remains outstanding. Reading a
notification does not complete it; several notifications for one concern make
one card. Resolved work disappears, while unresolved work survives midnight.
Booking occurrences retain their own location's timezone. Future bookings
needing a decision belong in Today now and retain their actual booking date.

Stay cards read the canonical agenda and open `O/bookings/stay/:stayId`.
The existing stay domain owns homes, assignments, nights and payments; Today
projects its arrivals and departures rather than creating a lodging service or
second lifecycle. Cleaner cards show the guest's first name, party size, home,
location and check-in or checkout time. Access to each stay and its conversation
is authorized by the existing member or team assignment. Owners receive stay
conversation work through the same guest inbox as other booked activity.
Lodging does not offer the appointment-assignee filter: the home's assignment
controls its stays.

### Verticals and Domain Focus

KrabiClaw serves four explicit, concrete business verticals:
1. **Restaurant**: menus, dishes, sections, table reservations.
2. **Experience**: classes, workshops, dated ticketed sessions.
3. **Lodging**: homes, stays, nights, check-ins, check-outs, turnovers.
4. **Legal Services (`service`)**: solo attorneys, partners and law firms running the Blawby template (modeled after North Carolina Legal Services).

The `service` vertical is exclusively and canonically **Legal Services**. Do not generalize it into an open-ended multi-service or agency platform (no salons, spas, cleaners, trades, or generic appointment widgets). Offerings are **Practice Areas & Consultations**; practitioners are **Attorneys / Legal Team**; counterparties are **Clients**; and bookings are **Legal Consultation Requests**.

### Catalog

**Catalog is where everything the business offers is found, as Airbnb's Your
listings.** It navigates rather than edits: kind pills — All, Menu,
Experiences, Services, Places to stay, each only when the business
has one — over one grid of photo cards, full width on a phone. A menu belongs
to a location, so the Menu is one card per location, opening that location's
menu; every other offering is its own card, opening the one Product editor.
Because the menus are already per location, Catalog has no location filter.
Dishes without a section are listed on the Menu page under its sections.

Discrete views that narrow a list use `DashboardFilterPills`, one row of round
pills under the title with the chosen one solid, 32px from the title and from
the rows — Catalog's kinds, Today's
range, Insights views, the blog's and posts' states, a
category collection, a photo category. A list carries no sentence explaining
itself under its title.

Every offering, from anywhere, opens the one Product editor at
`O/products/:productId`. Each card names its actual sections, price and location
relationships. Missing photos and prices say No photo and No price set.
Online is read from the booking configuration; absent location assignments do
not imply every location. Inactive locations and withheld or unavailable
offerings retain their names and state. The Menu page's location is explicit
in `?location_id=` and narrows the authorized menu without changing it.

| View | URL | First working screen |
| --- | --- | --- |
| Catalog | `O/products?kind=` | one card per location's menu, then every other offering; `kind` is the pill |
| Edit menu | `O/products/menu?location_id=` | the chosen location's sections, in the order guests see them |
| A section | `O/products/menu/:collectionId?location_id=` | its items, in order |

**A menu belongs to a location.** With one location the Menu opens on it and
names it. With several, a location must be chosen before its sections can be
reordered or added to; with none chosen, every location's sections read side by
side, each with a way into editing it, and no single reorderable list is
assembled from several locations. Sections every location shares are their
own list, edited with no location chosen, and never silently merged into a
location's.

In the menu workflow a collection is always a **section**: Add section, Edit
menu (section order), Edit section (item order). Collection stays the name of
the model. **Remove from section**, **stop offering at a location** and
**delete the item** are three different actions: removing an item from a
section changes that section's membership and nothing else, and deleting a
section never deletes what was in it.

A shared section opens without a location query; a location-owned section
opens with its own location id. Membership and order are always edited from
the complete organization catalog. A location filter must never turn a full
membership replacement into a replacement of only the visible subset.

Services and Experiences have no grouping step. A service's overview leads
with Assigned team member (the booking assignment concern: who guests' bookable
consultations are with — not case ownership, and changing it never reassigns
existing appointments), Consultation pricing, Bookings, Description, Page
content, Locations and Website visibility. Pricing has one entrance. Its index
names the saved prices and any real choices; a single amount opens beside it
on desktop, while several amounts leave the choice to the host. Named priced
versions remain valid without choice dimensions. Adding a dimension requires
an explicit value for each saved version and preserves its identity and prices.
Typed facts open their own editors from the record; they do not need another
overview card. Show authored optional facts; missing optional facts are offered
through the existing registry's Add detail action, not a permanent stack of
empty cards. Short introduction belongs with Description and retains its
separate canonical value. Existing records do not reopen a single-choice Type
step. Empty grouping and consultation-only concerns do not belong on an
informational practice area; real memberships, pricing and terms remain
editable through their existing owners.

Price summaries read the actual saved offers across their explicit scopes.
No shared price is different from no price anywhere. Editing names the shared
or selected location scope and never chooses another location for the caller.
Website visibility states publication; consultation availability is independent.

### Tabs, parents and exits

Three separate questions, three separate answers. None is derived from another.

- **Ancestry** — the panes beside a level and its Back — is the real nested
  route parent. A file's place in the tree is its URL; there are no
  `definePageMeta({ path })` overrides.
- **The lit tab** is declared by each destination root as
  `definePageMeta({ tab })`: `today`, `calendar`, `catalog`, `messages` or
  `menu`. The layout reads the matched root's `tab` and nothing else. A screen
  that declares none lights no tab; nothing is inferred from its URL or exit.
- **A root's exit** is `meta.back` on a standalone destination root only.
  `menu` names the shell's Menu: Website, Locations, Team, Integrations,
  Insights, Notifications, Earnings, Plan and billing, Platform accounts,
  Account settings and Past activity exit there. A named route is a specific exit: Payments to
  Earnings. Catalog, Today, Calendar, Messages and Menu are primary
  destinations and have no exit. A nested level never declares one.

The booking mounts keep their own affiliation: a booking opened from Today is a
root that exits to Today and lights it; the same booking under a calendar day
is a child of the calendar, which lights Calendar.

### Who owns what

| Owner | Holds |
| --- | --- |
| Product, its variants and prices | what is sold: kind, pricing, booking, publication, locations, collections, its page |
| A page, article or post | its own content |
| Location | its place, hours, photos and reservation policy |
| Organization member | that member's public profile and independently authored availability in the named organization |
| Organization | the shared site: brand, domains, languages, connections |
| User | account name, avatar, personal preferences and security |
| Guest messaging | organization saved replies and their automatic home schedules at `O/messages/replies`; immutable delivery snapshots at `O/messages/scheduled` or a conversation's `scheduled` child |

Saved replies use the canonical message-template operations: Reply edits its name
and reusable message, Automatic schedule edits its trigger, local time and named
homes. New saved reply presents the message and optional schedule together before
creating one record. Managers create, change and delete them; members can insert a reply into
the conversation's existing composer before sending. Scheduled-message history
reads the canonical snapshots and reasons; managers may cancel pending messages.
Neither editor introduces a second sending or scheduling lifecycle.

Themes own nothing. A theme renders what these hold; it adds no CMS route,
editor or writer, and it never grants or hides an authorization.

### Airbnb, mapped

| Airbnb | KrabiClaw |
| --- | --- |
| Listings holds homes, experiences and services behind kind pills | Catalog's pills are Menu, Experiences, Services and Places to stay; each is a view of the same Products |
| Homes and experiences have different editors | One Product editor at `O/products/:productId` for every kind: kind changes wording and rows, not the route or the editor |
| Listing editor rows preview their values and open one concern | Saved Product, location, page and member settings do the same |
| Pricing and availability link to the calendar; Earnings links to payouts | Catalog links to Calendar and member availability; Earnings links to the organization's Payments |
| — | Blog/Docs articles and short Posts have no Airbnb equivalent: their existing canvas and composer edit the content directly inside the shared shell |

### One record, many entrances

An entrance is a link, not a parent. Several screens may link to one record;
none of them forks its route, draft, writer or data source.

| From | To |
| --- | --- |
| A location | `O/products?location_id=`, `O/posts?location_id=`, `O/website/qa?location_id=`: the same lists, scoped |
| A menu section | the Product's own `O/products/:productId` |
| A Product | its page in Pages at `O/website/pages/:pageId`, its location relationships, member availability, Calendar |
| A page a Product owns | that Product, from the page editor's Offering row |
| Search, MCP `admin_edit_url`, notifications, the agenda, Languages | the record's editor, built by `server/utils/dashboard-links.ts` and nowhere else |

`location_id` is a scope and `locale` an identity. Both are URL state,
validated before anything loads or writes, kept across children and reload,
and never guessed from a previous screen. A scope never becomes a global write.

### Products and their pages

A Product may own one page, bound by the page root's `product_id`; a locale
representation inherits the binding through its root. **Every page is edited in
Pages**, at `O/website/pages/:pageId`, including a page a Product owns: Pages
lists it, the Product's Page content row opens it there, and the page editor's
Offering row leads back to the Product — one document, one editor URL, two ways
in. A service with no page shows No page and Create page under its Page
content; nothing infers a binding from a `/services/` path, a matching title or
the only candidate.

Creating a service creates the Product, its default variant, its page at a free
`/services/<slug>` and the binding in one batch, under an idempotency key, so a
retry returns the same pair. It starts sale-inactive and unpublished, with no
price and no booking. A bound page is public exactly while its Product is
published on the site; there is no second publish flag for it.

### Places to stay

A place to stay is a Product of kind `stay`, edited in the one Product editor.
Its Stay settings row owns its one location (chosen once, when it is created),
check-in and checkout times, how many it sleeps, the minimum nights and the
team who look after it; it has no Scheduling or Locations rows. Its price row
is the base nightly price. Its stays are on Today and the Calendar, on the day
guests arrive and the day they leave, and open at the booking route as
`bookings/stay/:stayId`. A stay taken by the host records offline payments and
is cancelled there, and is not refused by closed nights or minimum stays —
those are what guests and channels are offered; a stay from Airbnb or another channel is read-only and
changes on that channel. A published place to stay is booked on the website:
it has no external link, and publication requires its home and nightly price.
Without online payments the listing takes enquiries; with payments ready,
guests choose nights on its page and pay the full amount on the site's pay page.
While they pay, a checkout hold claims
those nights (and closes them on a connected channel), and the captured payment
becomes a confirmed direct stay with its guest conversation. A lapsed hold gives
its nights back.

Today and Calendar open the same manual-stay creation form at
`O/bookings/stay/new`: home, dates, guest and total together, with an optional initial
payment recorded in that same operation. A supplied home stays explicit; without
one the host chooses it. Creation opens the existing stay detail after readback.
The home's nightly calendar has Month, Year and List views. Its native calendar
control selects separate nights; Select nights chooses a contiguous run. All
views read the same home calendar, and all selected-night writes use the existing
night operation with its visible channel result.

What the home is and offers — its property type, bedrooms, beds and baths, its
amenities from the fixed catalog in `shared/stay-listing.ts`, and its short- and
long-term cancellation policies — are stay settings on the product, shown on
its page and in its `Accommodation` data. Its address and map pin are its
location's. Its arrival guide (check-in method and instructions, wifi,
directions, house manual and checkout instructions) is private: only managers
and the home's assigned members read it, and no public page carries it. The
iPhone listing editor, MCP and web Product editor edit the same facts. The web
listing index separates Your space from Arrival guide and previews their saved
values; it does not combine the private guide with the public listing preview.

### Organizations

The tenant is Better Auth's organization, and the dashboard calls it that:
Organizations, Switch to an organization, New organization, Delete
organization. Business, site and workspace are not names for it. Choosing,
creating and deleting one live in Account settings → Organizations; deleting is
owner-only, asked of Better Auth's `organization.hasPermission` and done by
`organization.delete`. Words that describe a real business to a guest or a
provider — Stripe's business information, a guest's conversations with
businesses — keep their natural wording.

## Leaf size

**A leaf edits one concern.** Its controls support one named decision and
commit together. Control count does not decide its depth: selecting amenities
can need a long searchable list, and describing an accessibility feature can
need an answer, photo evidence and guidelines. Splitting either into arbitrary
levels would scatter the decision.

The captured host tools distinguish focused decisions from indexes:

| Screen | The entire detail pane |
| --- | --- |
| Title | one input and a `44/50` counter |
| Listing description | one textarea and a `482/500` counter |
| Amenities | a searchable selection list, with filters that narrow the choices |
| Pricing | one value row, one toggle, one link |
| Hours by day | an index: one row per weekday previewing its hours; the day leaf is one switch and two time pickers |
| Repeating start times (KrabiClaw) | an index of saved weekly rules, reached from Availability; the day leaf edits that weekday's times |

**Independent concerns belong behind their own saved summaries.** Airbnb's
Description screen is not a form with five textareas; it is five rows —
Listing description, Your property, Guest access, Interaction with guests,
Other details to note — each previewing its current value in two lines, each
opening its own leaf.

Split a form when its decisions can be named and edited independently, rather
than making controls smaller or adding a navigation layer to satisfy a count.
A palette, a logo's presentation, a media grid and a day's list of times each
remain one concern. The article canvas, below, edits one whole artifact.

## Controls

**One header rule for every list screen.** The panel's navbar carries Back, the
title and what you can do to the list — Edit, Add, Manage — and the body
carries its rows and factual scope or status. `DashboardListEditor`
and `DashboardGridEditor` teleport their controls into the navbar of the index
panel they are mounted in (`dashboardPanelActionsKey`); a page never draws a
second header in the body, and never puts Add in one place on one screen and
another on the next. A list mounted outside an index panel keeps its controls
at the top of the list.

The inside of a leaf, measured against Airbnb's host tools (see
`docs/design/airbnb-parity-audit.md`). The theme in
`app.config.ts` and the two shells carry most of this; a page states the
control and nothing about its size, radius or width.

**The control follows the decision.** A setting uses a switch (`SettingRow`);
an explicit reported fact must preserve unanswered separately from No. A
one-of-N choice uses `URadioGroup variant="card"`, with no wrapper of its own.
Checkboxes select several amenities or existing dishes, or records for a list
action in `DashboardListEditor`'s *Select* mode. They do not imply that every
unselected or unanswered fact is false.

Filters narrow what is visible; selection changes membership. Amenities use
All/Suggested pills and search to find choices while keeping selected facts
across those views. Add dishes selects actual existing records. Neither a
filter pill nor a search result creates a new catalog value or section.

**A box means "choose me" or "open me".** Rows are separated by a 1px
hairline with 24px of padding. A bordered card is a selectable choice or a
value that opens a leaf. It is never a container for a control: a checkbox in
a card, a switch in a card, a field in a card are each a row.

**Explain the decision once.** `DashboardLeafPanel` takes its introduction as a
single `lead` under the title. Do not repeat it around each field. Definitions,
photo guidelines and validation belong beside the choice they clarify when
they are needed to answer accurately. A row carries a concise factual sub-label.
A counter
(`44/50 available`) sits above the field in `text-sm`. `hint` exists only for
`Optional`.

**The index shows saved facts; the leaf owns the draft.** The lodging listing,
Restaurant dish and Experience editors use saved-summary cards in `EditorNavigationList`;
menu sections use the same component for their saved name, description and
photo. Show the actual image, price, membership and state, including No photo,
No price set, unavailable and unpublished. For a saved record, a draft must not
relabel the index or guest preview before it is committed and read back.

Cancel discards the local draft. A failed save keeps the submitted values and
the version they were based on, shows the failure, and reads the saved record
again without silently rebasing the draft. Conflict recovery is an explicit
choice to use the current saved facts. A successful write whose required read
failed remains a visible failure.

Save is available for a valid pending change, including a retry after a failed
write. Reverting to saved values clears that change. Use the installed form's
validation and the owning editor's saved baseline, not another save-state
framework. Required errors appear after interaction or submission. Immediate
actions, connection instructions and unavailable/read-only settings have no
commit footer. New Team invitations start with Member; elevated access is an
explicit choice through Better Auth's existing roles and permissions.

**Icons identify destinations and meaningful choices.** Follow the captured
Airbnb host editor's restraint: amenities have recognizable pictograms;
ordinary listing fields, house rules and safety switches stay text and their
controls. Meaningful property choices use the same pictogram language. A title,
description, URL or price does not need a glyph.
KrabiClaw extends this language to its own destinations — Website, Locations,
Team, content sections, bookings and Account settings — across every catalog
kind. A heading or a scalar field is not a destination merely because it has a
route.

`EditorNavigationList` renders a destination's explicit `icon` as a bare 24px
outline beside its label. A record's real picture or a provider's logo (`lead`)
takes precedence; never add both, or put a general glyph in a decorative tile.
The picture's missing-image footprint remains the picture's, and an icon must
not hide the factual No photo state. Labels remain visible, icons are hidden
from assistive technology, and selection is conveyed by a control state and
border or check mark as well as colour.

Meaningful single choices use the existing `URadioGroup` card with
`indicator="hidden"` and its native item `icon`: 32px above the label, one
neutral outline, a strong selected border. Amenity selection is a list of
24–28px pictograms, labels and an explicit selected state; each complete row is
one keyboard-operable control. Ordinary settings retain their existing switch
or rule pair. Action glyphs stay at the existing button size.

**One concept, one icon source.** Product kinds, product details, content block
types, notification categories and stay vocabularies carry their icons in
their existing registries. Static destinations declare theirs in the owner
that already declares the row. Never infer an icon from a label, URL or record
id, and never create a second navigation model for icons. Native stay symbols
and web glyph names describe the same canonical choice.

Use the installed Lucide collection first. Original domain drawings belong to
the `krabi` collection in `build/icon-data/custom-icons.json`: a 24×24 viewBox,
2px rounded strokes, `currentColor`, and no background or baked-in state. They
fill recognizable gaps such as a crib, dryer, sauna or treehouse. Nuxt Icon
bundles the used glyphs and local collection at build time; no runtime icon API
or full server collection is needed. Check the actual rendered glyph at phone
and desktop widths before treating a mapping as complete.

**Everything starts at the gutter.** Nuxt UI's panel gutter (`px-4 sm:px-6`,
`dashboardGutterClass`) is the one horizontal edge, the same as the top nav's:
Back or ✕, the title, the rows, the fields and Cancel all start on it, and
nothing is centred. A component inside a panel adds no outer padding, scroll
container or column of its own; a row whose highlight reaches the pane's edge
pulls itself into the gutter (`-mx-4`) so its text keeps the edge. A level that
scrolls itself (`fill`) pads its own rows with the gutter. Every footer is
framed by the panel — gutter, hairline, `py-3` — and holds only its row.

**One header row, decided by the shell.** As Airbnb's: a tab root opens on its
large title with its actions on the same row and no bar above it; a pushed
level puts a round Back first — on its own row above the title on a phone,
inline before it from `lg` — with the actions at the right of that row; a
leaf's sheet has ✕ and its title small and centred, and the leaf's pane its
title large. Back, ✕ and every action are the same round button. Pages
supply `title`, `lead` and `#right`; they never place a title or an action
themselves.

**Reuse the card that owns the job.** Saved editor summaries use
`EditorNavigationList`'s cards; selectable choices use the native radio or
checkbox control. Other content cards use `UCard variant="subtle"`, with their
padding and corner from `app.config.ts`; a content card that links renders as
that link. An empty list or
record is `UEmpty`. Status that belongs to the whole dashboard — the live
connection, a failed background refresh — is the shell's one banner above the
navigation, never a box repeated inside each screen; a screen shows only its
own failures.

**Controls fill their pane's inner width.** Below `lg` a level is the whole
screen or a drawer; above it the native panel owns its width. Paired indexes
and leaves have no second width cap inside that panel. The title, field and
footer share its gutter. Explicit standalone `column` screens retain the
shared reading or leaf width; a calendar or grid takes the available frame.

**A level alone in the frame is one of three things, and the empty right side
of a desktop window is never the fourth.** Content that scales — a grid, a
table, a calendar, a chart, cards — takes the frame: Today, Calendar, Catalog,
Insights, Photos, Transactions name no column. A settings index pairs with its
first row where there is a pane, as Account settings, Integrations,
Plan and billing and Earnings do: its rows are leaves beside it and `autoOpen` names the first.
Only a list of records with nothing of its own to open — Notifications, Past
activity, Paid, Platform accounts — or a true single-concern screen (Menu, a
booking's notes, a calendar day) stands alone as a column, and says which in
`DashboardIndexPanel column`: `reading` for the records, `leaf` for the screen.
Beside a child every index fills its own pane. Standalone widths live in
`dashboardColumnWidths`; a page never states one. A column's title heads it,
as a leaf's does. Every level title is `dashboardTitleClass`.

**The text control follows the task.** The live Airbnb Title editor uses
outlined fields and embedded labels; Listing description uses a plain textarea
(desktop and phone, October 24, 2026). Do not infer a blanket rule against
field borders. Structured names, dates, times and addresses may retain visible
boundaries. Narrative prose uses the installed textarea's `none` variant,
without redundant labels or inner padding, and its native autoresize API.
Fields fill their pane. Width changes invoke that same sizing API where needed;
do not add a second textarea-sizing implementation. Rich Markdown and article
canvases retain their own native editing controls.

**Preview belongs to customer-facing saved content.** Product, Page, Post,
Article and Links previews reuse `DashboardContentPreview` and
`useDashboardContentPreview`. The editor URL holds the preview mode and device;
closing returns to the same concern and restores focus. A compact eye control
opens it; a URL or external View row is not another editing concern. Share
belongs inside the preview and uses only a real published public URL, never a
preview credential. Settings and internal facts need no decorative preview.
The private Arrival guide uses that interaction with its existing authorized
read, no iframe or public URL, and never becomes public listing content.

**Languages is an index; translating is a content mode.** Add language is an
explicit action, independent of Publish, Disable and Delete content. The index
has no page-wide Save. Translation controls name the actual saved content and
human language, make source text available where needed, and avoid repeated
resource identifiers and language-code labels. The existing canonical writer
preserves the complete translation, unseen fields, explicit empty/null values
and revision checks. Saving a private language does not publish it. Dashboard
and MCP use the same operations and owners.

**Sizes come from the theme.** Controls are `lg` — 16px text, 44px tall, 8px
radius — and the commit bar's Save is the one `xl` (48px). Body text is 16px
`text-highlighted`; sub-labels and counters are 14px `text-muted`. Focus is a
2px `text-highlighted` ring, not the brand colour. Buttons, Save included,
are neutral: navy in light, white in dark. Coral marks status and selection
only — the lit tab, today's date, unread dots, the chosen bar. Switches are
black, as Airbnb's are.
Enabled secondary buttons use full-contrast text across every neutral variant.
Muted labels and reduced opacity signal disabled controls, including disabled
links and buttons waiting for a save. These states belong to the shared theme.

## Canvas and composition

Article writing and short Post composition use the frame when the content and
its preview need the space. Both reuse `DashboardIndexPanel` and the route's
`dashboardFrame`; neither introduces another shell or loses the parent URL.

**A canvas edits the artifact directly.** The writer types into the rendering
readers will see. There is no field list because there are no fields; the body
is the control.

**The exemption is from leaf size, and from nothing else.** A canvas is a level
of the chain like any other: it renders inside the shell, it computes its own
frame mode, and it re-roots. Full-bleed means the writing column fills its own
pane — never that the canvas replaces the application. A surface that escapes
the frame takes the tenant's rail, navbar and place in the chain with it, which
is what re-rooting exists to prevent.

The canvas carries no Cancel/Save footer. Its one editable title is in the
canvas; Save, Preview and metadata destinations stay accessible in its header
while the article grows. Those actions use the existing saved article and
draft, not a second initial snapshot. Blog creation calls the artifact an
Article, distinct from a short Post.

**The exception covers the writing and nothing around it.** Category, tags,
excerpt, publishing time, visibility and search appearance
describe the post rather than being it. They are fields, and they obey leaf
size: an index of rows, each previewing its value, each opening its own leaf.
New articles include their actual publication prerequisites, such as category,
beside the writing so the first Publish can complete without an intermediate
record. Saved article settings retain their existing focused editors.

**The test: is the control editing the artifact, or describing it?** Editing it
is a canvas. Describing it is a field, and fields decompose.

**A short Post is composed together.** Its ordered photos/video, caption and
explicit publication destinations are one publishing task. The composer leads
with media, permits text-only posts where the destination supports them, and
shows the current draft beside its preview on desktop. A phone keeps media,
caption and publication controls in one scroll. Optional headline, link button
and location stay in More options. Save
draft is secondary to Publish. An existing Post opens the same composer, not a
six-row field index. Each destination retains its own canonical receipt and
failure/reconciliation controls; website publication never implies social
delivery. `PostEditorPage` and `usePostEditor` reuse the existing media picker,
public media renderer, post writer and publisher that MCP uses.

Creation references read on 2026-10-25: [Instagram's media-first post flow](https://www.facebook.com/help/instagram/442418472487929),
[Meta Business Suite's media, text and destinations composer](https://www.facebook.com/business/help/942827662903020),
and [TikTok's capture/upload, edit and publish flow](https://www.tiktok.com/support/faq_detail?id=7581826684085606968&category=web_account).
These inform the task sequence; available destinations still come from the
canonical publisher and saved connections.

## Presentation

| Width | Chrome | Detail |
| --- | --- | --- |
| `< md` (768) | Bottom nav | Modal leaf drawer over its visible parent: ✕ top-left, its title small and centred beside it, commit bar pinned at the base |
| `md` to `< lg` | Top nav | The same modal leaf drawer |
| `≥ lg` (1024) | Top nav | Pane beside the index |

`md` swaps navigation chrome. `lg` swaps index/detail topology. One component
owns both renderings of a node, and there is no separate mobile screen.
`useDashboardPane()` is the shared JavaScript breakpoint: it selects the leaf's
drawer or inline host and decides whether an index opens a child on arrival.
The index columns otherwise follow the route hierarchy through CSS.

Below `lg`, `DashboardLeafPanel` uses the native `UDrawer` with a backdrop,
modal focus and swipe dismissal. Its nearest parent index remains visible
underneath; deeper ancestors still yield. Index-to-index navigation remains one
screen at a time: a parent index is hidden by CSS only while a child index is
rendered beside it, so it never disappears while its child is still loading
and a leaf's drawer always rises over it. The drawer is the only motion; a
level does not animate its own arrival. One persistent editor instance is teleported between the
drawer and desktop pane, so resizing preserves its draft and form state.
The drawer does not create another route, editor or draft owner.

**The two columns show the deepest two levels, not the first two.** Depth is
unbounded, and opening a child re-roots the frame: the index column becomes the
screen you were just on, and the detail column becomes the child. Airbnb's
listing editor does this — at `details/description` the left column reads
"Listing editor"; open Listing description and the left column *becomes*
"Description" while the right holds the textarea. The back control moves up one
level, never to the root.

A fixed two-level frame is what forces a deep chain to collapse into one long
pane, which is how the CMS grew its large forms.

### A level is a file, and there are two kinds

A URL segment is a level, and a level is one file under `pages/`. There are two
kinds, and each has exactly one shell:

| Kind | What it is | Shell | Controls |
| --- | --- | --- | --- |
| **index** | lists rows that link to its children; renders `<NuxtPage />` | `DashboardIndexPanel` | Back → parent |
| **leaf** | edits one concern; has no children | `DashboardLeafPanel` | Close → parent · Cancel → parent · Save |

Adding a screen is therefore: drop the file in its parent's directory, pick the
shell, and if it lists, its rows link to `` `${level.path.value}/<child>` ``; if
it edits, it injects the parent's draft key. A screen's URL is its place in the
file tree. Nothing else is required, and a screen that needs something else is a gap
in this document rather than a one-off.

### How a level knows which column is its own

`useRouteLevel()` answers it, and it takes no arguments. It is the single
source for a level's depth, its mode, its parent, and where its Back goes.
Nested pages already say what contains what, so `route.matched` is the chain and
a level finds its own place in it through `matchedRouteKey` — the record the
`<RouterView>` rendering it provides, read once: a component is mounted for one
record, and Vue Router's ref follows the live route, which during a navigation
already names the next screen. Nothing assembles a base path out of route
params and slices the URL against it, and no level counts a depth that is not
its own: the index column and the leaf beside it ask the same composable and get
two different answers.

Depth is counted in matched records, not URL segments: a directory's
`index.vue` is a second record at the same URL and is one level, not two.

| Mode | When | What the level renders |
| --- | --- | --- |
| `index` | nothing below me is open | my content, the full width of the frame |
| `pair` | one of my children is open | my content as the desktop index column; below `lg`, the backdrop for a leaf drawer or hidden for a child index |
| `yield` | something deeper than my child is open | nothing but the route beneath me |

**A level in `yield` renders no rail.** It is hidden, not unmounted, so going
back to it shows it as it was rather than loading it again. An ancestor that kept drawing its own
index while a grandchild drew another pair put three columns on screen and left
the leaf 348px of a 1280px window.

Every level in a chain is a route parent, so it has a `<NuxtPage />` to put its
child into. A directory's `index.vue` exists only where the bare URL has
something of its own to show.

`mode` is read by the two shells and by nothing else. A page carries no
breakpoint, no `hidden lg:flex`, and no mode of its own — which is what keeps
the two renderings of a node in one place instead of in every page that has
children.

### Pairing and auto-selection are two rules

They answer different questions and neither decides the other.

**Pairing.** On desktop, every non-root level renders beside its logical
parent. The logical parent is the same parent Back uses. Pane topology is
independent of whether the level contains records, fields, settings, media, or
another index.

Destination roots stand alone: Today, Calendar, Catalog, Messages, Menu, and
each Menu destination — Website, Locations, Team, Integrations, Earnings,
Payments, Plan and billing, Insights, Notifications — as Airbnb's `/hosting/listings` grid does.
A root that is a grid or a chart uses the frame; a root that is settings opens
its first row beside it (Leaf width, above). Within a destination, levels pair
with their parent: Pages, Blog, Reviews and Q&A, and Brand render as
`Website | Pages`, and a Catalog entry renders beside Catalog.

**Auto-selection.** Auto-selection answers whether an index may choose one of
its own children on arrival. It does not determine whether the index has a
parent pane.

| The index's own children | `autoOpen` | Examples |
| --- | --- | --- |
| deterministic leaves or settings sections | its first available child | page editor, product, post, Q&A, Brand, Website, Integrations, location settings, Account settings, booking Change |
| arbitrary records | none | Catalog, Pages, Blog posts, Posts, Locations, menu sections, items in a section, Services, Experiences, Q&A, Team, Google Maps locations |

Which record a tenant meant to open is not something the screen can guess, and
a record is a place, not a field. So `Website | Pages` is correct with no page
chosen, and `Account settings | Personal information` is correct because
Account settings has a deterministic first section. Measured on a live Airbnb
host account at 1332px (2026-09-21): the listing editor opens `photo-tour` on
arrival and keeps a half-width column of rows beside it. The pair splits down
the middle, as Airbnb's does (80–660 of 1332).

`autoOpen` navigates with `replace`, so Back still leaves the index rather than
landing on it again. It opens only on arrival — the router is at the index's own
URL — and only while the index is bare, the `index` mode:
opening the child makes the level a `pair`, which is what stops it. There is no
"already opened" state, so returning from a child to the bare index — Back from
deeper — opens the first child again. It is ignored when the target is the
index's own URL, which is what an index still loading offers as its first row.
Below the pane width the index *is* the screen and nothing is chosen on the
tenant's behalf. It waits while the level is in a mode its URL names, such as
its translations, and opens the child when the mode closes.

### What the URL holds

A URL names a record, a concern, a keyed item, a tab or a mode, and a direct
entry or a reload reconstructs it. A control's temporary state — a picker, a
popover, a filter chip, a confirmation — is not in it.

- **Keyed items use their ids.** A price choice is `price/choices/:optionId`, an amount
  `price/amounts/:variantId`, a block `sections/:blockId`; never an index, a
  name or a combination label, so reordering or renaming never changes which
  item a saved URL edits.
- **Views keep their query.** Blog or Docs is `?collection=`, Q&A or Reviews
  is `?tab=`, a catalog kind is `?kind=`.
- **Data is awaited, not lazy.** A level's data is `await useAsyncData` in its
  setup, so Nuxt's `<NuxtPage>` keeps the screen being left until the next one
  can render complete. No skeleton stands in for a level's first paint, and a
  refresh keeps what is on screen.
- **A substantive mode is a query on its record's own URL.** Translations are
  `?editMode=translations&locale=<locale>`. `DashboardResourceLocalization`
  opens on arrival, and writes the URL as it opens, changes language and closes;
  without `locale` it is on the source language and picks nothing. The record
  whose level the URL ends at owns the mode, so a Product and its page never
  both open, and a row that opens the mode is a link to it.

### Beside its index, a leaf carries only Save

At two columns Airbnb's leaf has no Close and no Back of its own: the index's
Back is the way out and Save is the only control it draws. Both Close and Cancel
belong to the drawer the leaf becomes below `lg`, where its parent remains
visible behind the backdrop and it needs its own way back.

One shell owns that, so a leaf states what it commits and nothing about width.
There is one visible Back or Close for the active level at each viewport; a
page never adds a second one inside its content. The parent remains the same
when the pane becomes a drawer.

### Where a level goes when it closes

Back, Close and Cancel navigate to `useRouteLevel().to`, a push to the level
above with its query preserved. Close, Cancel, backdrop, Escape and swipe
dismissal all discard the leaf's unsaved edits through its existing cancel
handler, then return to that same parent after the drawer closes. Save keeps
the record's existing commit and navigation behavior. A direct leaf URL has
the same parent and dismissal behavior. Nothing calls `router.back()`.

Measured on a live Airbnb host account (2026-09-21): their in-app Back went to
`/hosting/listings` while the previous history entry was the leaf that had just
been cancelled — Back, Cancel and Close all pushed. The destination is a
property of where you are, so a deep link, a reload, and a redirect after a save
all answer the same thing, and a drawer you just closed can never become the
place Back leads. Reading history is what produced the loop where closing a
sheet and then pressing Back reopened it.

**There is one parent graph, and it is the nested route tree.** Any
relationship that is expected to render as a desktop parent/child pair must
exist in the nested route tree and therefore appear in `route.matched`. Back
and pane layout read the same hierarchy: a level's parent is the nearest
shallower matched level, and Back goes to that level's URL.

A root's exit and its lit tab are separate declarations (see *Tabs, parents
and exits*). `meta.back` is the exit of a standalone destination root and is
never used to model pane ancestry; `useRouteLevel()` throws when a level that
has a matched parent declares one. `meta.tab` is read by the layout from the
matched root alone. The booking's are set where `build/booking-routes.ts` mounts
it, because the same files have a different parent under the calendar day.

A primary destination has nothing above it, so it renders no Back at all.

**One subtree, two parents, is mounted twice.** A file sits in one place in the
tree, so where the same levels must render under a second parent, the
`pages:extend` hook in `nuxt.config.ts` mounts them again: the same files, a
second set of records with their own names. `build/booking-routes.ts` mounts a
booking under its calendar day and the account's own record under its calendar
day and Today. Nothing else is mounted twice: a page a Product owns is edited
in Pages, and the Product links to it. The generated router, not the
filesystem, is the complete tree.

**A level on its way out reads the route it rendered for.** Nuxt keeps an
outgoing page's route, and the level's own record is read once, so the screen
being left stays whole until the next is ready, and its `autoOpen`, which only
fires on arrival, opens nothing.

## Creating

Creation presents the coherent task the author came to complete. It does not
create a minimal record merely to unlock its photos, description or price.
`Add` opens `new` in the record's own slot, in the existing shell. A short Post
opens its composer, an Article opens the existing title/cover/body canvas,
and Catalog creation presents the offering's essential facts together. A dish
offers photo, name, description and amount in one screen. The kind, menu
section and location explicitly supplied by the entrance remain its context;
the form does not ask for them again or infer another one. Legal practice
areas do not require photographs. Lodging retains its actual location,
capacity, arrival/departure and minimum-night requirements.

Optional facts do not block saving a draft. Publishing checks the real domain
requirements and names actual missing facts. A multi-step task that genuinely
needs separate concerns uses the existing `useCreateWalk`, with explicit Next
and final Create actions; it is not the default for every record. Simple links
and sessions retain their existing focused leaf.

Opening or composing never persists an empty record. The draft belongs to the
record in `useState`, with its retained creation idempotency key, until an
explicit Save draft, Create or Publish. Existing domain operations remain the
writers for CMS and MCP. When creation needs an id before media/relationships
can be attached, preserve that returned id and visibly complete the remaining
work before navigating to success. A failure does not create another record
on retry or discard the author's pending input. Dismissal leaves for the
canonical parent and discards unsaved edits.

## Committing

Cancel on the left, Save on the right, pinned to the base of the detail pane
(the drawer below `lg`). Cancel is a text button; Save is the only filled
control on screen. Save is disabled until there is something to save.
Dismissing discards the draft.

## Editing states

**List editor** (`DashboardListEditor`) — a list of records.

- *Browse*: rows are the content, and the row body is a **link** to the
  record's own URL. A row that navigates from a click handler cannot be opened
  in a new tab, gives the reader no destination to see before pressing it, and
  puts a second copy of the record's path in the list.
- *Edit*: the same rows in place, grown controls. Nothing navigates, so a
  half-finished edit cannot be stranded behind a back button.
- *Select* (`selectable`): edit mode swaps the per-row remove control for a
  checkbox, and the header carries the count and the actions.

**Grid editor** (`DashboardGridEditor`) — media. Browse, manage, and a
full-bleed takeover for bulk selection.

**Item sheet** (`DashboardListItemDialog`) — one leaf. Sheet on mobile, dialog
above, commit bar at the bottom, destructive action opposite the commit.

It carries a leaf, which means it is subject to the leaf-size rule: a sheet is
not a licence to stack a record's whole field set because it is not a route.
A record with many fields opens an index of rows; each row's sheet holds one
concern.

A slideover is the same. Being an overlay rather than a route changes where a
level is drawn, never how large it may be. A pane holds an index and swaps to
one leaf at a time.

## Rules that have earned their place

Each of these replaced something that was actually wrong.

**Reorder is a mode, not a write per press.** Rearranging stays local while the
edit state is open and commits one complete order when it closes. The previous
per-press commit plus full reload is what made ordering feel broken. Order
endpoints therefore take the *whole intended order* and reject a partial one —
there is no insert-before arithmetic anywhere.

**Move is a separate action from Reorder.** Move transfers selected membership
from an explicit source to an explicit destination. Reorder changes sequence
within one section. Overloading one control with both is what forced
single-item moves.

Airbnb has Move and no Reorder at all — room order is fixed by room type. Menu
sections must be orderable, so Reorder is a deliberate addition, not parity.

**Menu membership is plural and explicit.** A dish's Menu sections screen lists its
saved memberships as links to those sections. Add to section keeps its existing
memberships; Remove from section changes only the named membership; Move from
a section opens the same `CollectionMoveDialog` used by bulk selection. The
free-text box they replaced silently forked a new grouping on a typo. A
location-owned section names its location, including inactive state; a shared
section says Shared by every location. Moving membership does not change where
the dish is offered or whether it is published.

Move is one canonical operation, never a source removal followed by a second
client save. It carries the complete expected source and destination orders,
keeps the destination's existing order and appends moved items in source order
without duplicates. Reorder and removal also carry the source snapshot. A stale
snapshot leaves both sections unchanged, shows the conflict and offers Use
current items; completion reads both saved orders through the full organization
catalog. Visible location scope never replaces that membership owner.

**Preview belongs to customer-facing content.** A Product or Page can show what
its customer will see. A price, assignment, working-hours rule or other
operational concern does not get another preview of its own. Page Preview is a
compact eye action beside its title; Product View retains the saved-summary
editor's floating action. Neither needs a separate action row in the body.

**Preview is the saved guest surface.** The lodging listing, Restaurant dish,
Experience, Legal Services and Page actions use `DashboardContentPreview` to
open the real tenant page with its authorized preview token;
Desktop and Mobile change the viewport of that same page. It is not a second
rendering of the form draft, and opening it does not publish the record or
change its availability. The full-screen preview temporarily covers the editor;
it is not a leaf in the right pane. Its Share action uses the saved, eligible
public address from the canonical read, never the iframe URL or its preview
credential. Private content says Private preview. A paused booking calendar
does not make an otherwise published Page private.

A dish preview needs an explicit active location where that dish is offered.
Keep a location already targeted by the editor; otherwise ask the owner to
choose from its actual assigned locations. Never substitute the first
candidate. Inactive locations retain their name and state, and an invalid
location or unreadable page produces a visible failure. Closing preview returns
to the same editor concern and restores its View control.

An Experience uses its real `/experiences/:slug` page. Preserve the editor's
explicit physical or online scope; an unscoped preview uses that page's existing
booking-scope chooser. The website preview token requires organization-wide
content access; an assigned host keeps their Product editor without receiving
a token for other unpublished pages.

**Legal content keeps its real owner.** The Legal Services Product index uses
the same saved-summary cards and focused editors. A practice area without a
booking configuration does not imply an attorney assignment or available
consultations. Configured consultations use the existing Product booking owner,
attorneys or legal teams, clients and offices. Page content links to the bound
Page editor, and Preview uses that Page's saved path; a Product slug does not
invent a second legal page. Assigned attorneys retain their authorized Product
work without gaining organization-wide Page editing, preview or translations.

**Translations edit content in another language.** Use the compact Translations
action on its owning record, with the language named in the editor. Added
languages can be authored while private; saving a translation does not publish
the language. Preserve the complete saved translation, including fields the
current editor does not display. Dashboard and MCP use the same canonical
translation operations and version checks.

**Public addresses are assigned, not a tenant setting.** Do not dedicate a row
or leaf to editing a slug or path. Renaming a Product, Page, Article, Post or
Location preserves its saved address, as does editing an existing translation.
New translations receive their source's canonical address in the chosen
language; historical authored translation addresses remain intact. Canonical
writes enforce this for dashboard and MCP, including reconciliation. This does
not prohibit the existing semantic operation of changing a Product kind or an
Article's Blog/Docs collection. Show a public address through Preview and Share
when it is useful, rather than making routing another authoring task.

**Experience details are guest decisions, not another model.** What you’ll do
edits Product description. Where to meet, What is included, What to bring,
Before you arrive and Cancellation policy open the existing Product detail
editors directly. A cancellation description explains the host's terms; it
does not configure an automatic refund policy.

**Experience availability uses the shared Calendar destination.** The Offering
selector switches between bookings, nightly stays and configured experiences or
legal consultations. Experiences use Calendar's existing month, list, year and
day views with actual saved sessions, rather than a second Product calendar.
Add availability opens the existing occurrence editor under Calendar;
Repeating times opens the existing location-owned weekly rules. Month and
date live in the URL. A successful write requires a fresh calendar read in
the occurrence's month before its editor closes. Empty dates do not invent
occurrences from rules or imply that an unmaterialized rule is unavailable.

Physical start times belong to an explicit saved location. Location filtering
changes scope, never membership; inactive locations remain visible.
Add availability remains available across locations; its editor requires an
explicit active physical location and its timezone before a time can be saved.
Saved occurrences retain their own timezones when Location settings change.
Online sessions use the assigned host's existing working hours; `online` is a
public booking scope, never a physical Location or Price ID.
An online-only offering leads to Bookable times even with All locations
selected. Switching to All bookings clears that virtual Online scope.

Airbnb's [Experience calendar guide](https://www.airbnb.com/help/article/2645)
describes Calendar → Add availability and optional daily or weekly repetition.
The live account has only an in-progress Experience, so its published calendar
has not been visually verified. KrabiClaw's continuing weekday rules have no
bounded series or repeat-until date; do not present controls or “this and
following” changes that those canonical operations cannot honor.

**A control must not be able to build an invalid state.** If the server rejects
a combination, the form should make it unrepresentable rather than allow it and
then refuse to save. A price belongs to a variant, so the editor asks for a
price per variant and never offers a product-level amount the server has
nowhere to put.

**The picture leads.** Rows lead with a thumbnail; a leaf leads with the image
large. When there is no image, show a muted icon in the *same footprint* so a
list does not reflow between rows that have one and rows that do not.

**Unsupported routes 404, and so does a record that is not there.** The level
that cannot render its record or concern for this organization raises Nuxt's
404 itself. Never redirect and never render a fallback.

The dashboard renders on the client, so a 404 is raised with `showError`, never
with a bare `throw` in a page's setup. Measured 2026-09-21: a synchronous
`throw createError` in a nested page's setup escapes during that page's own
render and leaves a blank screen and a null vnode, while `showError` reaches
Nuxt's error page. A guard that has to run again when the route changes belongs
in a `watchEffect`, because moving between leaves reuses the component.

A record the list does not contain is missing state, not an empty draft:
`links/items/<unknown-id>` rendering a blank Link editor, with a Save that would
write the list back unchanged, is the failure this rule exists to prevent.

A missing record and a failed request are not the same event and do not get the
same answer. A record that is not there is not a page, so it 404s. A request
that failed is a state the surface shows, because the record may well still
exist. Rendering "not found" inside the pane for both made a deleted record look
like a broken editor, sitting in a frame with a rail, a navbar and a commit bar
for something that does not exist. `isNotFoundError` in `utils/errors.ts` is the
one place that tells them apart.

**Empty is a state, not a bug.** A section with no items, or a location with
no sections, renders its own empty state. Containers that cannot be
empty are a modelling error.

## Parity is page-level, and a screen is built once

What went wrong on 2026-10-05, written down so it is not repeated: a run of
work shipped the right *concepts* — buyer Today, buyer Calendar, a purchase
screen, an Earnings page — each as its own freshly drawn screen. They did not
look like Airbnb, did not look like each other, and could not be maintained,
because every one re-stated layout, copy and state that already existed.

**Read the Airbnb page before drawing anything.** Start with the saved captures
and `docs/design/airbnb-navigation-map.md`; where the evidence is missing, open
the actual screen in the owner's logged-in browser. Read its sections, headings,
rows, button labels and card shapes, and mirror that structure. "Inspired by" is not
parity. Earnings is Performance card → Upcoming → Paid → Reports; Airbnb's account
Payments has *Manage payments* → *Your payments*; Payouts is *How
you get paid* rows + *Add payout method* + *Need help?*. When Airbnb has no
equivalent, say so in a comment and keep the screen to the smallest honest
thing — never invent a section to fill the space.

KrabiClaw's personal Payments opens its payment and refund history directly;
there is no second concern requiring a settings index. Organization payouts
remain in the organization's Earnings. Profile & availability opens the
explicit organization member: public name, photo and bio can be saved before
Hours are known. A profile save preserves availability, calendar selection and
existing sessions. Unknown Hours say Not set; only an explicit Hours or time-off
change recalculates the schedule. Account name and avatar remain Better Auth
User facts, and failures stay visible in the editor that attempted the save.

**One screen per concept, scoped, never copied.** A second audience gets a
`personal-scope` (or similar) prop on the existing component and a scope on the
existing data source — `TodayPage`, `CalendarPage`, `BookingDetails`,
`MessagesPage`, `AgendaFilters`, `PaymentDetails` all work this way. The buyer
booking and the tenant booking are the same `BookingDetails`; a purchase is the
same screen with no visit. If a new file under `pages/` contains markup for a
list or a record, that is the smell: the markup belongs in the component the
tenant already uses, and the page is a one-line mount.

**One control per job.** Agenda and calendar filters use `AgendaFilters`;
discrete list views use `DashboardFilterPills`, and choice pickers keep search
and selection in the component that owns that decision. Money words come from
`paymentStateLabel`. The record screen is one `BookingDetails`. Reuse the
existing owner rather than introducing another implementation of its job.

**Customer words, not system words.** "Paid", "Refunded", "On its way",
"Amount paid", "Get receipt", "Send a refund", "Who's coming". Never
"captured", "fulfillment", "recovery", "Review refund", "Refresh status", a
Stripe id, or a UTC qualifier in something a customer or tenant reads. Status
that must be re-read from a provider is re-read on load, not behind a button.

**The picture leads, from real data.** Cards and rows carry the thing's photo —
the place, the offering, the person's account picture — with an icon in the
same footprint when there is none. Avatars come from Better Auth's
`user.image` through the record that owns it; never a placeholder face.

**Beautiful is the shared shell plus Airbnb's structure.** Rounded cards with a
hairline ring, 24px rows separated by hairlines, one big figure per card, soft
secondary buttons and one filled primary — and nothing else. A screen that
needs a new visual device needs a reason written beside it.

## Where we deliberately differ from Airbnb

Airbnb has no equivalent, so these are additions rather than parity, and each
one says so where it lives:

- **Plan and billing.** What the organization pays KrabiClaw: its plan, the
  one-step Upgrade to Business, the services sold beside it with their
  requirements as met or open rows, and Stripe's billing portal for the card,
  invoices and cancelling. Owners change it, admins read it, members have no row. Airbnb
  charges hosts no plan, so it has no equivalent.
- **Platform accounts.** A Menu row no tenant sees: every account on the
  platform, and impersonation. It is shown only to a user whose Better Auth
  role is admin, on any organization, and Better Auth's admin plugin enforces
  it on the server; a template never decides it. Internal admin tooling is not
  in Airbnb's host dashboard at all.
- **One editor for every kind.** Airbnb edits a home in a two-column editor and
  an experience or service in a step-based one. Every Product kind here uses
  the one Product editor.
- **Writing and short posts.** Blog/Docs articles are written on a canvas, and
  short Posts go to a website and its connected social accounts. Airbnb has
  neither.

Deep links are parity, not a difference: Airbnb gives sections, leaves, keyed
items, tabs and some modes their own URLs (`house-rules?feature=checkInOut`,
`?editMode=true`), and so do we.

## Naming

Use the owner's vocabulary, not the schema's. The catalog's words are fixed,
whatever the template: Catalog; Menu, Experiences, Places to stay, and
Practice areas & consultations; a menu's
**sections** and its **items**; a **variant** is a purchasable version of one
offering, never a section. Collection is the model's name and never appears in
the menu workflow; blog categories classify articles and are not part of the
catalog. `ProductPresentation` names a kind of item for public pages; plurals
live there too, because appending `s` produces "dishs".
