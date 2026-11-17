# Dashboard CMS design

The dashboard CMS is built from a small set of named patterns. A new screen
picks one of them, and review can say "that is an index, indexes do X". When a
screen cannot be built from these patterns, change this guide and the shared
implementation together.

Airbnb's host tools are the reference. We aim for the same behaviour, not the
same pixels, and where Airbnb has no equivalent we say so.

## Two axes

Chain is how deep content nests. It is unbounded: an index may open another
index, and `Menu > Website > Pages > page > section > field` is fine.

Presentation is how one node renders. There are exactly two renderings, chosen
by viewport width, never by depth.

## Index and leaf

| Term | Meaning | Example |
| --- | --- | --- |
| **Root** | The scope switcher. Not editable content. | Organization, Personal |
| **Index** | Routes onward. Its rows are links, and each previews its current value. | Location, Menu, one dish |
| **Leaf** | Edits one concern and commits. | A dish's price, a post's body |

An index may contain another index. A leaf never links to a deeper editor; if
it needs to, it is an index. Nothing in the dashboard is a third kind.

A level owns something: a task, entity or set of settings the owner names,
orders, deletes or configures as one. A category that only groups links is not
a level. Navigation lists have no inert headings; every row is a destination or
an action.

Before adding a concern, name its data owner, its operation, the editor that
already edits it, its parent, its scope, its permission, and how its write is
read back. Add it beneath that owner or link to the existing editor. A new
Product kind adds rows to the one Product editor. A new theme adds no CMS
route or writer.

## The organization's workspace

`O` is `/dashboard/:orgSlug`. Every theme has the same five tabs, in this
order:

| Tab | URL | Holds |
| --- | --- | --- |
| Today | `O` | the day's agenda |
| Calendar | `O/calendar` | bookings and availability by day |
| Catalog | `O/products` | what the organization offers |
| Messages | `O/messages` | guest and internal member conversations |
| Menu | `O/menu` | a launcher |

Menu is a launcher, not a parent. It shows the Earnings and Insights cards,
then Website, Locations (Offices for legal services), Team, Connections, Plan
and billing (owners and admins), Platform accounts and Platform reports
(Better Auth admins in Blawby's own organization), Account settings, Switch to
Personal and Log out. The desktop slideover and the phone Menu page render the
one model in `useOrganizationSettingsNavigation`.

| Destination | URL |
| --- | --- |
| Website | `O/website`: Pages, Blog, Posts, Reviews, Q&A, Brand, Preferences, Inquiry form, Website booking |
| Preferences | `O/website/preferences`: Status, Languages, Domains, Currency |
| Pages | `O/website/pages`, a page `O/website/pages/:pageId` |
| Blog, Posts, Reviews, Q&A, Brand | `O/website/blog`, `/posts`, `/reviews`, `/qa`, `/brand` |
| Locations | `O/locations`, a location `O/locations/:locationSlug` |
| Team | `O/team` |
| Connections | `O/integrations` |
| Earnings | `O/earnings` |
| Payments | `O/payments`: the organization's Stripe account and payouts |
| Plan and billing | `O/billing`: the plan and its one change, services sold beside it, and Stripe's portal |
| Insights | `O/insights`: performance and reviews |
| Platform accounts | `O/platform-accounts` |

Notification settings live in Account settings at
`/dashboard/account/profile/notifications`, one row per category; they are not
a Messages filter. There is no generic Activity feed. Financial range labels
name the interval they read.

The shell belongs to Better Auth's active organization: the route's, otherwise
the session's. Account settings (`/dashboard/account/profile`) and Past
activity (`/dashboard/account/activity`) are one page each; opened from an
organization they keep its tabs and exit back to it. A lawyer connecting Google
Calendar is still in their firm. Personal (the buyer's Today, Calendar,
Messages and `/dashboard/account/menu`) is reached only by Switch to Personal.
Opening a page never changes the active organization.

### Group conversations

An internal group conversation owns its name and participants. Its details
sheet renames it, adds and removes people, and lets a participant leave,
through the team-conversation operation; the thread's capabilities decide which
actions show. The creator and participating owners and admins manage a group.
This never changes workspace membership. Direct, guest and stay conversations
cannot be edited this way. Removal and leaving end access to the transcript;
history is kept.

### Today and Upcoming

Today shows what needs the viewer today; Upcoming is the same list for the next
30 days. It is one list in time order, read from stored booking, task and
payment rows in one D1 round trip (`server/domain/today.ts`).

It contains the bookings the viewer hosts (owners and admins host all; a member
hosts the offerings they are named on), their jobs (for owners and admins,
also unassigned jobs), requests awaiting a decision, failed messages, changes
waiting on the business, added tasks, and for owners and admins the unfinished
setup after the day's cards. A job is the action on its booking's card that day
("Casey is cleaning"), otherwise its own card. There are three roles and no
cleaner or attorney role; assignment decides what a member sees.

Every card is `TodayItemCard`, centred, with a shadow and no border or badges,
in Airbnb's order: when ("3:00 PM", "Oct 26 – 29"); the home's or offering's
own picture, or a small round icon tile; one sentence with who and how many
("Eva's group of 4 checks in"); one line of where, with money for owners and
admins; the two-line action. The heading uses the business's word ("You have 2
reservations and 1 task"). Setup is not counted; with only setup left it reads
"Finish setting up to take bookings", and empty, "Nothing needs you today".
Desktop shows a centred grid of cards up to 380px wide; a phone, one column.

A card opens its conversation: the guest's for a booking, the team's for a job.
A job has a one-tap Done; a request or change has Review. Photos and notes are
messages. An added task has no conversation, and "Mark as done" closes it. A
setup card opens the editor that finishes it. A member with no seat in the
guest's conversation opens the booking. The header holds Today/Upcoming and a
round + for Add task and, for stays, Add stay. The personal Today shows the
buyer's agenda with `TodayAgendaCard`.

### Calendar

Calendar cards read the same agenda and open beneath their day. On desktop the
agenda sits beside the record; below the pane breakpoint the record is one
screen and Close returns to the same range and filters.

`CalendarGrid` has two views: Homes (homes as rows, nights as columns) and
Places (restaurant locations, experiences and consultations as rows, days as
columns). Both edit selected days in the night inspector. Nights take prices
and stay rules through the night operation; places take only open or block
through `PUT /api/dashboard/places/{kind}/{id}/dates`. A day closed by location
hours, or empty in an attorney's hours, says why and links to the hours.

Assigned members' cards show the guest's first name, party size, home,
location and check-in or checkout time. Stay access follows the home's member
or team assignment; lodging has no appointment-assignee filter.

Locations, offerings and homes use the shared Responsibility picker over Better
Auth memberships and Teams: one person, one Team, or explicitly Unassigned.
Booking an individual attorney or host records who was booked; changing
responsibility later never rewrites it.

## Verticals

Blawby serves restaurants (menus, dishes, table reservations), experiences
(classes and dated sessions), lodging (homes, stays, nights, turnovers) and
legal services (`service`). `service` means legal services only: offerings are
Practice Areas & Consultations, practitioners are Attorneys, counterparties are
Clients, and bookings are Legal Consultation Requests.

## Catalog

Catalog is Airbnb's Your listings. It navigates rather than edits: kind pills
(All, Menu, Experiences, Services, Places to stay, each shown only when the
business has one) over one grid of photo cards. A menu belongs to a location,
so the Menu appears as one card per location. Every other offering opens the
one Product editor at `O/products/:productId`. Catalog has no location filter.

Cards show real sections, price and locations, or No photo and No price set.
Online comes from the booking configuration; no location assignment does not
mean every location. Inactive and unpublished items keep their names and state.

| View | URL | First screen |
| --- | --- | --- |
| Catalog | `O/products?kind=` | one card per location's menu, then every other offering |
| Edit menu | `O/products/menu?location_id=` | that location's sections in guest order |
| A section | `O/products/menu/:collectionId?location_id=` | its items in order |

With one location the Menu opens on it. With several, a location must be chosen
before sections can be reordered or added; with none chosen, every location's
sections show side by side. Shared sections are their own list, edited with no
location chosen. Membership and order are always edited against the whole
organization catalog, so a location filter never turns a full replacement into
a replacement of the visible subset.

In the menu workflow a collection is a section: Add section, Edit menu (section
order), Edit section (item order). Remove from section, stop offering at a
location and delete the item are three different actions. Deleting a section
never deletes its items.

A service's overview leads with Assigned team member (who guests book with;
changing it never reassigns existing appointments), Consultation pricing,
Bookings, Description, Page content, Locations and Website visibility. Authored
optional facts show; missing ones are offered through Add detail, not empty
cards. A practice area with no booking configuration shows no consultation
concerns.

An offering at locations is priced at each location; an offering at none has
one price. Editing names the selected location and never picks another.
Website visibility is independent of consultation availability.

Discrete list views use `DashboardFilterPills`: one row of round pills under
the title, the chosen one solid, 32px from title and rows. A list carries no
explanatory sentence under its title.

## Tabs, parents and exits

Three separate questions:

- Ancestry (the panes beside a level, and its Back) is the nested route parent.
  A file's place in `pages/` is its URL; there are no
  `definePageMeta({ path })` overrides.
- The lit tab is declared by each destination root as `definePageMeta({ tab })`.
  The layout reads the matched root's `tab` only. A screen that declares none
  lights none.
- A root's exit is `meta.back`, on standalone destination roots only. `menu`
  exits to the shell's Menu; a named route is a specific exit (Payments exits
  to Earnings). The five tabs have no exit, and nested levels never declare one.

A booking opened from Today lights Today; the same booking under a calendar day
lights Calendar.

## Who owns what

| Owner | Holds |
| --- | --- |
| Product, its variants and prices | kind, pricing, booking, publication, locations, collections, its page |
| A page, article or post | its own content |
| Location | its place, hours and media; its tables are a `table` Product |
| Organization member | their public profile and their availability in that organization |
| Organization | brand, domains, languages, connections |
| User | account name, avatar, preferences and security |
| Guest messaging | automatic messages at `O/messages/automatic`; the outbox at `O/messages/scheduled` |

Themes own nothing. A theme renders what these hold and adds no route, editor,
writer or authorization.

Automatic messages use the message-template operations: Message edits name and
text; When it is sent edits trigger, timing and offerings in the business's
words. One editor serves every vertical; managers create, change and delete
them. Every confirmed stay also gets its home's check-in instructions from the
server, with no template. The outbox holds automatic delivery snapshots for
managers and each member's own Send later replies; managers can cancel pending
ones. In a conversation, + adds photos or Send later, and ⋯ holds Messaging
settings (Suggested replies and the outbox). A suggested reply is the
composer's placeholder until Use or Tab fills the field.

### One record, many entrances

An entrance is a link, not a parent. None forks the record's route, draft,
writer or data source.

| From | To |
| --- | --- |
| A location | the same lists scoped with `?location_id=` |
| A menu section | the Product at `O/products/:productId` |
| A Product | its page in Pages, its locations, member availability, Calendar |
| A page a Product owns | that Product, from the page editor's Offering row |
| Search, MCP `admin_edit_url`, notifications, the agenda | the record's editor, built only by `server/utils/dashboard-links.ts` |

`location_id` is a scope and `locale` an identity. Both live in the URL, are
validated before anything loads or writes, survive reload, and are never
guessed. A scope never becomes a global write.

### Products and their pages

A Product may own one page, bound by the page root's `product_id`. Every page
is edited in Pages; the Product's Page content row opens it there and the page
editor's Offering row leads back. A service with no page shows No page and
Create page; nothing infers a binding from a path or title.

Creating a service creates the Product, its default variant, its page at a free
`/services/<slug>` and the binding in one batch under an idempotency key. It
starts unpublished, with no price or booking. A bound page is public exactly
while its Product is published.

Page presentation (hero captures, image focus, story layouts, feature columns)
belongs to the blocks declared in `utils/tenant-page-blocks.ts` and rendered by
`TenantPageFieldControl` under Pages → page → section. A hero's product image
uses its own `featured` placement, separate from its background `media`. Crops
change presentation only and keep the original upload.

### Places to stay

A place to stay is a Product of kind `stay`. `stay.internal_name` is the
operator-only name used across the dashboard; Product `name` is the public
listing title used for translations and Airbnb. Each has its own leaf.

Stay settings own the home's one location (chosen at creation), check-in and
checkout times, capacity, minimum nights and its team. The price row is the
base nightly price. Property type, rooms, amenities from
`shared/stay-listing.ts` and cancellation policies are public and appear in its
`Accommodation` data. The arrival guide (check-in method, wifi, directions,
house manual, checkout) is private to managers and assigned members. Web, iPhone
and MCP edit the same facts.

A stay opens at `bookings/:bookingId`. A host-created stay records offline
payments and is not blocked by closed nights or minimum stays. A channel stay
is read-only. A published place to stay takes enquiries without online
payments; with them, guests pay in full on the pay page while a checkout hold
claims the nights (and closes them on connected channels). A lapsed hold
releases them. Today and Calendar open the same manual-stay form at
`O/bookings/stay/new`.

### Organizations

The tenant is Better Auth's organization and the dashboard calls it that.
Choosing, creating and deleting live in Account settings → Organizations.
Deleting is owner-only, checked by `organization.hasPermission` and done by
`organization.delete`.

## Leaf size

A leaf edits one concern. Control count does not decide depth: amenities need
a long searchable list, and that is still one decision.

| Screen | The whole detail pane |
| --- | --- |
| Title | one input and a `44/50` counter |
| Listing description | one textarea and a `482/500` counter |
| Amenities | a searchable selection list with filters |
| Pricing | one value row, one toggle, one link |
| Hours by day | an index of weekdays; the day leaf is one switch and two time pickers |
| Repeating start times | an index of weekly rules; the day leaf edits that weekday's times |

Independent concerns get their own rows. Airbnb's Description is five rows,
each previewing its value and opening its own leaf. Split a form when its
decisions can be edited independently, not to meet a count.

## Controls

The theme in `app.config.ts` and the two shells carry sizes, radii and widths;
pages state only the control.

**Headers.** The panel navbar carries Back, the title and list actions (Edit,
Add, Manage). `DashboardListEditor` and `DashboardGridEditor` teleport their
controls there via `dashboardPanelActionsKey`; a page never draws a second
header. A tab root opens on a large title with actions on the same row. A
pushed level centres a 16px semibold title between the round Back button and
its actions. A leaf sheet has ✕ and a small centred title. Pages supply
`title`, `lead` and `#right` only. Secondary text under a title is one line.

**The control follows the decision.** A setting is a switch (`SettingRow`); a
reported fact keeps unanswered separate from No. A one-of-N choice is
`URadioGroup variant="card"`. Checkboxes select several items or records in
Select mode. Filters narrow what is visible; selection changes membership.

**Borders mark choices and destinations.** Rows are separated by a 1px hairline
with 24px padding. A bordered card is a choice or a value that opens a leaf,
never a container for a control.

**Explain once.** `DashboardLeafPanel` takes one `lead`. Definitions sit beside
the choice they clarify. A counter sits above the field in `text-sm`. `hint` is
only for `Optional`.

**The index shows saved facts; the leaf owns the draft.** Saved-summary cards
in `EditorNavigationList` show the real image, price, membership and state. A
draft never relabels the index or preview before it is saved and read back.
Cancel discards the draft. A failed save keeps the submitted values and their
base version, shows the failure and re-reads the record without rebasing. A
write whose read-back failed is a failure. Save is enabled for a valid pending
change, including a retry. Required errors show after interaction or submit.
Immediate actions and read-only settings have no commit footer.

**Team.** The header carries Invite. Members and Pending invitations are compact
hairline rows: avatar, name, "(you)" and email on the left, the role once on
the right. Remove member asks for confirmation; Resend and Revoke sit in a
pending row's overflow. New invitations start as Member. Web and iOS read the
same Team response for labels and available controls.

**Icons.** Icons mark destinations and meaningful choices; a title, URL or
price gets none. `EditorNavigationList` renders a row's `icon` as a bare 24px
outline; a real picture or provider logo (`lead`) replaces it, never both.
Single choices with pictures use `URadioGroup` cards with `indicator="hidden"`
and a 32px icon. Icons come from the registry that owns the concept, never
inferred from a label or URL. Use Lucide first; custom drawings go in the
`krabi` collection in `build/icon-data/custom-icons.json` (24×24, 2px rounded
strokes, `currentColor`). Icons are hidden from assistive technology, and
selection never relies on colour alone.

**Gutter.** The panel gutter (`px-4 sm:px-6`, `dashboardGutterClass`) is the one
horizontal edge for Back, title, rows, fields and Cancel. Components inside a
panel add no padding, scroll container or column. A row whose highlight reaches
the edge pulls into the gutter (`-mx-4`). Commit footers are framed by the
panel.

**Cards.** Record sections and payment summaries use `UCard variant="record"`;
other content cards use `UCard variant="subtle"`. Empty states use `UEmpty`.
Dashboard-wide status (the live connection, a failed background refresh) is the
shell's one banner; a screen shows only its own failures.

**Widths.** Below `lg` a level is the whole screen or a drawer. A level alone
in the frame is one of three things:

- Scaling content (grid, table, calendar, chart) takes the frame: Today,
  Calendar, Catalog, Insights, Media, Transactions.
- A settings index pairs with its first row via `autoOpen`: Account settings,
  Connections, Plan and billing, Earnings.
- A list with nothing to open (Notifications, Past activity, Paid, Platform
  accounts) or a single-concern screen (Menu, a calendar day) is a column:
  `DashboardIndexPanel column` set to `reading`, `leaf` or `record`.

Widths live in `dashboardColumnWidths`; a page never states one.

**Text fields.** Names, dates and addresses may keep outlined fields. Prose
uses the textarea's `none` variant, sized only by `useTextareaAutosize`.

**Preview.** Product, Page, Post, Article and Links previews use
`DashboardContentPreview` and `useDashboardContentPreview`. An eye control opens
the real tenant page with its preview token; the URL holds mode and device, and
closing restores the same concern. Preview never renders the draft and never
publishes. Share uses only a real published URL. Prices, assignments, hours and
settings get no preview. A dish preview needs an explicit location where the
dish is offered, never the first candidate. The preview token needs
organization-wide content access.

**Languages.** Languages is an index with no page-wide Save; Add language is
separate from Publish, Disable and Delete. Translations are a mode on the
owning record. Saving a translation does not publish the language, and the
writer preserves fields the editor does not show.

**Public addresses are assigned.** No row edits a slug. Renaming a Product,
Page, Article, Post or Location keeps its address. New translations get their
source's address in the new language.

**Sizes come from the theme.** Controls are `lg` (16px text, 44px tall, 8px
radius); the commit bar's Save is `xl` (48px). Sub-labels and counters are 14px
`text-muted`. Focus is a 2px `text-highlighted` ring. Buttons are neutral: navy
in light, white in dark. Coral marks status and selection only (the lit tab,
today's date, unread dots). Switches are black.

## Canvas and composition

A canvas edits the artifact directly: the writer types into what readers will
see. It is exempt from leaf size and nothing else. It renders inside the shell
with `DashboardIndexPanel` and the route's `dashboardFrame`, and re-roots like
any level. It has no Cancel/Save footer; its title is in the canvas, and Save,
Preview and metadata stay in its header.

Category, tags, excerpt, publishing time, visibility and search appearance
describe the article, so they are rows opening their own leaves. A new article
shows required publishing facts, such as category, beside the writing. The test:
editing the artifact is canvas; describing it is a field.

A short Post is composed in one place: media first, then caption and
destinations, with the preview beside it on desktop. Headline, link button and
location sit in More options. Save draft is secondary to Publish. Each
destination keeps its own receipt; website publication never implies social
delivery. `PostEditorPage` and `usePostEditor` reuse the writer and publisher
MCP uses.

## Presentation

| Width | Chrome | Detail |
| --- | --- | --- |
| `< md` (768) | Bottom nav | Modal leaf drawer over its parent, commit bar at the base |
| `md` to `< lg` | Top nav | The same drawer |
| `≥ lg` (1024) | Top nav | Pane beside the index |

One component owns both renderings; there is no separate mobile screen.
`useDashboardPane()` is the shared breakpoint. Below `lg`, `DashboardLeafPanel`
uses `UDrawer` with a backdrop, modal focus and swipe dismissal. The drawer is
the only motion.

The two columns show the deepest two levels. Opening a child re-roots: the
index column becomes the screen you were on. Back moves up one level.

### A level is a file

A URL segment is a level, and a level is one file under `pages/`.

| Kind | What it is | Shell | Controls |
| --- | --- | --- | --- |
| **index** | lists rows linking to its children; renders `<NuxtPage />` | `DashboardIndexPanel` | Back → parent |
| **leaf** | edits one concern; no children | `DashboardLeafPanel` | Close → parent · Cancel → parent · Save |

To add a screen, put the file in its parent's directory and pick the shell.

`useRouteLevel()` is the one source of a level's depth, mode, parent and Back.
`route.matched` is the chain; a level finds itself via `matchedRouteKey`, read
once. Depth counts matched records, not URL segments.

| Mode | When | Renders |
| --- | --- | --- |
| `index` | nothing below is open | its content, full frame |
| `pair` | one child is open | the desktop index column; below `lg`, the drawer's backdrop, or hidden for a child index |
| `yield` | something deeper is open | only the route beneath it, hidden but still mounted |

Only the two shells read `mode`. Pages carry no breakpoint classes.

### Pairing and auto-selection

On desktop every non-root level renders beside its parent. Destination roots
stand alone. Within a destination, levels pair with their parent:
`Website | Pages`.

| The index's children | `autoOpen` | Examples |
| --- | --- | --- |
| fixed leaves or settings sections | its first child | page editor, product, Brand, Website, Connections, Account settings |
| arbitrary records | none | Catalog, Pages, Blog, Posts, Locations, menu sections, Team |

`autoOpen` navigates with `replace`, fires only on arrival at the bare index,
and does nothing below the pane width.

### What the URL holds

A URL names a record, concern, keyed item, tab or mode, and a reload rebuilds
it. Temporary state (a picker, popover, confirmation) is not in it.

- Keyed items use ids: `price/amounts/:variantId`, `sections/:blockId`.
- Views keep their query: `?collection=`, `?tab=`, `?kind=`.
- Data is awaited with `await useAsyncData`, so the old screen stays until the
  next can render. No skeleton for first paint.
- A mode is a query on its record's URL: translations are
  `?editMode=translations&locale=<locale>`, opened by
  `DashboardResourceLocalization`.

### Closing and Back

Beside its index a leaf draws only Save; Close and Cancel belong to the drawer
below `lg`. Close, Cancel, backdrop, Escape and swipe discard unsaved edits and
return to the parent: `router.back()` if the user came from there, otherwise
navigation to the parent with `{ replace: true }`.

The nested route tree is the only parent graph. When the same levels need a
second parent, the `pages:extend` hook in `nuxt.config.ts` mounts the same
files again: `build/booking-routes.ts` mounts bookings under calendar days and
Today, and `build/form-question-routes.ts` mounts a form's Questions under a
product's Booking and a home, with `formQuestions` meta naming the record.
Nothing else is mounted twice.

## Creating

Creation presents the whole task. `Add` opens `new` in the record's own slot. A
Post opens its composer, an Article its canvas, and a dish asks for photo,
name, description and amount on one screen. Context supplied by the entrance
(kind, section, location) is not asked again. Practice areas need no photos.
An empty lodging Catalog offers manual creation and Airbnb import side by side.

Optional facts do not block a draft; publishing names what is missing. A task
that truly needs steps uses `useCreateWalk`. Opening never persists an empty
record: the draft lives in `useState` with its idempotency key until Save draft,
Create or Publish. A retry after failure creates nothing new and keeps the
author's input.

## Committing

Cancel on the left as a text button, Save on the right as the only filled
control, pinned to the base of the pane or drawer. Save is disabled until there
is something to save.

## Editing states

`DashboardListEditor` has three states. Browse: each row is a link to the
record's URL. Edit: the same rows with controls, and nothing navigates. Select
(`selectable`): checkboxes, with the count and actions in the header.

`DashboardGridEditor` handles media. `DashboardListItemDialog` is one leaf: a
sheet on mobile, a dialog above. Leaf size still applies to sheets and
slideovers.

## Ordering and membership

Reorder is a mode. Rearranging stays local and commits one complete order when
the mode closes; order endpoints reject a partial order.

Move is separate from Reorder: it transfers membership from an explicit source
to an explicit destination, through `CollectionMoveDialog`. It is one operation
carrying both sections' expected orders and appends moved items in source
order. A stale snapshot changes nothing and offers Use current items. Moving a
dish between sections does not change where it is offered or whether it is
published.

## Domain rules in the editor

A control must not be able to build an invalid state. A price belongs to a
variant, so the editor asks for a price per variant.

Classes, consultations and reservations share the one 24-hour cancellation
rule in `shared/availability-settings.ts`; stays keep their own policies.

Experience availability lives in Calendar, using saved sessions. Add
availability opens the occurrence editor; Repeating times opens the location's
weekly rules, which have no end date. Physical start times need an explicit
active location and its timezone. Online sessions use the host's working hours;
`online` is a booking scope, never a Location.

## Records

Booking and stay summaries follow Airbnb's host web detail. The record shell
has a 64px header with a centred 16px status title and ✕ on the right; the
record column is at most 504px wide and centred.

A record leads with a 320px square of the resource's own photo, guest avatars
overlapping its lower edge. An absent photo stays absent; organization artwork
never stands in. A group's primary avatar is 84px on mobile and 112px on
desktop, beside a raised circle with the remaining guest count; a single guest
is 108/144px. Use the Better Auth portrait, otherwise the first initial; never
invent portraits. The 32px title is the first name, or "Ana's group of 2", then
dates, nights and the resource name.

Arrival facts come first, then private team notes (the ledger composer inline),
guests and cancellation, total, payment and booking metadata. A stay's request
text is Guest requests, which guests can read. Missing facts never become
invented rows.

Message and Call are 56px neutral floating pills centred 40px above the pane's
bottom. The label is Message, with an accessible name naming the guest.

List rows without an image show a muted icon in the same footprint.

## Errors and empty states

A route or record that does not exist for this organization 404s, raised by
the level that cannot render it with `showError`, never a bare `throw` in
setup. Never redirect or render a fallback. A guard that must re-run on route
change goes in a `watchEffect`.

A missing record 404s; a failed request is a state the screen shows, because
the record may still exist. `isNotFoundError` in `utils/errors.ts` tells them
apart. Never show a blank editor whose Save would write unchanged data back.

A section with no items or a location with no sections shows its own empty
state.

## Building to Airbnb parity

Read the Airbnb page before drawing anything: open the real screen in the
owner's logged-in browser and mirror its sections, headings, rows, labels and
card shapes. Earnings is Performance, Upcoming, Paid, Reports. Payouts is How
you get paid, Add payout method and Need help?. When Airbnb has no equivalent,
say so in a comment and build the smallest honest screen.

One screen per concept. A second audience gets a `personal-scope` prop on the
existing component and a scope on its data source: `TodayPage`, `CalendarPage`,
`BookingDetails`, `MessagesPage`, `AgendaFilters` and `PaymentDetails` work this
way. A buyer's and a tenant's booking are the same `BookingDetails`. A page file
with list or record markup should be a one-line mount instead.

Personal Payments (`/dashboard/account/profile/payments`) opens payment and
refund history directly. A member's profile saves separately from their
availability; unknown Hours say Not set.

Use customer words: "Paid", "Refunded", "On its way", "Get receipt", "Send a
refund", "Who's coming". Never "captured", "fulfillment", a Stripe id or a UTC
qualifier. Money words come from `paymentStateLabel`. Provider status is
re-read on load, not behind a button. Pictures come from real data, never a
placeholder face.

## Where we differ from Airbnb

- Plan and billing: what the organization pays Blawby. Owners change it,
  admins read it, members do not see it.
- Platform accounts: every account and impersonation, for Better Auth admins
  only, enforced by Better Auth's admin plugin.
- One editor for every Product kind.
- Blog articles on a canvas, and short Posts to the website and social
  accounts.

## Naming

Use the owner's words, not the schema's: Catalog; Menu, Experiences, Places to
stay, Practice areas & consultations; a menu's sections and items. A variant is
a purchasable version of one offering, never a section. Collection never
appears in the menu workflow. `ProductPresentation` names item kinds and their
plurals for public pages.

## Moving from Hostaway

The one-time migration lives at `O/integrations/hostaway-migration`, reached
from Connections. The host uploads a reservation export, confirms columns and
home matches, reviews manual blocked dates and approves stays. Its Upload,
Columns, Homes, Review and Verification leaves use the creation walk. There is
no ongoing Hostaway connection.

Re-uploading matches reservation ids against saved stays and never duplicates.
The importer invents no payment, sends no confirmation and collects nothing.
Verification compares saved occupancy with connected Airbnb availability, names
every mismatch, and keeps the handover open until they pass. The host pauses and
reopens listings on Airbnb; the wizard does not.
