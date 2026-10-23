# Lodging content: staging publication evidence

Verified on **23 October 2026**, Asia/Bangkok, against
`https://staging.krabiclaw.com`. Platform content was explicitly written to
organization `platform` through the staging CMS tools. Production content was
not changed. Article text remains in the CMS; this directory contains captures
and verification records, not another article source.

## Published content

| Page | CMS document ID | Change |
| --- | --- | --- |
| [Lodging](https://staging.krabiclaw.com/lodging) | `67f1b437-4e65-4ee7-bee4-7c93c925e065` | New lodging landing page |
| [Home](https://staging.krabiclaw.com/) | `191b92ac-4e06-4c70-85b6-06c6b0e67205` | Four-vertical positioning and lodging discovery |
| [Products](https://staging.krabiclaw.com/products) | `0d8c69f8-cd85-49c8-b6d8-b91a16a1437a` | Homes, nightly availability, stays and guest messages |
| [About](https://staging.krabiclaw.com/about) | `21cd09e6-3043-4265-88b5-5b531eeb031c` | Four business verticals, including lodging |
| [MCP](https://staging.krabiclaw.com/plugin) | `4a7ac520-6901-4431-8c17-b7e6365eacd2` | Home/calendar examples and current plan boundaries |
| [Set up a lodging website](https://staging.krabiclaw.com/docs/set-up-a-lodging-website) | `c26b90d5-4db7-46dc-85f1-c382eb500338` | New published customer guide |
| [Manage nightly availability and Airbnb](https://staging.krabiclaw.com/docs/manage-nightly-availability-and-airbnb) | `26a7af0c-3ff5-4cf6-88cb-958d13820e7b` | New published customer guide |
| [Prepare arrival guides and guest messages](https://staging.krabiclaw.com/docs/prepare-arrival-guides-and-guest-messages) | `f887983b-e7a8-45c4-8244-b1ca9af01aea` | New published customer guide |

The related capability, inquiry, integration and branding guide edits, their
retained document/block IDs, arrival-media IDs and projection checks are
recorded in [arrival-verification.json](arrival-verification.json).

Fresh CMS reads confirmed every original block ID and media placement was
retained on Home, Products, About and MCP. The landing page uses existing
platform coastal artwork; the artwork is illustrative rather than a screenshot
of a customer property.

## Live screenshots

The source PNGs show the running **fictional Saltleaf Stays staging demo** on
23 October 2026. No home, payment, guest message or provider connection was
created to obtain these captures. The listing-status capture shows an existing
demo subscription and is captioned accordingly.

| Workflow | Source capture | Published platform media asset |
| --- | --- | --- |
| Add a place to stay | `new-home.png` | `e68e68ae93caf63bee950581da1720a7e83bf296af382e01a66b0b42b7ac2a1f` |
| Base nightly price | `nightly-price.png` | `bbde5402df4c5c19445440fc871cc2b4673f03ad9a7641220ef7c2df244efc44` |
| Listing and booking status | `listing-status.png` | `c0ca65a6389173afb634c9fe6b0bda7c545540b3d4705af74cd4b1fb4ad6f7cf` |
| Selected nights | `nightly-calendar.png` | `8e0b546d507a0c9ba0f62dfe6ffa77ff142ccedebd450128feeb1ca4c43799db` |
| Supported Airbnb connection | `airbnb-connection.png` | `cac3acb420676d9ac3dbdcf8a94b65f6d4ad9576885cb4f726a484acb52c4a1a` |
| Private directions | `arrival-directions.png` | `17c31d0bed20bb54cd27f691cfe13c8273925b066b59456c79ecc841312de4b4` |
| Arrival guide overview | `arrival-guide.png` | `09715ffb566c50193f0bdac3342bb3c19f3b19aa607e2de2c49e9b5820ba644e` |

AVIF copies were uploaded through `save_media_attachment` to the platform's
isolated staging R2 media store and placed immediately after the relevant
instructions. No Cloudflare Images credentials were added to staging. The
published guides keep their introductions first and do not turn a workflow
screenshot into the article cover.

Rendered publication captures are `lodging-page-desktop.jpg`,
`lodging-page-mobile.jpg`, `setup-article-desktop.jpg`,
`setup-article-mobile.jpg`, `nightly-article-desktop.jpg`,
`nightly-article-mobile.jpg`, `arrival-article-desktop.jpg` and
`arrival-article-mobile.jpg`.

## Verification

- Chrome loaded all five marketing pages at desktop and 390px widths. Their
  lodging sections/examples and canonical URLs were present with no horizontal
  overflow. The landing page's hero and closing images both loaded.
- The setup guide's three screenshots and nightly guide's two screenshots
  loaded publicly at a natural width of 1125px. At 390px, each fitted the 339px
  article column. Captions retained the fictional staging context.
- All seven setup-guide and six nightly-guide table-of-contents targets existed;
  clicking their navigation moved to the corresponding headings. Both guides
  had one H1, matching canonical URLs, and readable desktop/mobile layouts.
- All three new guide URLs, the MCP reference and pricing returned HTTP 200.
  Their organization-neutral Catalog, Calendar, Plan and billing, Payments and
  Airbnb dashboard links returned the expected HTTP 302 sign-in redirect with
  their destination preserved.
- The landing page's explicitly labeled fictional staging demo link opened
  Saltleaf Stays and its four canonical home links. A scoped demo-copy repair
  replaced ambiguous fee wording and corrected its one-home footer description.
  Only the home hero's subtitle and organization `brand_description` changed;
  operational settings, prices, bookings, other blocks and media were retained.
- Staging remains noindex and intentionally has an empty sitemap. This is not
  a production indexing claim. CMS data publication does not deploy source.

## Source release status

Code changes for lodging navigation, footer, templates, search, LLM discovery,
pricing and onboarding use the repository's normal local Worker, CI and staging
release process. The focused marketing ESLint check and nine existing
template/LLM unit tests passed locally. **No source deployment has been verified
in this record yet.** Record a deployed revision and its fresh runtime checks
only after the release owner verifies them.
