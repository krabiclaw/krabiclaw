# Publishing Kikuzuki's Thai content

Issue #807 is delivered only when Kikuzuki's own public site has a working Thai
footer choice and translated content. NCLS fixture coverage cannot establish
that. The client will review the Thai copy after production publication; human
review is not a release prerequisite for this request.

## Authored content and environment identity

Keep client source exports, translations, and publish bundles under the ignored
`client-imports/kikuzuki/localization/` directory. Back up that directory before
removing a worktree. The public repository must not contain client exports or
access tokens. Commit publisher code and operational instructions only.

A bundle identifies one exact `origin`, `organization_id`, and `locale`, and contains:

- `products`: all products in that environment, each with `product_id`,
  `source: { name, description }`, complete translated `values`, and `route_path`.
- `resources`: canonical `put_resource_localization` arguments for the site,
  each location, each product category, experience details, posts, and image alt
  text where the English source contains it.
- `pages`: canonical `create_site_page` arguments, including the existing
  source `page_id`, translated metadata and blocks, and existing media placements.

The publisher supports the catalog epoch's product model, where a product is
owned by its organization and reaches a site through a `product_publications`
row rather than carrying an `organization_id` of its own. Build a fresh production bundle
from the production catalog after its approved epoch cutover. Do not
reuse staging IDs or replace production's larger menu with staging's fixture
catalog. Reuse the exact English-to-Thai dictionary, and stop for any new or
changed English text that lacks an explicit translation.

Products are saved in atomic batches of 200. Resources and pages are separate
canonical transactions. A failed run may have saved earlier operations. Correct
the cause, then rerun the same bundle; product/resource replacements are
idempotent and existing pages are verified instead of recreated.

## Platform catalog prerequisite

Run `node scripts/check-platform-locale-catalog.ts --locale th` against the exact
release. Platform interface catalogs ship with the application, so the deployed
`i18n/catalogs/th.json` is the Thai catalog used in every environment.

The account must have Better Auth platform content permission. A 403 is an
access failure to resolve through the normal admin workflow, not permission to
patch auth tables. Platform admin access by itself does not grant tenant access.

The order is **add → publish the bundle → publish the language**, and it is not
interchangeable. Adding the language through the site's language settings
creates it `disabled`: writable, and invisible to the public. Publish the bundle
into it. Only then publish the language. Publication requires a translated
homepage; Legal Services sites also require the translated organization name
and consultation call-to-action label. Other missing translations remain
unavailable rather than falling back to source-language content. Translating
the complete bundle is this client delivery's requirement, not a platform
publication gate. Every plan supports manually authored translations in every
supported language without a translation-count limit.

Adding used to publish in the same step, so the moment a language was picked the
site served that prefix with nothing in it — and a locale shows exactly what has
been translated into it, so every one of those routes 404'd. While the bundle is
going in, read the language through the site's preview token; without it the
prefix is correctly not found.

## Authorize, preflight, publish

The publisher uses the normal Better Auth OAuth authorization-code flow with
PKCE. It requests tenant access only, never platform-admin scope. The metadata
document must be served as JSON and contain its exact URL as `client_id`.
The public metadata route derives that URL from the requested environment;
raw GitHub text URLs are rejected by the provider.

After this change deploys to the target environment:

```sh
node scripts/client-localization.mjs --auth \
  --base-url https://staging.krabiclaw.com \
  --client-id https://staging.krabiclaw.com/oauth-clients/client-localization.json \
  --token-file /tmp/kikuzuki-staging-oauth.json
```

Open the printed URL in a browser, sign in as the authorized Kikuzuki tenant
member, and approve the displayed consent. The loopback callback saves the
short-lived token locally with mode 0600. No refresh token is requested.

```sh
node scripts/client-localization.mjs \
  --base-url https://staging.krabiclaw.com \
  --token-file /tmp/kikuzuki-staging-oauth.json \
  --bundle client-imports/kikuzuki/localization/staging.json
```

Without `--apply`, this is read-only preflight: it requires an exact catalog ID
set and matching English product names/descriptions. Add `--apply` to publish,
or `--verify` to check persisted content without writes. An expired token
requires another normal authorization.

## Delivery evidence

Verify Kikuzuki on its staging alias and, after the user's staging-to-main PR,
on its production custom domain. Use a fresh browser session. Check:

1. The English footer visibly offers Thai, and selecting it opens `/th`.
2. `/th`, `/th/about`, `/th/contact`, `/th/menu`, both localized location pages,
   their menu/detail routes, and the teppanyaki experience load in Thai.
3. Every source menu product has the exact translated name and description,
   category, options, and SEO fields where configured. Counts must match
   the target environment's source catalog.
4. Switching back to English, following internal links, and reloading preserve
   correct locale behavior. Canonical and alternate URLs match the language.
5. Existing `client:verify` passes and generates `client-handoff.md`. Record
   browser evidence separately; a successful API write alone is not delivery.

Preserve the bundle and verification output across the staging-to-main release.
Never claim production is translated based on a preview or staging run.
