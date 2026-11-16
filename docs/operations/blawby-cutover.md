# Blawby apex cutover (#1869)

This is the production operator handoff for [#1869](https://github.com/krabiclaw/krabiclaw/issues/1869).
Staging runs at `https://staging.krabiclaw.com` with its existing aliases and
media path. No production route, secret, zone, redirect, directory review,
registry version or CMS operation is activated by the staging release.

## Before the change

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

## Production-only source edits

Prepare one reviewed cutover diff for the normal staging to main promotion.
Use the existing release jobs and `wrangler deploy --strict`.

| File or setting | Exact production change |
| --- | --- |
| `wrangler.toml` top-level routes | Append `[[routes]]` with `pattern = "blawby.com/*"` and `zone_name = "blawby.com"`. Preserve all old route blocks and do not add a www Worker route. |
| `wrangler.toml` top-level vars | Set `BETTER_AUTH_URL`, `NUXT_PUBLIC_PLATFORM_DOMAIN`, and `NUXT_PUBLIC_SITE_URL` to `https://blawby.com`; `NUXT_PUBLIC_HELP_URL` to `https://blawby.com/help`; `NUXT_PUBLIC_APP_NAME` to `Blawby`; `EMAIL_FROM` to `Blawby <hello@krabiclaw.com>`. Keep `EMAIL_REPLY_DOMAIN=reply.krabiclaw.com`, free domain, media URL, SaaS zone/token/target, IDs, database and signing secrets. |
| Zaraz | Add top-level `CF_PLATFORM_ZARAZ_ZONE_ID` with the verified Blawby zone ID. Set the production Worker secret `CLOUDFLARE_API_TOKEN` to the dedicated Zone Zaraz Write credential for exactly these two zones. Leave the separate CI deploy secret and SaaS hostname token alone. Verify Blawby Zaraz is active and auto-injects; the existing Live-status settings write reconciles and reads back both zones when the binding is present. |
| `.github/workflows/ci.yml` | In the production build and verify jobs only, change platform/site/auth origins to `https://blawby.com`, help to `https://blawby.com/help`, app name to Blawby, and the verify job's `PLAYWRIGHT_PREVIEW_URL` and platform convergence host to `https://blawby.com`. Preserve the facility, custom-domain and staging hosts and the free organization domain. |
| `.github/workflows/prod-real-send-canaries.yml` | Change the platform URL loop to `https://blawby.com/` and `https://blawby.com/blog` and their expected origin to `https://blawby.com`. Set the existing production `CANARY_BASE_URL` to the new apex when verification starts. |
| `package.json` | Change only the `--base-url` in `ai-search:sync:prod`, `ai-search:status:prod` and `test:mcp:prod` to `https://blawby.com`. Preserve the AI Search binding and index identity. |
| OpenAI files | Change the reviewed image fixture URL in `scripts/generate-chatgpt-app-submission.mjs` to `https://blawby.com/templates/saya-preview.jpg`. Regenerate and check with `yarn chatgpt:submission:write` / `yarn chatgpt:submission:check`, and run `yarn mcp:catalog`. Move the existing `public/.well-known/openai-apps-challenge` response out of static assets into the exact-path GET route at `server/routes/.well-known/openai-apps-challenge.get.ts`. Capture the response's actual bytes, MIME and cache directive before removing the static asset. The handler switches on `event.url.hostname`: return only the saved old bytes for `krabiclaw.com`, the replacement draft's exact bytes for `blawby.com`, and 404 for other hosts; preserve MIME and cache policy. Verify each host directly before touching either review. |
| Production content checks | Update deployed platform assertions to match the final published titles and headlines (including the retained `/docs/create-your-krabiclaw-account` slug). Keep all customer smoke URLs. |

Do not use this change to move D1 bindings, customer domains or the app
bundle/scheme. No signing key rotation. The old apex remains a trusted origin
via the free organization domain. MCP validates the current auth origin and
audience; the old MCP endpoint declines the old connection without a redirect.

## Edge cutover and hold points

1. Confirm the new Worker route and TLS are ready. In Blawby Pages detach only
   the legacy apex. Replace the proxied apex and www CNAMEs with proxied A
   records to `192.0.2.0` (Auto TTL). Under Single Redirects on Blawby, match
   `http.host eq "www.blawby.com"`, use dynamic target
   `concat("https://blawby.com", http.request.uri.path)`, preserve query
   string, and verify both hostnames. Keep other DNS records and TLS intact.
2. Deploy and wait for the production build asset ID to converge. After the
   zone and runtime token are active, call `update_organization_settings` on
   `platform` with `name: "Blawby"` and the existing Live status
   (`status: "active"` in the MCP schema). This preserves the subdomain and
   invokes the existing Zaraz reconciliation. Read the unchanged domain
   rows and both zones' reconciled configuration back before proceeding. Run the
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
   delivery with consent denied. Run the existing platform-only AI Search
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

After the production pass, update the existing Claude submission in its full
editor and read back both tabs. For OpenAI, validate the scan and credentials
on the replacement draft using the regenerated package and prior
[review fixtures](../chatgpt-resubmission.md). When it is ready to submit and
both challenges pass, cancel the old pending review, then submit the new
draft. Publish only an approved Blawby listing. The staging work does not
change either review.

For the MCP Registry, derive the descriptor from the saved response with:

```sh
jq '.server | .title = "Blawby" | .version = "1.0.1" |
    .websiteUrl = "https://blawby.com" |
    .remotes[0].url = "https://blawby.com/api/mcp"' mcp-registry-1.0.0.json > server.json
```

Check in the reviewed descriptor and a manual `workflow_dispatch` job at the
cutover commit. Scope permissions to the publish job (`contents: read`,
`id-token: write`), use the `production` environment, and restrict the job to
the reviewed commit on main. Use the repository's pinned checkout action with
credentials persistence disabled. On the Ubuntu x64 runner use the official
[v1.8.1 release files](https://github.com/modelcontextprotocol/registry/releases/tag/v1.8.1):

```sh
release=https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1
archive=mcp-publisher_linux_amd64.tar.gz
curl -fsSLO "$release/$archive"
curl -fsSLO "$release/registry_1.8.1_checksums.txt"
grep " $archive\$" registry_1.8.1_checksums.txt | sha256sum -c -
printf '%s  %s\n' a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc "$archive" | sha256sum -c -
tar -xzf "$archive" mcp-publisher
./mcp-publisher login github-oidc
./mcp-publisher publish server.json
```

Read the latest version through the public registry API before promoting any
installs. Record the reviewed SHA, deployment ID, test receipts, both review
statuses and registry readback in the issue. Keep the issue open until the
owner schedules the remaining work.

## Rollback

Disable the old-apex redirects and pause submissions/publishing. Restore the
saved production Worker version through Cloudflare deployment history. If the
new apex must serve legacy Pages again, remove its Worker route and new edge
redirect, restore both proxied CNAMEs and reattach the old Pages apex. Restore
the saved Zaraz configurations and affected provider/canary display URLs;
restore CMS values through the same editors, using current revisions and the
saved asset IDs. The old delivery endpoints and D1/R2 remain in place.

If any directory pointer already moved, restore the Claude listing after the
old endpoint passes. OpenAI's canceled review slot cannot be restored; leave
the replacement unpublished and use the archived old package only if the
owner chooses to re-enter review. A published registry change is reversed by
publishing 1.0.2 on the same identity with the old endpoint metadata once it
passes. Reverse a submitted Search Console move only once old routing has
been restored.
