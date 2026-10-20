# Pricing implementation contract

Scope: [#1192](https://github.com/paulchrisluke/krabiclaw/issues/1192), a pricing-only
slice of #939. No merge, deployment, Stripe write or published-page mutation. Six owner-approved
MCP media uploads were completed and independently read back active in platform.

## Canonical rendering and ownership

The existing platform tenant page maps its `feature_grid` / `billing_plans` block
through `PlatformFeatureCards` to `PlatformPlansSection`. Its `/pricing` branch
can select scoped pricing presentation; the homepage branch must keep its current
behavior. The generic `BillingPricingTable` currently serves both branches.
The dashboard uses `usePlans()` separately. Do not create a parallel `/pricing`
page or inject a second paid catalog.

`usePlans()` reads `getCachedPlans()` on the server and `/api/billing/plans` on the
client. Stripe Product owns paid name, description, image, display metadata and
`marketing_features`; Stripe Price owns actual amount, currency, cadence and
identity. The free plan and CTAs are app-owned. The approved headline
remains in the current CMS hero block.

[Read-only billing verification](billing-verification.json) records the current
public projection and live Stripe catalog. Growth currently has one USD 4900-cent
monthly price and one USD 58800-cent annual price. Both lookup keys are null.
Annual is not a discount or a calculation from monthly.

## Implementation scaffold

1. Retain the existing route/block path and scope the new plan rail and grouped
   comparison to `/pricing`. Inventory all shared consumers before changing them.
2. Keep one copy of SSR plan details and actions. Progressively enhance only
   approved, decoded photo art with a sequential positive/rightward Y-axis flip;
   reduced motion, failed/slow assets and early focus expose details immediately.
   No repeated watcher-driven animation, duplicated controls or timer-dependent
   access to pricing. Preserve the same box for both faces.
3. Use an overflow-contained mobile snap rail with the next-card peek and a
   desktop two-column layout. Comparison uses real table semantics, grouped
   headings and conditional explanations instead of unsupported checkmarks.
4. Place the approved benefit illustrations, FAQ and coastal CTA through the
   existing canonical page/block architecture. The approved reference and all six PNG assets were downloaded through the
   authorized Drive flow and verified against their SHA-256 manifest.
5. Add provider/missing-interval, no-JS/reduced-motion/early-focus, mobile overflow,
   replay and shared-homepage regression proof. Run required quality and suites
   on the final draft commit and retain rendered desktop/mobile evidence.

## Precise catalog change proposal for review

Target existing Growth Product `prod_UcH8Sw98ABNwKL`:

- `name`: `Growth` → `Grow`.
- `images[0]` and `metadata.catalog_image_sha256`: replace only after the approved
  portrait asset has a verified provider URL/hash. The supplied local asset is
  verified (see asset-manifest.json), but a provider-hosted URL is still required.
- Broaden the existing restaurant/experience-only bullet to cover supported
  professional services; exact final customer wording remains for review.
- Review the generic messaging/import bullets against the verified paid gates,
  one-time free onboarding and weekly paid review refresh before final wording.
- Do not write this proposal automatically or change product ID, plan_id,
  default price, monthly/annual price IDs, amounts, currencies, lookup keys,
  recurring cadence or subscription policy.

Free `STARTER_PLAN.name` becomes `Basic` in its application-owned source. Paid
Grow naming and billing Product image changes remain provider-owned and await
catalog approval. Decorative page photo fronts now use the existing plan block
CMS placements (`items.0.image` / `items.1.image`), explicitly separate from
the billing Product image. That page-media ownership follows the owner’s approved
MCP media/content integration; it does not rewrite the Stripe billing projection.

## Verified comparison conditions and dependencies

- Free initial Places snapshot import is different from paid location connection,
  explicit re-import and weekly Sunday review refresh. Sources:
  onboarding draft endpoint, `google-places/sync.post.ts`, `server/scheduled-tasks.ts`.
- English is the source language. Paid plans can publish every supported locale;
  supported catalogs are the ones listed in `shared/platform-locales.ts`. This is manually authored
  content, not automatic translation or arbitrary language selection.
- Saya (restaurant/experience) and Blawby (service) provisioning has no billing
  gate. Current Blawby promotional Growth wording needs reconciliation.
- Explicit review-request sending is currently paid. Ordinary booking emails and
  token reads are separate; no Free policy change is authorized.
- #1190 and #1191 remain open drafts. At the owner’s consolidation request their
  approved narrow gate and evidence foundation are incorporated into this single
  pricing branch. Neither draft was closed or merged. The gate is present in this
  branch, not claimed as deployed production behavior.
- No WhatsApp content editing, community-support service, guaranteed priority
  response or automatic Facebook sync is supported by this comparison.

## Draft implementation and activation dependencies

The new `feature_grid` source `billing_features` selects canonical application
capability comparison rows. It is semantic source selection, not a rendering flag,
and adds no block type, route or database schema. `billing_plans` still owns the
plan cards and the homepage keeps the original billing table presentation.
Published comparison copy is reviewed manually, never generated from MCP tool names.

The supplied free portrait and Basic name are changed in the app-owned Starter
source. Both decorative page photo fronts read the plan block’s canonical CMS
media placements, with the billing image used only when page art is absent.
Stripe-owned Growth name, Product image and marketing bullets remain intact.
All six art assets are uploaded through MCP, independently confirmed active,
and recorded in uploaded-media.json; no rollout switch is introduced.

`cms-proposal.json` preserves the current hero and plan block IDs, then places
three image-with-text blocks, a capability comparison, the existing page Q&A,
and the coastal CTA. All bindings now carry real, independently read-back active asset IDs. No
remote page/content assignment has been made. Q&A corrections are separately listed because
FAQ records own those answers, not block.data.items.

The complete comparison includes WhatsApp business notifications, and the
approved #1190 gate/tests are incorporated in this branch. Production activation
must include that gate; current production is not described as already fixed.
Review-request emails retain their current paid behavior without deciding the
open Free policy. No community, support SLA, automatic social import, automatic
translation or claimed provider credits are added.

The paid CTA now carries its canonical `/api/post-login?plan=growth` target in
the existing signup `redirect` parameter as well as `plan=growth`. Signup reads
`redirect`, not `plan`, so the former URL silently lost the paid choice for new
accounts. This changes application-owned CTA configuration only; identity, auth
and checkout code are unchanged. Existing signed-in CTA behavior still reads
the same plan query. No annual toggle is introduced: the card offers the actual
monthly price and the existing billing screen owns interval choice.

## Verification limits and approval review

The initial Chrome screenshots in `evidence/` recorded the original three-block
CMS page. They are baseline evidence, not the completed full-page proposal.
Read-only presentation checks exercised the real configured local Worker.
Completed full-page screenshots are now in `evidence/pricing-desktop-complete.jpg`
and `evidence/pricing-mobile-complete.jpg`. The canonical authenticated local
editor API persisted eight blocks and six placements, and the public renderer
showed all 26 comparison rows. No direct database rows or shadow page were used.

The canonical image uploader is production-only, but the owner then explicitly
authorized the six media-library uploads through MCP. These completed and were
read back active. Existing `content_block` single-value media placements are used
for plan art, benefits and CTA. The local snapshot can include those real rows
for complete-page verification without writing the published page.

Automatic approval review rejected the full E2E setup because its documented
cleanup irreversibly deletes Stripe test customers. No workaround was used.
Approval for that specific test cleanup is needed to run the full suite; the
read-only pricing checks, unit/D1/migration checks and draft preparation proceed.
The shared footer repair remains owned by #1193. Current staging lacked that
landed main change, so this branch carries its exact existing commit
`4027048578ea5aa00ab35b48e1301064289d9e3b` via cherry-pick, rather than a second repair.

## Missing-content checklist (original preview → complete page)

- Three sales/benefit rows were absent because the original CMS page contained
  only hero/plans/FAQ. The complete packet adds the approved headings, meaningful
  verified explanatory copy, and each uploaded watercolor illustration.
- The generic ten-row comparison was removed from the pricing plan card renderer
  to place sales rows before it. The complete packet restores a separate grouped
  comparison: 26 rows across website, management, guests, presence/languages and
  help. Invalid WhatsApp editing, automatic social sync and unsupported support
  claims are replaced by actual capabilities and setup conditions.
- All six existing Q&A records remain, rendered with native details for no-JS
  access. Proposed name/Places wording corrections are listed for source-owner
  review; Q&A is a canonical read-only source, not fabricated block.data.items.
- The coastal closing invitation was absent. Its new CTA block reads the uploaded
  image from `media`, with the approved heading and Start free action.
- Both photo fronts use the original plans block’s indexed CMS image slots; a
  single sequential rightward reveal keeps one accessible copy of plan details.
- No new rollout switch or partial-page activation dependency is added. The
  complete CMS packet and renderers are reviewed and delivered together.

## Completed local validation

- Quality (feature parity, guardrails, locales, typecheck, lint) and production Worker build passed.
- Consolidated unit suite: 237 passed; D1 suite: 74 passed. Migration tests: 2 passed.
- Four read-only pricing browser checks passed against the complete local CMS page: desktop/provider handoff and full comparison, mobile peek/reduced motion, keyboard, and JavaScript disabled.
- MCP snapshot, ChatGPT submission, migration lint and schema drift checks passed.
- Full E2E remains blocked by the specific Stripe test-customer cleanup approval above; no green full-suite claim is made.
- Production page blocks/placements and Stripe paid presentation remain unapplied. Existing Q&A corrections and review-request Free policy remain owner decisions.

## Owner visual revision

The plan-card actions already used `PlatformAccountCta` → `PlatformButton`, but
pricing's deep anchor CSS forced dark labels, and Basic selected outline. Pricing
now selects the existing solid primary variant for both cards, with all local
button color/border/focus overrides removed. Rendered colors match the shared
header primary action; the closing CTA already uses that same default.

The owner's earlier-middle reference restores a warm-white open editorial band,
with a canonical heading block: “A place to build. Room to grow.” The packet is
now nine blocks, still using the same six media placements. The illustration/text
order is left/right/left, headings are restrained, rows remain expansive, and
subtle dividers connect them. Copy and every page section remain present.
The available approved exports are still watercolor metaphors: their imagery
differs from the earlier site's browser/editor/settings compositions. Matching
that imagery requires the earlier exports or separately approved replacement
art; no fake product screenshots or substituted asset IDs were introduced.

Comparison cells use the existing shared icon system's filled check, dash or
numeric limit, with a short setup qualifier where required and hidden labels for
screen readers. Each feature name opens a native keyboard/no-JS details disclosure
containing its conditions. CSS paint containment prevents the comparison's native
details content from leaking horizontal page overflow on mobile.

Build, Vue SFC checks, typecheck and feature-library validation passed. The four
pricing browser checks passed; only desktop/mobile were subsequently refreshed
for decoded below-the-fold screenshot evidence. No broad suites, extra review,
provider cleanup, production CMS/Stripe writes, merge or deployment occurred.
Updated rendered evidence: `evidence/pricing-desktop-owner-revision.png` and
`evidence/pricing-mobile-owner-revision.png` (local test Chromium; Chrome controls
were not exposed for this follow-up).

## Landed foundations and corrected botanical preview

PR1190 merged into staging at `91fbaaa71d7cce0df02997b7fdec7a8602015363`;
PR1191 merged at `48a6b1f5390d699a9ef454c1ae555385c47d2554`. Pricing was rebased
onto them and Git dropped the duplicate foundation/footer commits. The feature
library retains the landed gate evidence provenance; pricing adds only its
reviewed comparison publication mapping/validation. Pricing remains held.

The corrected v2 asset bundle replaces only the three benefit PNGs, all
1200×800 with transparency. Six manifest hashes passed, and both plan photos and
the coastal CTA are byte-identical to the prior approved files. Botanical
browser mockups now show Kikuzuki's real homepage/story/reservation and NCLS with
the supplied pottery mobile example. They are rendered locally in
`evidence/pricing-desktop-botanical-middle.png` and its mobile counterpart;
full-page preview files are also retained.

Image ingestion is production-only by design (`server/utils/cloudflare-images.ts`).
Because production writes are held, these screenshots are expressly an asset
preview: `capture-corrected-art-preview.mjs` substitutes only the three exact
external image-provider responses with the verified local PNG bytes. CMS,
billing, layout and copy come from the actual local Worker, unchanged by the
capture. This is not proof of persisted replacement media or production
activation. The packet records pending replacement files, hashes, alt text and
prior IDs; those prior IDs still identify the rejected artwork. No replacement
IDs are invented or published. Owner approval and authorized media ingestion
must precede final placement/publication.

The rebased feature parity check and production Worker build passed. No new
broad tests, review request, Stripe cleanup or production mutation was initiated
for this visual handoff. Foundation staging Checks passed independently;
automatic staging deployment/tenant validation is monitored separately.

## Approved release

Owner approved the corrected botanical page for review > staging > production on 2026-10-01 (Sentinel_abd9d57741108191aa0bb43e618c4a3c). The three replacement images have now been uploaded through canonical MCP media ingestion and independently read back active. The CMS packet and upload receipts reference their actual IDs. The earlier substituted-image screenshots are historical previews, not release proof. Final verification must use persisted content and provider images without interception. Paid presentation remains Stripe-owned; prices and internal IDs are preserved.
