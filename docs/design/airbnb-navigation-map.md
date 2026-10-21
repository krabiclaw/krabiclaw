# Airbnb host navigation map

**Status: Reference — captured 2026-10-06.** A map of how Airbnb's host side
is navigated: every page, its URL, and whether each control opens a page, an
inline editor, a popover, a modal or a sheet. It is evidence for #1287. It
records what Airbnb does and does not recommend anything for KrabiClaw.

Evidence: the owner's logged-in host account, driven in Google Chrome on
2026-10-06 at 1440px and 1009px wide (desktop) and 520px wide (narrow). The
account has one unlisted home, one in-progress experience and no
reservations. One home draft was created and walked to the Publish step, and
was not published. IDs are written as placeholders: `<listingId>`,
`<draftId>`, `<experienceId>`, `<threadId>`, `<userId>`.

Vocabulary used below:

- **Page**: the URL changes and the browser history gets an entry.
- **Pane**: the right-hand column of a two-column page; it has its own URL.
- **Inline**: a row expands into an editor in place; the URL does not change.
- **Popover**: a small dialog anchored to the button that opened it
  (≈200–400px).
- **Modal**: a centered dialog (≈376–960px wide) over the page.
- **Side panel**: a full-height dialog docked to the right edge.
- **Sheet**: at narrow width, a dialog docked to the bottom or filling the
  screen.

## 1. Global host frame

### Primary navigation

| Label | Desktop | Narrow (≤ ~520px) |
| --- | --- | --- |
| Logo | `/hosting` | — |
| Today | `/hosting` | bottom tab `/hosting` |
| Calendar | `/calendar-router` → `/multicalendar` | bottom tab |
| Listings | `/hosting/listings` | bottom tab |
| Messages | `/hosting/messages` (unread count in the accessible label) | bottom tab |
| Menu | hamburger button → side panel (below) | bottom tab → **page** `/hosting/menu` |
| Switch to traveling | `/` | inside Menu |
| Profile (avatar) | `/users/profile/about?context=host` | inside Menu |

### Menu

At desktop width the Menu is a **side panel** (role `menu`, ≈410px, full
height, right edge). At narrow width the same content is the **page**
`/hosting/menu`, with a Terms/Privacy footer added. The list is flat: there
are no group headings. Every row is either a link or a button that opens
something.

| Row | Type | Destination |
| --- | --- | --- |
| Earnings card ("October 2026 · $0 this month") | link | `/users/transaction_history` → `/earnings` |
| Insights card (rating, reviews, listing count) | link | `/hosting/insights?entry_source=nav` → `/performance/quality/overall` |
| Create a new listing card | button | modal "What would you like to host?" (§4) |
| Account settings | link | `/account-settings?context=host` |
| Languages & currency | button | modal (929×825) with tabs *Language and region* / *Currency* |
| Hosting resources | button | **replaces the panel body in place**, with Back: Resource Center `/resources/hosting-homes`, Community Center `/community`, Host Clubs `hostcommunity.airbnb.com` |
| Get help | button | in-panel subview: Help Center `/help/hosting` (→ `/help`), safety `/help/contact-us?entry=MENU_TAB_SAFETY&role=host`, Report neighborhood concern `/neighbors`, Give us feedback `/help/feedback` |
| Find a co-host | link | `/co-hosts/home` → `/co-hosts/find-a-cohost` |
| Create a new listing (second entry) | button | same modal |
| Refer a host | link | `/refer` |
| Switch to traveling | link | `/` |
| Log out | link | `/logout` |
| Bell "N unread notifications" (panel header) | button | in-panel subview "Notifications" with Back |

### Today

`/hosting`. The tabs *Today* and *Upcoming* are buttons that **change the
URL**: `/hosting` and `/hosting?tab=upcoming`. When nothing is booked, the
page shows an empty state and a status banner ("Your place won't appear in
search results… Relist") linking to `/hosting/listings`.

## 2. Listings

`/hosting/listings` shows a grid of listing cards. Homes and experiences
appear together.

| Control | Type | Result |
| --- | --- | --- |
| All / Homes / Experiences | filter buttons | filters in place, **URL unchanged** |
| Change to List view / grid view | button | table with columns Listing · Type · Location · Status; URL unchanged |
| Add listing | button | the same "What would you like to host?" modal as the Menu |
| Unlisted or listed **home** card | button | page `/hosting/listings/editor/<listingId>/details/photo-tour` |
| **In-progress** home card | button | small modal "Manage in-progress listing" (376px): Edit listing / Remove listing |
| **In-progress** experience card | button | small modal with the same shape: Edit listing → `/setup/experiences/<experienceId>/description`; Remove listing |

## 3. Home listing editor

Base: `/hosting/listings/editor/<listingId>`. The host top nav stays visible.

### Layout and deep linking

- **Desktop (1440).** On the left is the index column "Listing editor" (Back,
  tabs *Your space* | *Arrival guide*, status banner, Preferences gear, View).
  On the right is the selected section's pane. Each index row is an `<a href>`
  card showing the **current value**, for example "Pricing — $250 per night"
  or "Availability — 120–1125 night stays · At least 7 days advance notice".
- Opening the editor root or clicking a listing **auto-opens** the first
  section, `details/photo-tour`.
- When a section has a deeper leaf, the listing index hides, a Back button
  appears, and the **section index and the leaf** sit side by side. Only the
  deepest two levels are ever visible.
- Every section and leaf has its own URL and its own `<title>` ("Title -
  Listing editor - Airbnb").
- **Narrow (520).** The root goes to `.../details` and shows only the index,
  with no auto-open. Opening a section or leaf shows it as a **full-height
  sheet** (Close, with Cancel/Save in the footer).

### Your space tab — `details/<section>`

| Index row (shows value) | URL | Pane content | Deeper navigation |
| --- | --- | --- | --- |
| Photo tour | `details/photo-tour` | All photos link, room cards, Additional photos, "Add photos, room, or space", "View your tasks" | `photo-tour/photos` (full-width grid with a "Lead with your best photos" modal on entry, per-photo "Photo options"); `photo-tour/<roomId>`; `photo-tour/additional-photos` (a 331px room list plus that room's photos). "Add photos, room, or space" → popover (Add photos / Add a room or space). "View your tasks" → modal "Photo tour tasks" |
| Title | `details/title` | Title (English, 50 chars) + Internal name (40 chars, "just for you"), Help, Save | Help → popover with a tip and "Get tips" |
| Property type | `details/property-type` | property group/type selects, listing type, floors, floor number, year built, size + unit, Save | — |
| Sleeping arrangements | `details/sleeping-arrangements` | one row per room ("Bedroom · 1 queen bed") | room row → **inline** bed-type steppers |
| Pricing | `details/pricing` | rows Per night, Weekend adjustment; Smart Pricing switch; link "Find more discounts and fees in the calendar" → `/multicalendar/<listingId>` | `pricing/rates/base` (price, "You earn" expander, View similar listings, Cancel/Save); `pricing/rates/weekend` (% input + slider) |
| Discounts | `details/discounts` | rows Weekly 20%, Monthly 50%; calendar link | `discounts/weekly`, `discounts/monthly` (%, slider, "You earn", suggested %) |
| Booking settings | `details/instant-book` | radio cards: Instant Book / Instant Book for guests with a good track record / Review all booking requests; Save | "Add a custom message" → **inline** pre-booking message (400 chars) |
| Availability | `details/availability` | rows Minimum nights, Maximum nights, Advance notice; link → `/multicalendar/<listingId>/availability-settings` | `availability/minimum-stay` (with link "Customize by check-in day" → `availability/minimum-stay/custom`, which opens a **modal** "Customize by day" over the leaf, with the URL changed); `availability/maximum-stay` (+ "Allow requests for longer stays" switch); Advance notice → **inline** radio list + Save |
| Number of guests | `details/number-of-guests` | a single stepper | — |
| Description | `details/description` | rows Listing description / Your property / Guest access / Interaction with guests / Other details to note | each row → **inline** textarea with a character counter; "Help with descriptions" → popover |
| Amenities | `details/amenities` | the amenities added so far; Edit | Edit → **inline** remove mode; "Add amenity" → `amenities/add` (search, category pills, Add/Remove per amenity) |
| Accessibility features | `details/accessibility` | one "Add <feature>" row per feature | `accessibility/<FEATURE_KEY>`, e.g. `DISABLED_PARKING_SPOT`, `HOME_STEP_FREE_ACCESS` (definition, example photos, "I don't have / I have this feature", Cancel/Save) |
| Location | `details/location` | map + Adjust; rows Address / Location sharing / Location features / Neighborhood description / Getting around / Scenic views | Adjust, Address, Location features, Neighborhood description, Getting around, Scenic views → **inline**; Location sharing → popover |
| About the host | `details/host` | the user's **profile editor**, embedded | each field → the same modal as `/users/profile/about?editMode=true` (§9) |
| Co-hosts | `details/co-hosts` | two option cards | "Invite someone you know" → modal "Invite a Co-Host"; "Find someone to help" → co-host marketplace |
| House rules | `details/house-rules` | Off/On pairs (pets, events, smoking, quiet hours, commercial photography), guest stepper, Save | Check-in and checkout times → `house-rules?feature=checkInOut`; Additional rules → `house-rules?feature=additionalRules` (**query-parameter deep links**) |
| Guest safety | `details/guest-safety` | rows Safety considerations / Safety devices / Property info, each showing current values | each row → **inline** Off/On pairs with Learn more + Add details |
| Cancellation policy | `details/cancellation-policy` | rows Short-term stays / Long-term stays / Additional policy options | `cancellation-policy/standard`, `/long-term`, `/additional` (radio cards, Save/Cancel) |
| Custom link | `details/custom-link` | editable `airbnb.com/h/<slug>`, Copy link | — |

The status banner ("Unlisted …") is a button that opens the modal "Edit
listing status" ("Ready to host again?" List your place / Cancel).
**View** → `view-your-space`, a full-screen preview with *Desktop view* /
*Mobile view* tabs.

### Arrival guide tab — `arrival/<section>`

Same two-column layout. Index rows show current values.

| Row | URL | Content / deeper navigation |
| --- | --- | --- |
| Check-in & checkout | `arrival/check-in-out` | check-in window start/end, checkout time, Save |
| Directions | `arrival/directions` | textarea; "Shared once a booking is confirmed" |
| Check-in method | `arrival/check-in-method` | current method (Keypad), "Connect your lock". Edit → `check-in-method/KEYPAD` (method cards: Smart lock, Keypad, Lockbox, Building staff, In-person greeting, Other; plus a details textarea). Add instructions → `check-in-method/add-instructions` (textarea + photo) |
| Wifi details | `arrival/wifi-details` | network + password; "Shared 24–48 hours before check-in" |
| House manual | `arrival/house-manual` | textarea |
| House rules | `arrival/house-rules` | **the same editor and data as `details/house-rules`** |
| Checkout instructions | `arrival/checkout-instructions` | Add instructions → `?feature=chooseInstruction` (Gather used towels, Throw trash away, Turn things off, Lock up, Return keys, Additional requests) |
| Guidebooks | `arrival/guidebooks` | create guidebook |
| Interaction preferences | `arrival/interaction-preferences` | radio cards |

**View** → `view-arrival-guide`, a full-screen preview with Desktop/Mobile
tabs.

### Preferences — `preferences/<section>`

The gear link `.../preferences` redirects to `preferences/status`. This is a
second two-column index.

| Row | URL | Content |
| --- | --- | --- |
| Listing status | `preferences/status` | radio cards Listed / Unlisted |
| Languages | `preferences/languages` | English (Default); Add a language → `preferences/languages/add` |
| Guest requirements | `preferences/guest-requirements` | "Require a profile photo" switch |
| Local laws | `preferences/local-laws` | article |
| Taxes | `preferences/taxes` | taxes Airbnb submits; Add a tax |
| Airbnb.org stays | `preferences/airbnb-org-stays` | discount %, FAQ accordions |
| Remove listing | button | destructive; not opened |

## 4. Creating a listing

Entry: Menu → Create a new listing, or Listings → Add listing. Both open a
**modal** "What would you like to host?" with radio cards Home / Experience /
Service and a Next button.

### Home — `/become-a-host`

1. `/become-a-host`: "Welcome back", Start a new listing / Exit.
2. `/become-a-host/address`: page with an address search field. Typing opens
   a suggestions list (plus "Use my current location" and "Enter address
   manually"). Picking a suggestion opens the **modal** "Confirm your
   address" (country, street, apt, city, state, ZIP; Back/Next).
3. Next **creates the draft**. From here every step is
   `/become-a-host/<draftId>/<step>`. The header has "Questions?" (a **side
   panel** of tips for that step) and "Save & exit". The footer shows
   "step N out of 14" with Back / Next. Opening a later step's URL redirects
   to the furthest step completed so far.

| # | Step URL | Screen |
| --- | --- | --- |
| 1 | `about-your-place` | intro "Step 1 · Tell us about your place" |
| 2 | `structure` | grid of 30 property types |
| 3 | `privacy-type` | An entire place / A room / A shared room in a hostel |
| 4 | `location` | **two screens on one URL**: "Is the pin in the right spot?" (map), then "Choose how guests see your location" (precise-location switch) |
| 5 | `floor-plan` | steppers for guests, bedrooms, beds, bathrooms |
| 6 | `stand-out` | intro "Step 2 · Make your place stand out" |
| 7 | `amenities` | checkbox tiles grouped Basics / Popular / Features / Location / Safety |
| 8 | `photos` | "Add photos" → **modal** "Upload photos" (drag/drop, Browse, per-file Remove, Upload). After upload, the same URL shows the arranged grid, cover photo, Add more, and a per-photo popover menu (Edit / Move forward / Delete). Requires 5 photos |
| 9 | `title` | textarea, 50 chars |
| 10 | `description` | **two screens on one URL**: pick up to 2 highlights, then a description textarea (500 chars) prefilled from them |
| 11 | `finish-setup` | intro "Step 3 · Finish up and publish" |
| 12 | `pricing` | rows Base price and Weekend adjustment. Base price → **modal** (price, "You earn" breakdown: guest price / host service fee / you earn). Inside it, "View similar listings" opens a **second modal stacked on top**, "Compare similar listings" (map + list) |
| 13 | `discount` | New listing promotion, Last-minute, Weekly, Monthly (each % + checkbox); "Only one discount will be applied per stay" |
| 14 | `legal` | safety disclosures (exterior camera, noise monitor, weapons) and links |
| — | `receipt` | "Yay! It's time to publish." preview card, "Show preview" (modal "Full preview"), What's next, Back / **Publish** (not clicked) |

### Experience — `/setup/experiences/<experienceId>/<step>`

- **Header:** Back, "Save and exit" (→ `/hosting/listings`), and a sidebar
  switch (Open/Close).
- **Sidebar:** opens a left list of 7 sections, each showing its current
  value: About you · Location · Photos · Itinerary · Pricing · Details ·
  Experience.
- **Section view:** choosing a section narrows the sidebar to that section
  ("Step N of 7") and its steps.
- **Footer:** Next.

| Section | Step URLs (in order) | Notes |
| --- | --- | --- |
| About you | `host-experience` → `host-qualifications` → `online-profiles` → `business-type` | qualifications rows Intro / Qualifications / Recognition each open a **modal** (textarea with counter, Get tips, Save); Get tips → modal with an inspiration carousel |
| Location | `location` (confirm address form) → `location` (pin map) | two screens on one URL |
| Photos | `photos` | grid, Add more, Get tips; minimum 5 |
| Itinerary | `agenda` (intro) → `agenda` ("Your itinerary", up to 10) | activity row → small **modal** (Edit / Remove). Edit and Add activity → large **modal wizard**: Title (35) → Describe (min 30) → Duration → Choose a photo. Reorder |
| Pricing / Details | `guest-count` → `price` (per guest) → `price` (private group minimum, Skip) → `price` (review) → `whats-included` → `discounts` → `legal-questions` | `legal-questions`: Yes/No questions + "Requirements and terms" → **I agree** (accepts terms and authorizes quality checks). The last section is locked until it is accepted |
| Experience | `description` → `review` | intro → AI generation ("Creating titles and descriptions…") → "Choose one and make it your own" (three generated title + description cards, with Edit → modal). Next → `review` "Publish your listing": a summary row per section linking back to its step, "Enter an invite code", **Request to publish** (not clicked) |

### Service — `/setup/services/create`, then `/setup/services/<serviceId>/<step>`

The first screens share one URL, `/setup/services/create`:

1. "Which service will you provide?" (Catering, Chef, Hair styling, Makeup,
   Massage, Personal training, Photography, Prepared meals, Spa treatments).
2. "Where will you offer your service?". "Enter a city" opens a **modal**
   with a city search and a suggestions list.
3. "Create your listing" (the category and city chosen), then Get started.

Get started creates the draft. From there the service uses the **same step
editor shell as experiences**: the sidebar switch, sections that show their
current values, "Step N of 6", Save and exit, Back and Next. There are 6
sections: About you · Location · Photos · Offerings · Details · Service.

| Section | Step URLs (in order) | Notes |
| --- | --- | --- |
| About you | `host-experience` (years) → `host-qualifications` → `online-profiles` → `business-type` | qualification rows Experience / Degree / Career highlight each open a **modal** (textarea with counter, Cancel/Save). Add profile → modal "Add link". `online-profiles` can be skipped |
| Location | `location` | "Where do you provide your service? Choose one or both": *You travel to guests* → **modal** "Set your service area" (starting address search, map, drive time; the drive-time button opens a **second, stacked modal** with 30 min / 1 hour / 1.5 hours / 2 hours). *Guests come to you* → **modal** "Where should guests meet you?" (address search) |
| Photos | `photos` | Add → modal "Upload photos"; minimum 5 |
| Offerings | `offerings` (intro with examples like "Deep stretching · $49 total") → `offerings` ("Your offerings", add at least one) → `availability` → `discounts` | see below |
| Details | `legal-questions` | Yes/No questions, then "Requirements and terms" with an **I agree** that accepts the services terms and authorizes quality checks. The final section stays locked until it is accepted |
| Service | `description` → `review` | "Add a service title and description" → Next generates three AI-written title + description options ("Choose one and make it your own"; a carousel of radio cards). Edit → **modal** "Edit title and description" (title 50 chars, description 200 chars, Get tips, Save). Next → `review` "Publish your listing": a summary row per section (About you, Location, Photos, Offerings, Details, Service), each linking back to that section's step URL, "Enter an invite code" (partner organizations), and **Request to publish** (not clicked). The listing is published a week after approval |

**Offerings** are the bookable, priced items under a service. "Add your
first offering" and "Add another offering" open a modal flow:

1. "Add a photo and title" (32 chars). "Choose a photo" opens a **stacked
   modal** to pick one of the service's photos.
2. Next opens "Add details", a modal that is itself a **small index**: each
   row shows its value and opens a **stacked modal** for one concern.
   - Description (500 chars)
   - Type of service (e.g. Yoga, Strength training, Pilates…)
   - Price (amount)
   - Per guest / Fixed price (a pricing-option picker; choosing Per guest
     adds a *Minimum price per booking* row)
   - Number of guests (stepper, up to 100)
   - Duration (hours + minutes selects)

   It ends with Remove and Done.
3. Saved offerings appear as rows ("Draft test session · $50 / guest").

`availability` ("Set your business hours") applies to all offerings, and
each offering can get custom hours later. Its rows ("Monday – Friday · 9:00
AM – 5:00 PM") and "Add more hours" open a **modal** "Business hours" with a
day picker (Sunday–Saturday) and From/To selects. `discounts` has
Limited-time, Early bird, Large group discounts and Add discount.

## 5. Calendar

- `/calendar-router` redirects to `/multicalendar`. This is a grid with one
  row per listing and one column per day. It has a listing search, a month
  select, Today, Layers, and previous/next week. On the right is a rule-set
  sidebar ("Set your seasonal rates and availability", Create your first
  rule-set, Close).
- **Layers** opens a popover (300px) with the toggles *Price* and
  *Rule-sets*, which choose what the grid cells display. The URL does not
  change.
- **Create your first rule-set** opens a large modal (960px) titled "Create a
  new rule-set", with a three-step explainer. It contains:
  - a required name and a color radio group (8 colors);
  - a *Pricing* group of accordion rows: Nightly price, Length-of-stay
    discounts, Last-minute discounts, Early-bird discounts. Each row expands
    inline. There is a note that rules don't apply while Smart Pricing is on;
  - an *Availability* group: Trip length, Check-in and checkout days;
  - Cancel / Save.

  The dates and listings a rule-set applies to are chosen afterwards, on the
  calendar grid.
- The single-listing calendar `/multicalendar/<listingId>` and
  `/multicalendar/<listingId>/availability-settings` are reached from the
  listing editor's Pricing, Discounts and Availability sections.
- KrabiClaw's Calendar and Messages already work as the owner wants. This
  section and §6 are reference only, not a target for #1287.

## 6. Messages

- **Desktop:** `/hosting/messages` **auto-opens** the newest thread at
  `/hosting/messages/<threadId>`. There are three columns: thread list,
  conversation, and a reservation details panel (check-in/checkout,
  reservation details, guests, cancellation policy, house rules, payment,
  support).
- **Narrow:** `/hosting/messages` shows only the thread list. There is no
  auto-open, and the inbox-type filter becomes a row of chips.

| Control | Type | Result |
| --- | --- | --- |
| "All" inbox filter | popover menu "Inbox type" | All · Homes · Experiences · Traveling · Support · Direct messages (with counts) |
| Unread | chip | filter |
| Search | button | swaps the list header for a search field with Cancel; URL unchanged |
| Messaging Settings | modal | Manage quick replies (→ modal "Quick replies templates": Hosting / Experiences) · Suggested replies · Past conversations · Give feedback |
| Past conversations | list mode | `/hosting/messages/<threadId>?archived=`, with a "Past conversations" header and Back |
| Show reservation | modal | "Your reservation details" |
| Conversation details, Reactions, More actions | buttons | per-thread actions |

The host inbox includes traveling threads. Inbox type separates them.

## 7. Insights — `/performance/...`

- Reached from the Menu's Insights card. It has a collapsible left subnav.
- **Group headings are links to their first child.** No heading in the
  subnav is unclickable.

| Group (link) | Children |
| --- | --- |
| Quality → `/performance/quality/overall` | Overall quality, Accuracy `quality/accuracy`, Check-in `quality/checkin`, Cleanliness, Communication, Location, Value |
| Occupancy & rates → `/performance/occupancy/occupancy_rate` | Occupancy rate, Cancellation rate, Length of stay, Nightly rate |
| Conversion → `/performance/conversion/conversion_rate` | Booking conversion, Booking lead time `booking_window`, Returning guests `return_guest`, Views `p3_impressions`, Wishlist additions `wishlist` |
| Superhost → `/performance/superhost` | (leaf: criteria and benefits) |

Each metric page has filter chips (listings, date range, rooms and beds,
regions, amenities). Each chip opens a **popover** with Clear/Apply. There is
also a Compare select, and "Give feedback" opens a **modal**.

## 8. Earnings — `/earnings`

Reached from the Menu's Earnings card (`/users/transaction_history` redirects
here). It has a collapsible left subnav.

| Item | Type | Destination |
| --- | --- | --- |
| Performance | page | `/earnings` (monthly/yearly toggle, View as table → large modal, Filter → popover "Filter by listing" covering homes **and** experiences, Paid breakdown → **inline** expansion) |
| Upcoming | page | `/earnings/<userId>/upcoming` |
| Paid | page | `/earnings/<userId>/paid` (filters, Show details rows, Export CSV) |
| Reports | page | `/earnings/<userId>/reports`; Create report → `/earnings/<userId>/custom-report` |
| Settings and documents | **modal of links** | Payout settings → `/account-settings/payments/payout-methods`; Tax documents → `/account-settings/taxes/tax-documents`; Airbnb.org donations → `/account-settings/payments/donations`; Give feedback |

Earnings does not edit payout or tax settings itself. The modal links to the
Account settings pages that own them.

## 9. Account settings and profile

### Account settings — `/account-settings`

- **Layout:** a full page. The host nav is replaced by a logo and a "Done"
  button. On the left is a flat list of links with no group headings; the
  content is on the right. At narrow width the list is the page, and
  sub-pages get a Back button.
- **Root:** `/account-settings` shows Personal information.
- **Tabs:** tabs inside a page are **URL segments**.

| Row | URL | Tabs / deeper |
| --- | --- | --- |
| Personal information | `/account-settings/personal-info` | each field row's Edit/Add → **inline** editor (Cancel / Save and continue) |
| Login & security | `/login-and-security` | tabs Login · Shared access `/login-and-security/shared-access` |
| Privacy | `/privacy-and-sharing` | announcement modal on entry; Blocked people → modal |
| Notifications | `/notifications` | tabs Offers and updates · Account `/notifications/account`; rows have Edit |
| Taxes | `/taxes` → `/taxes/taxpayers` | tabs Taxpayers · Tax documents `/taxes/tax-documents/`; taxpayer → `/taxes/taxpayers/details/<id>/<type>` |
| Payments | `/payments` → `/payments/payment-methods` | tabs Payments · Payouts `/payments/payout-methods` · Donations `/payments/donations`; Manage payments → `/payments/your-payments` |
| Languages & translation | `/preferences` | Preferred language and Time zone → large **modal** pickers |
| Booking permissions | `/booking-permissions` | — |
| Travel for work | `/airbnb-for-work` | Manage → `/airbnb-for-work/booking-permissions` |
| Business details | `<a href="">` | clicking stays on Personal information (no destination on this account) |
| Taxes (listed again) | `/taxes` | same page as above |
| Professional hosting tools | `/professional-hosting` | switch + custom profile URL `airbnb.com/p/<slug>` |
| Your first guest | `/listing-visibility` | redirects to `/account-settings` |
| Personalized recommendation | `/personalized-recommendation` | redirects to `/account-settings` |
| Airbnb-friendly apartments | `/airbnb-friendly` | — |
| Airbnb-friendly tools | `/properties` → `/airbnb-friendly-tools` | own subnav: Overview · Properties · Listings · Bookings (`/airbnb-friendly-tools/<x>`) |
| Team | `/hosting/team` | redirects to `/hosting` (no team on this account) |
| Co-hosting | `/co-hosting/overview/people` | tabs People · Listings; Invite co-hosts |
| Superhost Ambassador dashboard | `/refer/leads` | redirects to `/refer` |

### Profile — `/users/profile/...`

- `/users/profile/about?context=host` opens with an announcement modal. The
  left nav has About me (`/users/profile/about`), Travel map
  (`/users/profile/connections-map`) and Connections
  (`/users/profile/connections`).
- **Edit** goes to the same URL plus `&editMode=true` ("Edit profile").
- **Field editors:** each profile field opens a **modal** at desktop width,
  e.g. "What do you do for work?" (20 chars, Save). At narrow width it is a
  **bottom sheet**.
- **Listing editor:** the listing editor's `details/host` renders this same
  editor and opens the same field modal.

### Other

- **Refer a host** (`/refer`): a Home / Experience / Service selector with
  amounts, Share referral link, Customize link and Show QR code.
- **Help Center:** `/help/hosting` redirects to `/help`. Topics are
  `/help/topic/<id>` and articles `/help/article/<id>`. An AI-assistant modal
  appears on entry. Article content was not mapped.

## 10. Patterns observed

Each line below is an observation from the screens above, not a
recommendation.

1. **No unclickable navigation items.** The Menu, Account settings list,
   listing editor index, Preferences index and Arrival guide index have no
   group headings at all. The one grouped nav (Insights) makes each heading a
   link to its first child. Account settings' "Business details" is the only
   exception found: an anchor with an empty `href`.
2. **Every editable concern has a URL.** This covers sections
   (`details/pricing`), leaves (`details/pricing/rates/base`), keyed items
   (`accessibility/DISABLED_PARKING_SPOT`, `check-in-method/KEYPAD`), tabs
   (`notifications/account`, `?tab=upcoming`) and some modes or sub-editors
   (`house-rules?feature=checkInOut`, `?editMode=true`, `?archived=`).
   Opening a URL directly, or reloading, puts you on the same screen.
3. **What stays URL-less:** filters (Listings All/Homes/Experiences,
   Insights chips, earnings filters), short inline edits inside a pane
   (description fields, location rows, guest-safety rows, account field
   rows), popovers, and confirmation or picker modals.
4. **Index rows show the current value**, so the index doubles as a summary.
5. **At most two levels are visible at desktop width:** index + section, or
   section + leaf. At narrow width, the index is a page and each section or
   leaf is a full-height sheet.
6. **Modals at desktop width become sheets at narrow width.** Stacked dialogs
   occur twice: Base price → Compare similar listings, and Edit profile →
   field.
7. **Auto-open at desktop width only:** the listing editor opens photo-tour,
   Messages opens the newest thread, and Account settings opens Personal
   information. At narrow width each of these shows its list instead.
8. **One owner per concern, linked from several places:** house rules
   (`details/house-rules` and `arrival/house-rules`), host profile
   (`details/host` and `/users/profile`), payout and tax settings (the
   Earnings modal links to Account settings), calendar pricing and
   availability (editor sections link to `/multicalendar/<listingId>`).
9. **Homes and experiences share the shell, not the editor.** They share the
   Listings grid, the create modal, Earnings filters and the Messages inbox
   type. The editors differ: a home uses the persistent two-column
   `/hosting/listings/editor/<listingId>` editor; an experience uses the
   step-based `/setup/experiences/<experienceId>/<step>` editor with a
   section sidebar. Services use that same step shell
   (`/setup/services/<serviceId>/<step>`), with Offerings as priced
   sub-items. KrabiClaw deliberately does not copy this split: every
   offering kind uses one shared record editor.
10. **The Menu is the same content in two forms:** a side panel at desktop
    width and the page `/hosting/menu` at narrow width.

## 11. Not captured

- **Calendar:** the per-day editor (selecting dates on the grid) was not
  opened. Out of scope, since KrabiClaw's calendar is kept as it is (§5).
- **Experience editor after publishing:** not visible, because the account
  has only an in-progress experience.
- **Destructive and publishing actions:** Remove listing, Delete my account,
  Publish and Log out were not clicked.
- **Help Center:** article content was not mapped.
- **Phone width:** the narrow observations use a 520px Chrome window, not a
  390px device.

## 12. Photo tour follow-up — 2026-10-20

Read-only inspection of the owner's existing unlisted home in the live host
editor. No room, photo or listing details were changed.

- Photo tour shows authored room cards and an **Additional photos** card,
  with an actual photo or a room pictogram, the room's name, and its photo
  count or **Add photos**. It states that guests see the tour only once every
  room has a photo. **All photos** remains a separate destination.
- The plus menu offers **Add photos** and **Add a room or space**. The room
  chooser is a grid of single-choice illustrated tiles with search and a
  commit button. It includes indoor rooms and outdoor spaces; a bedroom
  count does not supply the room identities.
- Additional photos says that these photos remain in the listing even
  though they are not assigned to a room or space.
- An individual photo has **Move from Additional photos?** independently of
  **Add a visual description** and the room/space caption. Move opens a
  modal with existing room cards, Additional photos, and the room-type grid
  for a new destination. Its footer is **Cancel / Move**. Closing the modal
  leaves the photo unchanged.
- The existing Bedroom has separate destinations for Sleeping arrangements,
  Privacy info, Amenities and Accessibility features, plus **Delete room or
  space**. The sleeping-arrangement editor shows actual per-type bed counts;
  these are distinct from the listing's aggregate capacity.

### Authored bedroom details — later on 2026-10-20

The same existing Bedroom was opened again, without saving any changes.

- **Sleeping arrangements** has fourteen bed-type steppers: Single, Double,
  Queen, King, Small double, Bunk bed, Sofa bed, Couch, Floor mattress, Air
  mattress, Crib, Toddler bed, Hammock and Water bed. The editor has one lead
  sentence and **Cancel / Save**.
- **Privacy info** opens **Bedroom privacy**, with a single **Private
  attached bathroom** switch and **Cancel / Save**. It describes a bathroom
  attached to the bedroom that is just for its guests.
- Room **Amenities** opens **Add amenities**, with search and **All /
  Suggested** pills. Suggested contains bedroom-relevant choices; All uses
  the full amenity vocabulary, including alarms. The scope is explicitly
  the room or space. No amenity selection was changed.
- Bedroom **Accessibility features** offers **Step-free access** and
  **Entrance wider than 32 inches**. A feature opens its definition, example
  photographs, photo guidelines and **I don't have / I have this feature**.
  Selecting the latter in an unsaved draft revealed required photo evidence
  and Airbnb's own review process. **Cancel** discarded that draft. This
  review process must not be represented as a KrabiClaw approval service.
