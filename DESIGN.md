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
| Messages | `O/messages` | guest conversations |
| Menu | `O/menu` | a launcher |

**Menu is a launcher, not a parent.** It lists the Earnings and Insights cards,
then Website, Locations, Team, Integrations, Platform accounts (Better
Auth admins, inside Krabiclaw's own organization only), Account settings,
Switch to Personal and Log out. Each row opens a destination of its own; none
is nested under Menu. The desktop slideover and the narrow Menu page render the
one model in `useOrganizationSettingsNavigation`.

The destinations are files under `O`, and their URLs are their files:

| Destination | URL |
| --- | --- |
| Website | `O/website` — Pages, Blog, Posts, Reviews and Q&A, Brand, Status, Domains, Languages, Currency, Search appearance, Website booking |
| Pages | `O/website/pages`, a page `O/website/pages/:pageId`, the Links page `O/website/pages/links` |
| Blog | `O/website/blog` |
| Reviews and Q&A | `O/website/qa` |
| Brand | `O/website/brand` and its leaves |
| Posts | `O/website/posts` — short posts to the site and its connected social accounts |
| Locations | `O/locations`, a location `O/locations/:locationSlug`, `O/locations/new` |
| Team | `O/team` |
| Integrations | `O/integrations` |
| Earnings | `O/earnings` |
| Payments | `O/payments` — the organization's own Stripe account, payouts and plan |
| Insights | `O/insights` |
| Notifications | `O/notifications` |
| Platform accounts | `O/platform-accounts` |

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

### Catalog

**Catalog opens on three entries — Menu, Experiences, Services — and All
items.** They are ways into the catalog, not groupings anyone creates, and
every organization has all three whatever its template. Each opens a view
suited to its task; every offering, from anywhere, opens the one Product
editor at `O/products/:productId`.

| Entry | URL | First working screen |
| --- | --- | --- |
| Menu | `O/products/menu?location_id=` | the chosen location's sections, in the order guests see them |
| A section | `O/products/menu/:collectionId?location_id=` | its items, in order |
| Experiences | `O/products/experiences` | every experience; location is an optional filter |
| Services | `O/products/services` | every service; location is an optional filter |
| All items | `O/products/all` | everything, of every kind, filtered by `?kind` |

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

Services and Experiences have no grouping step. A service's overview leads
with Assigned team member (the booking assignment concern: who guests' bookable
consultations are with — not case ownership, and changing it never reassigns
existing appointments), Consultation pricing, Bookings, Description, Page
content, Locations and Website visibility. A price row opens the price it
names: one variant's price directly, several variants' list rather than the
first of them.

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
  Insights, Notifications, Earnings, Platform accounts, Account settings and
  Past activity exit there. A named route is a specific exit: Payments to
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
| Member | availability and public profile |
| Organization | the shared site: brand, domains, languages, connections |
| User | personal preferences and security |

Themes own nothing. A theme renders what these hold; it adds no CMS route,
editor or writer, and it never grants or hides an authorization.

### Airbnb, mapped

| Airbnb | KrabiClaw |
| --- | --- |
| Listings holds homes, experiences and services | Catalog opens on Menu, Experiences and Services, plus All items; each is a view of the same Products |
| Homes and experiences have different editors | One Product editor at `O/products/:productId` for every kind: kind changes wording and rows, not the route or the editor |
| Listing editor rows preview their values and open one concern | Product, location, page, post and member records do the same |
| Pricing and availability link to the calendar; Earnings links to payouts | Catalog links to Calendar and member availability; Earnings links to the organization's Payments |
| — | Blog/Docs (an article canvas), short Posts and Website settings have no equivalent and use the same record → index → concern pattern |

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

**A leaf edits one concern.** One field, or one small set of controls that
answer a single question. If a screen needs more than about three controls, it
is not a leaf — it is an index, and its fields belong one level deeper.

This is the rule the CMS kept breaking. It is measured, not felt: count the
controls. Airbnb's own leaves, at 1440px, are

| Screen | The entire detail pane |
| --- | --- |
| Title | one input and a `44/50` counter |
| Listing description | one textarea and a `482/500` counter |
| House rules | four rows, each an ✕/✓ pair — no fields at all |
| Pricing | one value row, one toggle, one link |
| Hours by day | an index: one row per weekday previewing its hours; the day leaf is one switch and two time pickers |
| Schedule | an index: one row per day previewing its start times; the day leaf is a list of times |

**A pane that would need many fields becomes an index instead.** Airbnb's
Description screen is not a form with five textareas; it is five rows —
Listing description, Your property, Guest access, Interaction with guests,
Other details to note — each previewing its current value in two lines, each
opening its own leaf.

So when a form grows, the answer is never a smaller control or a tighter
column. It is another level.

**A compound control is one concern, and stays one.** A palette, a logo's
presentation, a media grid and a day's list of times each answer one question
with several inputs. Splitting them into levels to satisfy a count would
scatter one decision, so each renders inside one leaf and commits with its Save.
The article canvas, below, is the only other exception.

## Controls

**One header rule for every list screen.** The panel's navbar carries Back, the
title and what you can do to the list — Edit, Add, Manage — and the body
carries the list, its one-line description and its rows. `DashboardListEditor`
and `DashboardGridEditor` teleport their controls into the navbar of the index
panel they are mounted in (`dashboardPanelActionsKey`); a page never draws a
second header in the body, and never puts Add in one place on one screen and
another on the next. A list mounted outside an index panel keeps its controls
at the top of the list.

The inside of a leaf, measured against Airbnb's host tools (see
`docs/design/airbnb-parity-audit.md`). The theme in
`app.config.ts` and the two shells carry most of this; a page states the
control and nothing about its size, radius or width.

**A yes/no is never a checkbox.** A rule — something guests are held to — is a
✕/✓ pair, as Airbnb's house rules are. A setting is a switch (`SettingRow`). A one-of-N is a
set of cards: `URadioGroup variant="card"`, which the theme draws as Airbnb's
selectable cards, so it needs no wrapper of its own. A checkbox exists
only in a list's *Select* mode, which `DashboardListEditor` already draws.

**A box means "choose me" or "open me".** Rows are separated by a 1px
hairline with 24px of padding. A bordered card is a selectable choice or a
value that opens a leaf. It is never a container for a control: a checkbox in
a card, a switch in a card, a field in a card are each a row.

**One explanation per leaf, under the title.** `DashboardLeafPanel` takes a
single `lead` sentence and that is the only place a leaf explains itself. A
field never carries a sentence: no `description`, no `help`, no paragraph
above or below it. A row carries one line of sub-label. A counter
(`44/50 available`) sits above the field in `text-sm`. `hint` exists only for
`Optional`.

**Leaf width is fixed.** The shell's content column is `max-w-xl`, and a
field does not stretch to the pane. A leaf that needs more width is a grid
editor and says so. An index that is a column rather than a list — Menu,
Catalog, a booking's notes — is `DashboardIndexPanel column`: the same width,
its title heading the column as a leaf's does, its footer keeping the column's
edges. A page never narrows itself.

**Short text is bare.** A name, title, headline, slug or link renders as a
borderless 22–26px field with a counter, the way Airbnb's title and custom
link do. Long text is one bordered textarea.

**Sizes come from the theme.** Controls are `lg` — 16px text, 44px tall, 8px
radius — and the commit bar's Save is the one `xl` (48px). Body text is 16px
`text-highlighted`; sub-labels and counters are 14px `text-muted`. Focus is a
2px `text-highlighted` ring, not the brand colour; coral is for Save and the
lit tab. Switches are black, as Airbnb's are.

## Canvas

The only surface exempt from leaf size. Long-form article writing, and nothing
else.

**A canvas edits the artifact directly.** The writer types into the rendering
readers will see. There is no field list because there are no fields; the body
is the control.

**The exemption is from leaf size, and from nothing else.** A canvas is a level
of the chain like any other: it renders inside the shell, it computes its own
frame mode, and it re-roots. Full-bleed means the writing column fills its own
pane — never that the canvas replaces the application. A surface that escapes
the frame takes the tenant's rail, navbar and place in the chain with it, which
is what re-rooting exists to prevent.

The canvas carries no Cancel/Save bar, because you cannot cancel an hour of
writing. It leads its level the way a photograph leads a product: the article
first, then the rows that describe it.

**The exception covers the writing and nothing around it.** Category, tags,
excerpt, publishing time, visibility, slug, canonical URL and search appearance
describe the post rather than being it. They are fields, and they obey leaf
size: an index of rows, each previewing its value, each opening its own leaf.

**The test: is the control editing the artifact, or describing it?** Editing it
is a canvas. Describing it is a field, and fields decompose.

## Presentation

| Width | Chrome | Detail |
| --- | --- | --- |
| `< md` (768) | Bottom nav | Full-screen sheet: ✕ top-left, the title in the body, commit bar pinned at the base |
| `≥ md` | Top nav | — |
| `≥ lg` (1024) | Top nav | Pane beside the index |

`md` swaps navigation chrome. `lg` swaps index/detail topology. One component
owns both renderings of a node, and there is no separate mobile screen. The
topology itself is CSS; the single JavaScript breakpoint is
`useDashboardPane()`, and it decides only whether an index opens a child on
arrival — something CSS cannot express, because it is a navigation.

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
| `pair` | one of my children is open | my content as the index column, the child as the detail |
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

Destination roots stand alone and use the frame: Today, Calendar, Catalog,
Messages, Menu, and each Menu destination — Website, Locations, Team,
Integrations, Earnings, Payments, Insights, Notifications — as Airbnb's
`/hosting/listings` grid does. Within a destination, levels pair with their
parent: Pages, Blog, Reviews and Q&A, and Brand render as `Website | Pages`, and
a Catalog entry renders beside Catalog.

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

- **Keyed items use their ids.** An option is `options/:optionId`, a price
  `options/prices/:variantId`, a block `sections/:blockId`; never an index, a
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
belong to the sheet the leaf becomes below `lg`, where it covers the list it came
from and needs its own way back.

One shell owns that, so a leaf states what it commits and nothing about width.

### Where a level goes when it closes

Back, Close and Cancel are **links** to `useRouteLevel().to`, a push to the
level above. Nothing in the dashboard calls `router.back()`.

Measured on a live Airbnb host account (2026-09-21): their in-app Back went to
`/hosting/listings` while the previous history entry was the leaf that had just
been cancelled — Back, Cancel and Close all pushed. The destination is a
property of where you are, so a deep link, a reload, and a redirect after a save
all answer the same thing, and a sheet you just closed can never become the
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

Adding a record asks only for what names it, or what the contract will not
accept it without — nothing more. Everything else is a section of the record
once it exists and has an id to hang media, prices and translations on.

It is a level, not a sheet: `Add` navigates to `new` in the record's own slot,
which renders the record's own index with only the sections the contract needs. Its
commit names where it is going — `Start with Title`, then `Next: <section>`
while any remain, and `Create <record>` on the last one — so the tenant reads
what is left rather than a banner listing it. The commit creates the record and
navigates to its real id. `useCreateWalk` is the one implementation of that
walk; an editor supplies its sections, their order and what blocks each.

A create level is the record's own level, so it draws no second panel or
navbar of its own. The draft belongs to the record, not to the leaf: moving
between sections remounts the level, so it lives in `useState` keyed to the
record, never in a plain `reactive`.

## Committing

Cancel on the left, Save on the right, pinned to the base of the detail pane
(the sheet below `lg`). Cancel is a text button; Save is the only filled
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

**Move is a separate action from Reorder.** Move changes which parent a record
belongs to and takes a multi-selection. Reorder changes sequence within one
parent. Overloading one control with both is what forced single-item moves.

Airbnb has Move and no Reorder at all — room order is fixed by room type. Menu
sections must be orderable, so Reorder is a deliberate addition, not parity.

**Membership is a navigable row, not a field.** A Product's menu sections render
as rows and open the same Move flow used for bulk selection. The free-text box
they replaced silently forked a new grouping on a typo. Membership is plural:
one Product can sit in several sections, so the row states which ones rather
than implying a single parent.

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

**Read the Airbnb page before drawing anything.** Open the actual screen in the
owner's logged-in Chrome (`chrome.sh`), read its sections, headings, rows,
button labels and card shapes, and mirror that structure. "Inspired by" is not
parity. Earnings is Performance card → Upcoming → Paid → Reports; the account's
Payments is sections with *Manage payments* → *Your payments*; Payouts is *How
you get paid* rows + *Add payout method* + *Need help?*. When Airbnb has no
equivalent, say so in a comment and keep the screen to the smallest honest
thing — never invent a section to fill the space.

**One screen per concept, scoped, never copied.** A second audience gets a
`personal-scope` (or similar) prop on the existing component and a scope on the
existing data source — `TodayPage`, `CalendarPage`, `BookingDetails`,
`MessagesPage`, `AgendaFilters`, `PaymentDetails` all work this way. The buyer
booking and the tenant booking are the same `BookingDetails`; a purchase is the
same screen with no visit. If a new file under `pages/` contains markup for a
list or a record, that is the smell: the markup belongs in the component the
tenant already uses, and the page is a one-line mount.

**One control per job.** Filters are one `AgendaFilters` popover, wherever
filtering happens. Money words come from `paymentStateLabel`. The record screen
is one `BookingDetails`. Two implementations of a thing means one is wrong.

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
whatever the template: Catalog; Menu, Experiences, Services; a menu's
**sections** and its **items**; a **variant** is a purchasable version of one
offering, never a section. Collection is the model's name and never appears in
the menu workflow; blog categories classify articles and are not part of the
catalog. `ProductPresentation` names a kind of item for public pages; plurals
live there too, because appending `s` produces "dishs".
