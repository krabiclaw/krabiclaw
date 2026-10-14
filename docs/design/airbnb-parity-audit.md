# CMS leaves: Airbnb parity audit

**Status: Proposal — 2026-10-01.** Audit of every dashboard leaf against Airbnb's
host tools. Scope is the *inside* of a level — controls, helper text, spacing,
width — not navigation, which `DESIGN.md` already settles and the CMS already
follows. Nothing here was implemented; the output is a set of changes to approve
and turn into an issue.

Evidence: all 173 files under `pages/dashboard/` read; the deep leaves clicked
through locally on `staging` (`5c4e3ce94`) at 800px (sheet) and 1440px (pair);
computed styles measured on both our leaves and a live Airbnb leaf in the
owner's account; the 85 captures in `goal/airbnb{,-desktop}/` re-read.

## 1. Verdict

The navigation is Airbnb's. The leaves are not. Six things, all global, make
every leaf read as "Nuxt UI default":

| # | What we do | What Airbnb does | Where it shows |
| --- | --- | --- | --- |
| 1 | **A checkbox for every yes/no.** 19 `UCheckbox` vs 3 `USwitch`. | Never a checkbox. Three controls only: a **✕/✓ pair** for rules, a **switch** for one setting, a **selectable card** for one-of-N. | features, status, publication, reservations, seats, hours "Closed", booking "Takes bookings", qa visibility, url |
| 2 | **Bordered boxes stacked.** `rounded-xl border` cards or `UCard` as the row primitive. | Rows separated by a **1px hairline**, 24px padding, no box. A box is reserved for a *picker* (cards you choose between) or a *value you tap into*. | reservations (7 boxes), features (2 UCards), options, hours exceptions, localization, members, insights (15 UCards) |
| 3 | **Helper text everywhere, in five styles.** FF `description` (17), `help` (7), intro `<p>` above (≈15 leaves), inline `<p>` below, counter above bare input. | **One line, in one place:** a muted sentence under the title *or* a `44/50 available` counter. Rows carry a one-line sub-label. No sentence under a field. | address ("One line per line.", "Two-letter code, e.g. TH."), seats, notice, booking ("Leave empty for no limit. Zero means no places at all."), publication |
| 4 | **Field density.** Full-width inputs (654px at 1440), 42px tall, `rounded-md` (6px), 17px label *and* value *and* helper all the same size and weight-ish. | Title/short text is a **bare 22–26px text field** with no border. Long text is one textarea, 8px radius, 1px `#B0B0B0`. Labels are 16px `#222`, sub-labels 14px `#6C6C6C`. | every text leaf: name, title, headline, slug, contact |
| 5 | **Width.** `DashboardLeafPanel` allows `max-w-5xl`; only booking and calendar-settings leaves narrow themselves (`max-w-md`), so leaves disagree with each other. | The leaf column is one width (≈560px of content) and nothing stretches to fill it. Whitespace is the design. | address at 1440 is six 654px inputs |
| 6 | **Compound leaves.** Hours (7 days × checkbox + 2 time inputs + add), booking (checkbox + 2 fields + 7-day schedule), announcement (7 controls), address (6 fields), section fields (every schema field). | Leaf size is enforced. Hours-like data is a **row per day** opening its own picker; a schedule is a list you add to; address is a *row* ("908 Islander Way, Chattanooga…") that opens one form. | hours, booking, announcement, address, `sections/[blockId]/[section]` |

Fixing 1–5 is almost entirely `app.config.ts`, the two shells, and three new
shared controls. Fixing 6 is per-leaf and is the smaller half.

## 2. Measured

Ours at 1440 (booking leaf, light): index column 720px; leaf content 745→1414,
input 654×42, radius 6.36px, 17px text, 21px checkbox, title 17px/600, Save
67×42 radius 6px. Airbnb (house rules, 865px sheet): rule row 770×87 with
`padding-bottom 24px` and `1px solid #DDD` below; Save 83×48 radius 8px padding
14/24, 16px; Cancel plain 16px/500 text; body 16px `#222`, muted 14px `#6C6C6C`;
Airbnb Cereal. Airbnb's pair splits the frame in half (80–660 of 1332, measured
2026-09-21); ours is 720 / 720 — same.

So the skeleton matches and the furniture doesn't. The 17px everything comes
from `size: 'xl'` defaults on every control plus a 1.06rem base; Airbnb runs
16/14 with a 22–32px title.

## 3. Global changes (do these first — they fix most leaves without touching them)

### 3.1 `app.config.ts`

- Drop `size: 'xl'` as the default for `input`, `textarea`, `select`,
  `selectMenu`, `inputNumber`, `inputMenu`, `inputTags`, `inputDate`,
  `inputTime`, `checkbox`, `button`. Set `lg` (16px text, 44px) and let the
  commit bar's Save be the one `xl`. Remove the hand-written `size="xl"` on
  pages that repeat the default.
- `input`/`textarea`: `rounded-lg` (8px), ring `--kc-field-border` (the 3:1
  token already in `base.css`, currently unused), `bg-default` not elevated.
  Focus ring 2px `#222`/`text-highlighted`, not primary coral — Airbnb's focus
  is black; coral stays for status and selection marks.
- `formField`: label `text-base font-medium text-highlighted`; `description`
  and `help` slots styled `text-sm text-muted` and **used by one rule** (see
  §5). `hint` only for `Optional`.
- `button`: `rounded-lg`; solid neutral `h-12 px-6` for the commit bar; `ghost`
  Cancel loses its padding so it reads as text. Add a `pill` variant
  (rounded-full, `bg-elevated`) — Airbnb's Edit/+/filter chips.
- `switch`: `size: 'lg'`, checked colour `text-highlighted` (black/white), not
  coral. Airbnb's toggle is black.
- `radioGroup` `variant="card"`: `rounded-xl border p-5`, selected =
  `ring-2 ring-highlighted`, title `text-base font-medium`, description
  `text-sm text-muted`. This becomes *the* one-of-N control.
- `card`: `rounded-2xl border border-default shadow-none p-6`, and then
  **stop using `UCard` in leaves** (only Insights and Members use it; both move
  to rows).

### 3.2 `DashboardLeafPanel`

- Content column `max-w-xl mx-auto` (≈576px) for every leaf; remove the
  per-page `max-w-md` wrappers. A leaf that needs more width is a grid editor
  and says so.
- Title `text-2xl font-semibold` on the sheet, `text-[32px]` at `lg` — Airbnb's
  leaf has a real title, ours is the 17px navbar string.
- One optional `lead` slot: a single muted sentence under the title. This is
  the only place a leaf explains itself.
- Commit bar: Save `size="xl"`, Cancel text-only. Already right; keep.

### 3.3 Three shared controls (new, in `components/dashboard/`)

| Control | Replaces | Airbnb reference |
| --- | --- | --- |
| **`RuleRow`** — label, optional sub-label, ✕ / ✓ pill pair on the right, hairline below | `UCheckbox` in a card or bare | house-rules, guest-safety/property-info |
| **`SettingRow`** — label, sub-label, `USwitch` right-aligned, hairline below; optional child row (`>`) | `UCheckbox` + description, `USwitch` in FF | instant-book ("Require a good track record"), pricing ("Smart Pricing") |
| **`ChoiceCards`** — `URadioGroup variant="card"` with the theme above | hand-built buttons in `calendar/settings/cancellation.vue`, `URadioGroup` default in reviews visibility | preferences/status (Listed / Unlisted), cancellation tiers |

Plus one already-existing thing used more: **`EditorNavigationList` rows with a
value** (`ValueRow`) — "Address · 908 Islander Way…" — for anything the tenant
reads more than edits.

### 3.4 `DESIGN.md` additions

Add a section **"Controls"** after *Leaf size*:

- **A yes/no is never a checkbox.** A rule is a ✕/✓ pair. A setting is a
  switch. A one-of-N is cards. A checkbox exists only in a list's *Select*
  mode (which `DashboardListEditor` already does).
- **A box means "choose me" or "open me".** Rows are hairline-separated.
  A bordered card is a selectable choice or a value that opens a leaf. Never a
  container for a control.
- **One explanation per leaf**, under the title. A field never carries a
  sentence. Counters (`44/50 available`) sit above the field in `text-sm`.
- **Leaf width is fixed** (`max-w-xl`). Fields do not stretch to the pane.
- **Short text is bare**: name, title, headline, slug, link render as a
  borderless 22–26px field with a counter (Airbnb title/custom-link). Long
  text is one bordered textarea.
- Add to the *Leaf size* table rows for Hours-by-day and Schedule so the
  compound leaves have a named decomposition.

Also correct the *Committing* paragraph: Cancel is a text button, Save is the
only filled control on screen.

## 4. Per-leaf changes

Grouped by what fixes them. "G" = fixed by §3 alone.

### Checkbox → RuleRow / SettingRow / ChoiceCards

| Leaf | Now | Change |
| --- | --- | --- |
| `locations/…/settings/features.vue` | UCard per checkbox | 2 `SettingRow`s (Menu, Reservations), no cards |
| `locations/…/settings/status.vue` | 1 checkbox "Active" | `ChoiceCards`: Active / Hidden with one-line consequences (Airbnb Listed/Unlisted) |
| `products/…/publication.vue` | 4 checkboxes + descriptions | 4 `SettingRow`s; the descriptions become the sub-labels; retitle "Where it appears" → keep |
| `locations/…/reservations.vue` (`ReservationPolicyForm`) | 7 bordered rule boxes, each checkbox + sentence + stepper | 7 `RuleRow`s. Rules with a number (notice, cancel, reschedule, capacity) show the number in the sub-label and open a picker leaf — these already exist under `calendar/settings/` (notice, seats, cancellation); point at them, delete the duplicated controls here |
| `calendar/settings/seats.vue` | checkbox "Limit seats" + number | `SettingRow` (Limit seats) + stepper beneath when on |
| `calendar/settings/cancellation.vue` | hand-built card buttons | `ChoiceCards` (G) |
| `qa/[qaId]/visibility.vue` ×2 | 1 checkbox | `SettingRow` "Shown on the site" |
| `qa/reviews/[reviewId]/visibility.vue` ×2 | URadioGroup default | `ChoiceCards` |
| `blog/[postId]/url.vue` | input + conditional checkbox | input + `SettingRow` |
| `brand/announcement.vue` | USwitch in FF + 6 fields | `SettingRow` "Show announcement" at top; the 6 fields become rows → leaves (title, message, link, image) — this is an **index**, not a leaf |
| `account/profile/notifications/[category].vue` | 2 bare USwitch | 2 `SettingRow`s (G) |
| `website/domains.vue` add-domain modal | checkbox | `SettingRow` |

### Card stack → rows

| Leaf | Change |
| --- | --- |
| `settings/members.vue` | Two UCards → one hairline list, role as a pill menu on the row; "Pending" is a second group heading, not a card |
| `website/localization.vue` | Language cards + progress UCard → rows: `English · Source`, `ไทย · 179/223 translated` each opening its leaf; the "Let's translate" card becomes rows under a group heading |
| `products/…/options.vue` | Bordered option boxes with unlabeled inputs → a list editor of options (rows), each option a leaf with Name + Values; combinations a second list |
| `locations/…/hours.vue` exceptions | Bordered exception cards → list rows "Dec 25 · Closed", each a leaf |
| `settings/insights.vue` | 15 UCards → metric rows with a group heading per tab (Airbnb Insights is rows and one chart). Lower priority: analytics, not a form |
| `settings/people.vue`, `select-organization.vue` | `rounded-2xl border` list wrappers → plain hairline list |

### Compound leaf → index + leaves

| Leaf | Change |
| --- | --- |
| `locations/…/hours.vue`, `calendar/settings/hours.vue` (`LocationHoursCard`) | Index: Timezone row; one row per weekday "Monday · 12:00 PM – 10:00 PM" / "Sunday · Closed"; Exceptions row. Day leaf: `SettingRow` Open, then Opens/Closes time pickers, "+ Add hours" |
| `products/…/booking.vue` | Index: `SettingRow` Takes bookings; rows Session length, Places, Schedule. Schedule is a list editor of "Monday · 2:00 PM, 6:00 PM" rows; day leaf lists times with a stepper for places |
| `locations/…/address.vue` | Keep one leaf (Airbnb's address edit is one form) but: `max-w-xl`, Street as a single input (not textarea), no helper sentences, Country as a select |
| `brand/announcement.vue` | see above |
| `sections/[blockId]/[section].vue` (`TenantPageBlockFields`) | Already an index of records where the schema has them; where it renders every scalar field in one leaf, render rows → one leaf per field (the machinery in `[recordIndex]/[field].vue` already does this for records) |
| `products/…/attributes.vue` | Rows per definition → leaf per attribute |

### Text leaves → bare field (G, after §3.1/3.2)

`brand/name`, `brand/description`, `products/…/name`, `…/description`,
`…/order-url`, `pages/[pageId]/title`, `posts/…/headline`, `…/body`,
`links/…/label`, `…/destination`, `settings/slug`, `locations/…/name`,
`contact`, `qa question/answer`. Remove the per-page counter `<p>` (two styles
today) in favour of the shell's counter; remove `description`/`help` sentences
(post action "Where it goes", slug, order-url, price, page summary, links
status, address ×2, categories ×2).

### Already right (leave alone)

`calendar/settings/notice.vue` (card radio), `website/status.vue`,
`profile/appearance.vue`, `profile/personal.vue` (value rows + Edit — this is
Airbnb's personal-info exactly), `profile/login.vue`, `bookings/change/*`,
`pages/[pageId]/summary`, product index, post index, every
`EditorNavigationList` index.

## 5. Helper-text rule, applied

Of the 24 field-level sentences in `pages/dashboard`, 19 restate the label
("Whether the site shows it at all"), 3 belong in a sub-label on a row
(publication, booking places), 2 are genuinely needed and move to the leaf's
one lead line (`delete.vue`, `localization.vue`). After the change the only
`UFormField` props in use are `label` and `hint="Optional"`.

## 6. The Airbnb library

`goal/airbnb/` (mobile) and `goal/airbnb-desktop/` are the reference. Index by
pattern, so review can point at a file:

| Pattern | Capture |
| --- | --- |
| RuleRow ✕/✓ | `details/house-rules/index.jpg`, `details/guest-safety/property-info/index.jpg` |
| SettingRow switch | `details/instant-book/index.jpg`, `details/pricing/index.jpg`, `preferences/guest-requirements/index.jpg` |
| ChoiceCards | `preferences/status/index.jpg`, `details/cancellation-policy/index.jpg` |
| Bare short-text field + counter | `details/title/index.jpg`, `details/custom-link/index.jpg` |
| One textarea + counter | `airbnb-desktop/…/description-listing-description-open-1728.jpg`, `details/guest-safety/property-info/add-details-stairs/index.jpg` |
| Value rows + Edit | `account-settings/personal-info/index.jpg` |
| Index cards with value (listing editor) | `details/index-your-space-tab*.jpg`, `arrival/check-in-out/index.jpg` |
| Value card → picker (Availability) | `details/availability/index.jpg` |
| Icon rows with one-line sub-label | `details/amenities/index.jpg` |

**Gaps to capture** (owner's account, listing 49487067): desktop (1440) versions
of house-rules, instant-book, title, availability's Advance-notice picker, the
calendar Settings sheet (Pricing/Discounts/Availability/Cancellations), and the
Experiences host editor (listing "Practice wellness with a fitness coach" is in
progress on the account) — the latter is what the experience leaves should be
measured against. Only 10 of the 85 captures are desktop.

## 7. Proposed issue breakdown

1. **Theme and shells** — §3.1, §3.2, `DESIGN.md` Controls section. One PR; no
   leaf changes; visually moves every leaf at once.
2. **Controls** — `RuleRow`, `SettingRow`, `ChoiceCards`; convert the twelve
   checkbox leaves and the cancellation leaf.
3. **Rows, not cards** — members, localization, options, hours exceptions,
   people, select-organization.
4. **Decompose** — hours, booking, announcement, attributes, block fields.
5. **Insights** — last; analytics, not a form.

MCP is unaffected: every change above is presentation over the same editor
drafts and the same endpoints; nothing adds a field MCP cannot set.
