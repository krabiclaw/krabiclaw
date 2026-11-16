# Blawby apex cutover (#1869)

This is the production operator handoff for [#1869](https://github.com/krabiclaw/krabiclaw/issues/1869).
Staging runs at `https://staging.krabiclaw.com` with its existing aliases and
media path. No production route, secret, zone, redirect, directory review,
registry version or CMS operation is activated by the staging release.

## Before the change

- Qualify and deploy the bounded brand-name refresh on KrabiClaw first. Save
  that verified Worker as the rollback version so pending refreshes can keep
  running after a traffic rollback.
- Verify Bot Fight Mode is off in the Blawby zone. From a GitHub-hosted runner,
  confirm the home page returns Pages HTML and the Nuxt build URL returns an
  ordinary Pages 404 before the switch. Neither response may carry
  `cf-mitigated: challenge`. After the switch, verify the exact expected
  Nuxt build JSON on the Worker.
- Complete the staging rollout and record the tested SHA, deployed build ID,
  actual tenant and credentialed MCP results. In the authorized window, save
  the active `krabiclaw` Worker version, source SHA, DNS/route/rule state from
  both zones, the Blawby Pages apex association, both Zaraz configurations,
  provider settings, the original OpenAI and Claude review materials and the
  [registry 1.0.0 server document](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.krabiclaw%2Fkrabiclaw/versions/1.0.0).
  Use private storage for credentials, snapshots and reviewer accounts.
- Apply the additive Cloudflare deploy token policy and provider allowlists in
  #1869. Use the same Google web client, Meta app, Apple Services ID and
  Discord app; retain every current callback and verified Stripe, Resend,
  WhatsApp and Channex endpoint. The Instagram callback includes
  `/api/auth/oauth2/callback/instagram`. There is no Google Calendar inbound
  watch to renew: change ingestion was retired in
  [8093d7cc0](https://github.com/krabiclaw/krabiclaw/commit/8093d7cc02a9a39d94e9b64d83e8d1c189a608be).
  Check live busy reads and the existing one-way booking event flow.
- Read the production `platform` organization and its pages, articles,
  locales, Q&A and media with the authorized owner connection. Save full
  pre-write values and revisions. Apply the approved Blawby copy and existing
  mark through organization, page, article, block and media operations.
  Keep resource identities, status, order, slugs, old contacts and contract
  terms. Reverify pricing against the current offer and workflow screenshots
  against the actual UI. Production has content staging does not have;
  obtain its own fresh revisions and never import the staging CMS snapshot.
- Prepare the replacement OpenAI draft at the authorized point in the
  window to obtain its new challenge. Keep the existing review untouched
  until the new origin and both challenges have passed.
  Set the production Actions environment secret `OPENAI_APPS_CHALLENGE_BLAWBY_B64`
  to the base64 encoding of the exact public bytes assigned by the new draft,
  including any final newline.

## Production-only source edits

Qualify the reviewed cutover diff through staging before the normal
staging to main promotion. The production release job uses `wrangler deploy
--strict` with a temporary JSON secrets file. The existing CI token authorizes
the deploy. Set production environment secret `BLAWBY_ZARAZ_RUNTIME_API_TOKEN`
to the dedicated two-zone credential, which the job binds as the Worker’s
`CLOUDFLARE_API_TOKEN` in the same deployment.

| File or setting | Exact production change |
| --- | --- |
| `wrangler.toml` top-level routes | Append `[[routes]]` with `pattern = "blawby.com/*"` and `zone_name = "blawby.com"`. Preserve all old route blocks and do not add a www Worker route. |
| `wrangler.toml` top-level vars | Set `BETTER_AUTH_URL`, `NUXT_PUBLIC_PLATFORM_DOMAIN`, and `NUXT_PUBLIC_SITE_URL` to `https://blawby.com`; `NUXT_PUBLIC_HELP_URL` to `https://blawby.com/help`; `NUXT_PUBLIC_APP_NAME` to `Blawby`; `EMAIL_FROM` to `Blawby <hello@krabiclaw.com>`. Keep `EMAIL_REPLY_DOMAIN=reply.krabiclaw.com`, free domain, media URL, SaaS zone/token/target, IDs, database and signing secrets. |
| Zaraz | `CF_PLATFORM_ZARAZ_ZONE_ID` is the verified Blawby zone. Supply `BLAWBY_ZARAZ_RUNTIME_API_TOKEN` with Zone Zaraz Write for both zones as a production Actions environment secret. CI binds it under the existing Worker token name. |
| `.github/workflows/ci.yml` | In the production build and verify jobs only, change platform/site/auth origins to `https://blawby.com`, help to `https://blawby.com/help`, app name to Blawby, and the verify job's `PLAYWRIGHT_PREVIEW_URL` and platform convergence host to `https://blawby.com`. Preserve the facility, custom-domain and staging hosts and the free organization domain. |
| `.github/workflows/prod-real-send-canaries.yml` | Change the platform URL loop to `https://blawby.com/` and `https://blawby.com/blog` and their expected origin to `https://blawby.com`. Set the existing production `CANARY_BASE_URL` to the new apex when verification starts. |
| `package.json` | Change only the `--base-url` in `ai-search:sync:prod`, `ai-search:status:prod` and `test:mcp:prod` to `https://blawby.com`. Preserve the AI Search binding and index identity. |
| OpenAI files | The fixture is `https://blawby.com/templates/saya-preview.jpg`. The host-specific challenge route preserves the old apex and staging response and decodes the new draft's bytes for Blawby. |
| Production content checks | CI checks routes and actual served editorial data before or after the CMS write. Check the exact new headlines and guide titles after applying the content manifest. |

At deploy, the old apex redirects browser visits to login, signup, forgot
password, the dashboard and invitation entry onto the distinct auth origin.
The redirect keeps the raw path and query so the new origin starts Better Auth
OAuth and owns the state cookie. Verify a bookmarked old login and an old
invitation through provider OAuth. Keep API requests, existing callbacks,
native returns, and signed token-consumption routes direct. These browser
entry redirects are separate from the later public SEO redirects.

Do not use this change to move D1 bindings, customer domains or the app
bundle/scheme. No signing key rotation. The old apex remains a trusted origin
via the free organization domain. MCP validates the current auth origin and
audience; the old MCP endpoint declines the old connection without a redirect.

## Edge cutover and hold points

1. Confirm CI token access, both production runtime inputs, TLS and the
   absence of a competing apex route. In Pages project
   `blawby-marketing-frontend`, detach only the apex. Replace the proxied
   apex and www CNAMEs pointing to `blawby-cloudflare-marketing.pages.dev`
   with proxied A records to `192.0.2.0` (Auto TTL). At the top of Blawby
   Single Redirects, match `http.host eq "www.blawby.com"` with dynamic target
   `concat("https://blawby.com", http.request.uri.path)` and preserve query.
   Read back the edge records and rule before merging the approved promotion.
   CI creates the exact apex Worker route. If the strict deploy fails, inspect
   the version serving traffic immediately and roll back if it advanced.
2. Deploy and wait for the production build asset ID to converge. After the
   zone and runtime token are active, enable Blawby Zaraz and confirm
   auto-injection. Require `realtime` from
   `GET /zones/{zone_id}/settings/zaraz/workflow` before writing the name.
   Confirm that the platform has its
   linked GA4 property and existing GA4 event action. Call `update_organization_settings` on
   `platform` with `name: "Blawby"` and the existing Live status
   (`status: "active"` in the MCP schema). This preserves the subdomain and
   invokes the existing Zaraz reconciliation. Read the unchanged domain
   rows and both zones' reconciled configuration back before proceeding.
   Record the refresh ID returned with the saved name. In Website → Brand →
   Name, finish the refresh for that organization. Read the same refresh ID
   as complete through `get_organization_settings`. Compare each active
   placement against the pre-write owner and generation-key snapshot, then
   fetch the resulting card images and verify their PNG dimensions before
   releasing redirects or updating directory records. Run the
   existing deployed tenant and platform projects and credentialed
   `node scripts/test-mcp-oauth.mjs --base-url https://blawby.com` with
   `MCP_CREDENTIAL_LOGIN=1`, the authorized production canary credentials
   and `MCP_CIMD_CLIENT_URL=https://staging.krabiclaw.com/api/auth/oauth2/test-client-metadata`.
   The existing fixture document is public on staging; the authorization,
   token, issuer and resource tests still go to Blawby. Check real
   ChatGPT and Claude in fresh sessions using the controlled reviewer tenant,
   including wrong-tenant refusal and comparison to the catalog. Complete the
   browser/native, provider, signed-link, Stripe test, Resend, WhatsApp, iCal
   and tenant canaries from #1869; validate Stripe/Resend writes through the
   persisted product surface. Verify both Zaraz consent choices on Blawby and
   the existing NCLS integration, including one accepted pageview and no GA4
   delivery with consent denied, plus one ordinary event and the product and
   checkout ecommerce handoffs. Run the existing platform-only AI Search
   sync after CMS and build convergence and query help search on Blawby.
3. Activate redirects on the **exact old apex only** after the preceding
   checks. Export its pre-cutover sitemap and enumerate the public paths
   already in `server/middleware/zz-redirects.ts`, including public aliases
   and the existing blog/docs Markdown mirrors. Include `/llms.txt`,
   `/llms-full.txt`, `/pricing.md`, the blog feeds/indices, and the generated
   sitemap when each has a matching result on the new site. Enumerate actual
   public article and post paths. A public URL is eligible only if it has a
   matching Blawby route; retain `/changelog` as 410.
   In Cloudflare Single Redirects use one rule or split the same exact list
   across rules if needed:
   `http.host eq "krabiclaw.com" and http.request.method in {"GET" "HEAD"} and http.request.uri.path in {...}`.
   Target `concat("https://blawby.com", http.request.uri.path)` and enable
   preserve query string. Enable at 302 first. Check protected paths and each
   old site’s behavior before changing to 301. Omit auth, dashboard, signed
   invite/guest/booking/change/payment routes, `/app/return/**`, `/api/**`,
   `/.well-known/**`, service worker, manifest, assets, media and every
   customer hostname. Never blanket-match a prefix that contains public and
   signed paths. Submit Search Console Change of Address only after the 301s
   and the new sitemap pass.

## Directory handoff

Use the [1024px Blawby logo](../marketing/directory-assets/blawby-logo-1024.png)
derived from [the SVG master](../../public/platform/blawby.svg). Its three
mark paths come from the [pinned former Blawby site source](https://github.com/Blawby/blawby-cloudflare-marketing/blob/2da0d89ddd81be0b314d51d2795d012d9ad030be/src/components/logo.tsx).
Retain the old directory artwork and icon URLs for rollback and existing clients.

After the production pass, update the existing Claude submission in its full
editor and read back both tabs. For OpenAI, validate the scan and credentials
on the replacement draft using the regenerated package and prior
[review fixtures](../chatgpt-resubmission.md). When it is ready to submit and
both challenges pass, cancel the old pending review, then submit the new
draft. Publish only an approved Blawby listing. The staging work does not
change either review.

The reviewed `server.json` updates the existing Registry identity to Blawby
version 1.0.1. Dispatch **Publish MCP Registry** on `main` at the approved
production SHA after the website and both clients pass. The workflow probes
the descriptor’s issuer and resource, checks the official v1.8.1 publisher
checksum, and publishes with GitHub OIDC. Read back the public Registry entry
before enabling installs. Record the release and test receipts in the issue.

## Rollback

Disable the old-apex redirects and pause submissions/publishing. Restore the
saved production Worker version through Cloudflare deployment history. If the
new apex must serve legacy Pages again, remove its Worker route and new edge
redirect, restore both proxied CNAMEs and reattach the old Pages apex. Restore
the saved Zaraz configurations and affected provider/canary display URLs;
restore CMS values through the same editors, using current revisions and prior editable logo, favicon, social share and
cover asset IDs. Finish the restored name's refresh in Website → Brand →
Name and verify its receipt and active cards. The old delivery endpoints and
D1/R2 remain in place.

If any directory pointer already moved, restore the Claude listing after the
old endpoint passes. OpenAI's canceled review slot cannot be restored; leave
the replacement unpublished and use the archived old package only if the
owner chooses to re-enter review. A published registry change is reversed by
restoring the old website via native rollback and the normal fix-forward
release. Retain the Registry workflow with a reviewed 1.0.2 descriptor naming
the old canonical issuer and resource. Dispatch from the reviewed restored
main SHA after both discovery URLs pass. Reverse a submitted Search Console move only once old routing has
been restored.
