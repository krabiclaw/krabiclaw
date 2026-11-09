# Coastal homepage CMS media — #1185

The platform homepage permanently uses the approved coastal layout: six planes, original breakpoint ratios and positions, one in-scene CMS headline and description, CMS CTA label/destination, rotating accents, reduced motion, alpha-mask interaction safety, and black seam overlap. Platform Home containers use `max-w-304` and `px-6`, and the narrow header spacing remains. There is no preview flag or alternate copy branch.

## Asset provenance

[Approved package](https://drive.google.com/file/d/1yJkAZsV56IbtXu7ufJIewjYVR7UuXNOh/view): `krabiclaw-coastal-responsive-v3.zip`, 27,707,374 bytes, modified 2026-10-01T00:03:55Z. ZIP SHA-256 `46f6d7050f954f58dacbf6de286eaef6e73cc8d39343af9213f1124b76d641cd`. Fresh supported Drive materialization, ZIP integrity and all 32 file hashes/dimensions passed. [Approved v3 manifest](assets/homepage-coastal/approved-v3-manifest.json), [independent measurements](assets/homepage-coastal/asset-verification.json), [original URLs/dimensions/renderer contract](assets/homepage-coastal/original-manifest.json).

All 30 hero breakpoint exports were uploaded and verified on the platform Home hero by the media migration on 2026-10-02 at 09:36:22.413Z. Their local copies are removed. The renderer reads the exact `block.media` parallax slots and fails on a missing placement. Original remote assets remain retained.

The transition uses the existing hero `content_block/media` placement, accepted by both the placement contract and page normalization. Home has no separate primary image consumer: its six artwork planes use their named parallax slots. On 2026-10-02 the parent assigned transition asset `393c183b-e188-49f6-a75b-cf3a093ededb` to hero `33f9e56e-cb23-4ac5-8ae5-3a89bd73fb7e` on Home page `191b92ac-4e06-4c70-85b6-06c6b0e67205` and verified it with a fresh `get_site_page` read. The local transition file is removed. This binding preceded deployment: the old renderer ignores the slot, and the new renderer reads it directly with a visible failure if it is missing. No validator expansion or fallback is needed.

Foreground full-width opaque pure-black rows: xxs31, xs132, sm164, md100, lg139. The foreground cover crop is unbounded with viewport width; at 5120 px it stops above the source black band. A bottom gradient on the existing foreground plus a 2 px overlap and the black-topped next-row artwork guarantees a black boundary independently of that crop. This keeps six hero planes. The gradient is a visible seam safeguard, not a claim that 139 source rows cover every viewport.

## Historical bundled-preview verification

Before this CMS cleanup, using Node 24.18.1, the production Worker build and actual Chromium renderer passed 108 states: widths 320,375,376,390,599,600,768,959,960,1208,1263,1264,1366,1903,1904,2543,2544,5120; initial/intermediate/exit scroll; normal/reduced motion. All30 currentSrc values rendered with six planes. Every initial CTA passed trial click, hit testing and Tab focus. Separate Tab/Enter navigation opened signup. Rotation produced ChatGPT, Claude and MCP; reduced motion stayed on ChatGPT. One H1, no repeated intro copy/actions, no horizontal document overflow. Every sampled fully covered seam row was pure black, excluding scrollbar pixels. These are sampled scroll checks, not exhaustive continuous-scroll proof.

[Worker summary](assets/homepage-coastal/worker-qa-summary.json), [behavior](assets/homepage-coastal/worker-behavior.json), [flag-off SSR](assets/homepage-coastal/default-off.json). The full108 screenshots/measurements remain in the task workspace; no private account UI or credentials were included in evidence. Full repository quality, production build/Worker import guard and six focused social-card tests passed.

![Desktop initial preview](assets/homepage-coastal/desktop.png)

![Mobile initial preview](assets/homepage-coastal/mobile.png)

Known art detail: the artist documents six inherited lg low-alpha pixels near scene coordinate (1170,647). A conservative source pixel-center sample finds nine pixels below 16/255 (five fully transparent) around x1168–1174,y646–648; browser interpolation renders a small dark woodland detail. The original pavilion/woods bytes are unchanged, the black background is retained, and this is separate from the seam. [Magnified actual screenshot](assets/homepage-coastal/lg-opening.png). Wider ends of some ranges frame more forest/pavilion, and 5120 px starts sky-heavy because the inherited scene ratio remains unchanged.

## Homepage Satori card

Public metadata uses the canonical `value.socialImage`; the finished bundled card no longer overrides Home metadata. The platform organization card generator still reads the authored English Home hero through `platform-home-social-card.ts`, including all rotating accents, description, brand mark and coastal background. Other organizations retain their current generation behavior.

The parent verified approved clean coastal background asset `7119357a-a224-44c5-add5-12e5a156c647` on platform organization `social_share`, but no generated `social_card` was present in that read. The user accepted leaving generation to automatic reconciliation. Both unused local social PNGs are removed, completing removal of the runtime artwork bundle. Approved source filenames, dimensions and hashes remain in the v3 provenance manifest and independent measurements. The historical finished bundled Satori card was 1200×630 with SHA-256 `05ee3f8a358ccbd807681170cf035c3bd448172141bc3687debc15756d3eb7df`.

The canonical placement writer calls `refreshSocialCard` after `social_share` changes, and the write that changes a card's inputs is the only thing that renders it: there is no scheduled sweep, so a card that was skipped (`images_unavailable`, `owner_not_found`, `missing_content`, `no_source`) stays as it is until its inputs change again or `POST /api/editor/organizations/{organizationId}/social-cards/regenerate` is called. Only production has Cloudflare Images configured, so only production renders.

The authenticated native trigger remains `POST /api/editor/organizations/platform/social-cards/regenerate` with `{}` if an explicit regeneration is needed later. No provider configuration changes or generation are part of this cleanup.

The preceding screenshot/Worker evidence describes the bundled preview before migration; it is not runtime proof of this CMS cleanup. This change is a code audit, with no live browser or production writes. Release verification must exercise canonical image delivery, alpha-mask fetching, transition and social metadata after the canonical generated social card is confirmed.

## Code-audit checks

Node 24.18.1: focused existing media placement/preservation and social-card tests passed (8 tests); all repository quality constituents passed (feature library, data loading, email catalog, notification parity, 476 Vue SFCs, Thai/Japanese catalogs, typecheck and lint); production build and generated Worker import guard passed. These checks preceded the authorized staging push. After deployment exposed stale staging media, a separately authorized scoped D1 repair inserted the 32 approved asset records, replaced the 30 hero and organization social-share bindings, and added the hero transition binding. Old assets remain. Readback matched every approved asset and placement; public Home served the canonical hero URLs and returned HTTP 200. No full database refresh, live browser UX test, or production write was performed. An attempt to access an existing dashboard session for authorized native card regeneration was rejected by automatic approval review because that tab belongs to another organization; no regeneration was executed. Canonical delivery and interactions remain a release verification requirement.
