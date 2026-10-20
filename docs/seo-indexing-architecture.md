# SEO indexing architecture

KrabiClaw serves the platform application and many tenant websites from one Nuxt deployment. The file-based route tree is therefore not an SEO inventory. A route existing under `pages/` does not make it eligible for crawling or indexing.

This document defines the permanent indexing contract.

## Host classes

### Production platform

`https://krabiclaw.com` and its canonical `www` redirect expose KrabiClaw marketing content, platform documentation, and platform blog content.

The platform sitemap is an explicit allowlist plus published platform docs and blog records. Admin, dashboard, authentication, OAuth, billing workflow, setup, preview, developer, and tenant-only routes are excluded.

### Production tenant

A tenant is served from its configured canonical custom domain or canonical KrabiClaw subdomain. Alternate active domains are redirected to the canonical domain before rendering.

The tenant sitemap contains only that site's public static routes and its published locations, menu items, blog posts, listed social posts, and experiences. Aggregate routes such as `/menu`, `/blog`, `/posts`, `/experiences`, `/locations`, `/reservations`, and `/order` are included only when the tenant has corresponding substantive content. It never contains KrabiClaw platform docs, pricing, templates, or application routes.

`server/middleware/zy-site-config.ts` updates Nuxt Site Config only for `/sitemap.xml` and `/robots.txt`, after tenant resolution. This gives the Nuxt SEO modules the active tenant origin and brand without touching page or API request state.

Tenant canonical tags and breadcrumb/schema URLs resolve against the rendered request origin. Because noncanonical tenant domains redirect first, the request origin is the canonical origin.

### Non-production and demo hosts

Staging, `pages.dev`, `workers.dev`, and demo showcase hosts (`demo.krabiclaw.com`, `demo.localhost`) and the demo organizations named in `shared/demo.ts` by subdomain (`demo`, `saltleaf-stays-demo`) are globally non-indexable.

These hosts receive:

- `X-Robots-Tag: noindex, nofollow, noarchive`;
- `robots.txt` with `Disallow: /`;
- an empty sitemap;
- runtime Site Config with `indexable: false` on the SEO endpoints.

The `public/_headers` rule remains a deployment-provider fallback for Pages previews. Runtime middleware is authoritative for Worker custom domains.

## Source of truth

Route classifications live in `server/utils/seo-policy.ts`.

- `PLATFORM_SITEMAP_ROUTES` is the platform static allowlist.
- `PRIVATE_ROUTE_PREFIXES` and `PRIVATE_EXACT_ROUTES` define non-content application surfaces.
- `TENANT_ONLY_EXACT_ROUTES` and `TENANT_ONLY_ROUTE_PREFIXES` define routes that must return 404 on the platform host.
- `isNonIndexableHost()` defines deployment hosts that must never be indexed.
- `resolveRuntimeSeoConfig()` defines the canonical Site Config for platform, tenant, and non-production SEO endpoint requests.

The same classifications are consumed by runtime middleware, sitemap generation, route boundaries, and tests. Do not duplicate route lists in page components.

## Sitemap contract

`@nuxtjs/sitemap` serves the canonical `/sitemap.xml` endpoint. Its configuration in `nuxt.config.ts` sets `excludeAppSources: true`, disabling every automatic page, route-rule, prerender, and content source.

`server/plugins/sitemap.ts` owns the complete URL inventory through the module's `sitemap:input` Nitro hook. The hook runs on the original sitemap request event, preserving the resolved host, tenant context, and Cloudflare database bindings. Runtime endpoint sources are cleared in `sitemap:sources`; synthetic self-fetch endpoints are not used.

The hook queries only records that are:

- published or active;
- owned by the current tenant when applicable;
- not marked with a robots value containing `noindex`.

Runtime Site Config supplies the canonical platform or tenant origin used to turn relative entries into absolute sitemap URLs.

Runtime sitemap caching is disabled because every hostname uses the same `/sitemap.xml` path. This prevents any server-side or shared-cache key from reusing one tenant's URL inventory for another host.

Documentation is KrabiClaw's `docs` article collection. A category's landing article (slug equal to the category segment) is published at `/docs/{category}` rather than the duplicate `/docs/{category}/{category}` form.

Non-production requests clear the complete URL list. New routes cannot enter a sitemap merely by adding a Vue file.

## Robots and response headers

`@nuxtjs/robots` publishes crawler guidance from the explicit groups in `nuxt.config.ts`. Runtime Site Config sets `indexable: false` on non-production `/robots.txt` requests, causing the module to publish `Disallow: /` there. Robots exclusions conserve crawl activity but are not treated as an indexing control.

`server/middleware/seo-indexing.ts` is the indexing control. It applies `X-Robots-Tag` to every private route family and every non-production host, including responses that do not render a Vue page.

Private routes also receive `Cache-Control: private, no-store, max-age=0`.

Individual page-level `robots` metadata may be retained for defense in depth, but it must not be the only protection for an application route family.

## Canonicals

Every public page uses `useSocialMetadata()` for its canonical and social metadata.

Tenant pages receive a canonical link from `layouts/saya.vue`. The canonical strips query parameters by using `route.path` and resolves against the current request origin.

Do not use `runtimeConfig.public.siteUrl` for tenant canonical, Open Graph, breadcrumb, structured-data, or sitemap URLs. That value is the platform origin.

## Generated-card consistency

Content and media writes are authoritative. Automatic social-card refresh runs after commit as a best-effort derived projection. A refresh failure leaves the last generated card in place, emits structured `[social-card]` telemetry, and does not change the successful primary-write response.

Operators retry failed projections through the tenant or platform regeneration action. Manual regeneration reports generated, reused, skipped, and failed counts instead of converting a partial failure into an unconditional success.

## Route behavior

Tenant-only routes return an intentional 404 on the platform host through `server/middleware/tenant-routing.ts`. They must never render generic `Our Site`, loading, or empty-state content on `krabiclaw.com`.

`/billing` is a legacy duplicate and permanently redirects to `/pricing`. It is intentionally crawlable so search engines can process the redirect, but it is never emitted in a sitemap.

Confirmation, cancellation, invitation, password, OAuth, dashboard, preview, and setup routes are never indexable even when directly accessible.

## Adding a public platform route

1. Build the page with server-rendered primary content.
2. Add canonical, title, and description through `useSocialMetadata()`.
3. Add the route to `PLATFORM_SITEMAP_ROUTES` only when it should appear in search results.
4. Add or update regression tests.
5. Do not enable automatic Nuxt route discovery for the sitemap.

## Adding a tenant route

1. Ensure the route requires a resolved tenant/site.
2. Add page-specific canonical and social metadata through `useSocialMetadata()`. The composer uses the persisted owner card, site card, social sharing image, or logo supplied by the public payload.
3. Add the platform-host route classification when the path is tenant-only.
4. Add the route to `server/plugins/sitemap.ts` only when it has durable public search value and can avoid empty/thin output.
5. Query and filter tenant-owned records explicitly.

## Verification

The unit suite verifies the static allowlist, private route classification, tenant-only boundaries, runtime Site Config, and non-production hosts.

The PR smoke suite verifies:

- production-style `robots.txt` advertises the canonical sitemap;
- sitemaps contain no private route families;
- non-production hosts return global noindex controls and an empty sitemap;
- tenant pages emit tenant-origin canonicals and schema URLs;
- tenant-only platform requests return 404;
- `/billing` redirects permanently to `/pricing`.

When Search Console reports old URLs after deployment, validate the live response first. Historical “discovered” URLs can remain in reports after they have been removed from current discovery paths.
