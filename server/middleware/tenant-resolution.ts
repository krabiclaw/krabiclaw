// Tenant resolution middleware: every host, KrabiClaw's own included, resolves
// to an organization. The organization's template decides whether it renders as
// the platform (marketing, docs, blog) or as a customer site.

import { HTTPError, defineHandler  } from 'nitro';
import type { H3Event } from 'nitro';
import { redirect } from 'nitro/h3';
import { queryFirst, type DbClient } from "~/server/db";
import { TENANT_TYPES } from "~/utils/tenant-routing";
import { cloudflareEnv, isInternalSelfFetch } from "../utils/api-response";
import {
  environmentTenantAliasSlug,
  hostnameOf,
  isPlatformHost,
  usesTenantHeader,
} from "../utils/tenant-hosts";
import { previewSecretOf, resolvePreviewAuthorization } from "../utils/preview-token";
import { PLATFORM_TEMPLATE, resolvePublicTemplate } from "~/utils/template-registry";
import { organizationSocialMediaFromJson } from '~/server/utils/public-social-image'
import { resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { parseSitePalette, resolveSitePalette } from '~/shared/site-palette'
import { parseSiteRecipe } from '~/shared/site-recipe'
import { LOGO_SLOTS, ORIGINAL_LOGO_PRESENTATION, parseLogoPresentation, type SiteLogo } from '~/shared/media-placement-contract'
import { BROWSER_ERROR_PATH } from '~/shared/error-telemetry'

interface TenantRow {
  id: string;
  theme_id: string | null;
  subdomain: string;
  status: string;
  onboarding_status: string;
  canonical_domain: string | null;
  name: string;
  brand_description: string | null;
  media_json: string;
  vertical: string | null;
  facebook_page_id: string | null;
  instagram_username: string | null;
  privacy_policy: number;
  terms_policy: number;
  font_preset: unknown;
  font_preset_type: string | null;
  palette: string | null;
  button_shape: string | null;
  button_casing: string | null;
  button_color: string | null;
  heading_casing: string | null;
}

const TENANT_MEDIA_SELECT_SQL = `(SELECT COALESCE(json_group_array(json_object(
  'asset_id', ordered.asset_id, 'slot', ordered.slot, 'public_url', ordered.public_url,
  'thumbnail_url', ordered.thumbnail_url, 'kind', ordered.kind, 'mime_type', ordered.mime_type,
  'width', ordered.width, 'height', ordered.height, 'presentation', json(ordered.presentation_json)
)), json('[]')) FROM (
  SELECT mp.asset_id, mp.slot, ma.public_url, ma.thumbnail_url, ma.kind, ma.mime_type, ma.width, ma.height, mp.presentation_json, mp.id
  FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
  WHERE mp.organization_id = o.id AND mp.owner_type = 'organization' AND mp.owner_id = o.id AND mp.status = 'active'
  ORDER BY mp.slot, mp.sort_order, mp.id
) ordered)`

const TENANT_SELECT_SQL = `SELECT o.id, o.theme_id, o.subdomain, o.status, o.onboarding_status,
             o.name, o.brand_description, ${TENANT_MEDIA_SELECT_SQL} AS media_json, o.vertical,
             (SELECT i.target_id FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'facebook') AS facebook_page_id,
             (SELECT i.target_name FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'instagram') AS instagram_username,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/privacy') AS privacy_policy,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/terms') AS terms_policy,
             o.settings_json ->> '$.config.font_preset' AS font_preset,
             json_type(o.settings_json, '$.config.font_preset') AS font_preset_type,
             o.settings_json ->> '$.config.palette' AS palette,
             o.settings_json ->> '$.config.button_shape' AS button_shape,
             o.settings_json ->> '$.config.button_casing' AS button_casing,
             o.settings_json ->> '$.config.button_color' AS button_color,
             o.settings_json ->> '$.config.heading_casing' AS heading_casing`

// KrabiClaw's own tenant is the one active organization running the platform
// template. Platform hosts differ per environment (localhost, staging, the
// apex), so the host itself is not the key; the template is.
async function resolvePlatformTenant(db: DbClient): Promise<TenantRow | null> {
  return await queryFirst<TenantRow>(
    db,
    `
      ${TENANT_SELECT_SQL},
             canonical.domain AS canonical_domain
      FROM organization o
      LEFT JOIN organization_domains canonical
        ON canonical.organization_id = o.id AND canonical.role = 'canonical' AND canonical.status = 'active'
      WHERE o.theme_id = ? AND o.status = 'active' AND o.onboarding_status = 'active'
      LIMIT 1
    `,
    [PLATFORM_TEMPLATE.themeId],
  )
}

function publicTenantMedia(tenant: Pick<TenantRow, 'media_json'>) {
  return organizationSocialMediaFromJson(tenant.media_json)
}

/** The site's logo and its optional dark-ground logo, each as its placement presents it. */
function siteLogos(mediaJson: string): SiteLogo[] {
  const placements = JSON.parse(mediaJson) as Array<{ slot: string; public_url: string | null; presentation: unknown }>
  return placements
    .filter(item => (LOGO_SLOTS as readonly string[]).includes(item.slot) && item.public_url)
    .map(item => ({
      slot: item.slot as SiteLogo['slot'],
      url: item.public_url!,
      presentation: item.presentation == null ? ORIGINAL_LOGO_PRESENTATION : parseLogoPresentation(item.presentation),
    }))
}

/** The profiles a site links to are the accounts connected in Integrations, and only those. */
function connectedSocialProfiles(tenant: Pick<TenantRow, 'facebook_page_id' | 'instagram_username'>) {
  return [
    ...(tenant.facebook_page_id ? [{ network: 'facebook' as const, url: `https://www.facebook.com/${encodeURIComponent(tenant.facebook_page_id)}` }] : []),
    ...(tenant.instagram_username ? [{ network: 'instagram' as const, url: `https://www.instagram.com/${encodeURIComponent(tenant.instagram_username)}/` }] : []),
  ]
}

export interface SpentSubdomainResolution {
  spent: true
  successorDomain: string | null
}

function isSpentSubdomainResolution(
  value: TenantRow | SpentSubdomainResolution,
): value is SpentSubdomainResolution {
  return 'spent' in value
}

function normalizedPath(pathname: string) {
  return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
}

function requireTenantMetadata(tenant: Pick<TenantRow, 'theme_id' | 'vertical' | 'name'>, source: string) {
  const themeId = tenant.theme_id?.trim()
  const vertical = tenant.vertical?.trim()
  const name = tenant.name?.trim()
  if (!themeId || !vertical || !name) {
    throw new HTTPError({
      statusCode: 500,
      statusMessage: `Tenant ${source} is missing canonical identity or template metadata`,
      data: { code: 'TENANT_METADATA_INCOMPLETE' },
    })
  }
  return { themeId, vertical, name }
}

async function resolveRegisteredSubdomainTenant(
  db: DbClient,
  tenantSlug: string,
): Promise<TenantRow | null> {
  return await queryFirst<TenantRow>(
    db,
    `
      ${TENANT_SELECT_SQL},
             canonical.domain AS canonical_domain
      FROM organization o
      JOIN organization_domains requested
        ON requested.organization_id = o.id
       AND requested.type = 'subdomain'
       AND requested.status = 'active'
      LEFT JOIN organization_domains canonical
        ON canonical.organization_id = o.id
       AND canonical.role = 'canonical'
       AND canonical.status = 'active'
      WHERE o.subdomain = ?
      LIMIT 1
    `,
    [tenantSlug],
  )
}

/**
 * The one place `organization.status` decides anything. A tenant is served
 * publicly only when it is Live and provisioning has finished; a Draft tenant,
 * or one still provisioning, is served to a holder of a valid preview token for
 * it — which is what "preview" means everywhere in this product: the real site,
 * on its real host, rendered by the real templates, with unpublished content
 * and no caching.
 *
 * `suspended` is KrabiClaw's own hold and is nobody's to look past, the owner's
 * preview token included.
 *
 * Returns false when the request may not see this tenant at all.
 */
async function authorizeTenant(event: H3Event, tenant: TenantRow): Promise<boolean> {
  if (tenant.status === 'suspended') {
    event.context.previewAuthorized = false
    return false
  }
  const previewSecret = previewSecretOf(cloudflareEnv(event))
  const authorized = await resolvePreviewAuthorization(event, tenant.id, previewSecret)
  event.context.previewAuthorized = authorized
  // A live site is public either way; the flag still travels, because preview
  // also means "show me the drafts" — an unpublished article on a site that is
  // already live is previewed the same way.
  return (tenant.status === 'active' && tenant.onboarding_status === 'active') || authorized
}

function setResolvedTenantContext(
  event: H3Event,
  tenant: TenantRow,
  host: string,
  canonicalDomain: string | null,
) {
  const metadata = requireTenantMetadata(tenant, tenant.id)
  const socialMedia = publicTenantMedia(tenant)
  const resolvedTemplate = resolvePublicTemplate({ themeId: metadata.themeId, vertical: metadata.vertical })
  const templateSlug = resolvedTemplate.slug
  const isPlatform = templateSlug === 'platform'
  const logos = siteLogos(tenant.media_json)
  const fontPreset = resolveOrganizationFontPreset(tenant.font_preset_type === null ? undefined : tenant.font_preset)
  const palette = !isPlatform
    ? resolveSitePalette(tenant.palette === null ? undefined : parseSitePalette(JSON.parse(tenant.palette)))
    : null
  const recipe = parseSiteRecipe(tenant)

  event.context.organizationId = tenant.id
  event.context.themeId = metadata.themeId
  event.context.tenantType = isPlatform ? TENANT_TYPES.PLATFORM : TENANT_TYPES.TENANT
  event.context.tenantHost = hostnameOf(host)
  event.context.canonicalDomain = canonicalDomain
  event.context.organization = {
    id: tenant.id,
    subdomain: tenant.subdomain,
    name: metadata.name,
    brand_description: tenant.brand_description,
    theme_id: metadata.themeId,
    vertical: metadata.vertical,
    template: resolvedTemplate,
    fontPreset,
    palette,
    recipe,
    logos,
    social_profiles: connectedSocialProfiles(tenant),
    policies: [
      ...(tenant.privacy_policy ? ['privacy' as const] : []),
      ...(tenant.terms_policy ? ['terms' as const] : []),
    ],
    ...socialMedia,
  }
}

const SESSION_SCOPED_API_PREFIXES = ["/api/dashboard", "/api/organizations", "/api/mcp", "/api/invite-links", "/api/integrations/channex"] as const;

export default defineHandler(async (event) => {
  // Nested self-fetches (i18n/icon/internal API calls during SSR) never carry
  // tenant context downstream handlers rely on — the real inbound request
  // already resolved tenant type/host before triggering these. Skip the DB
  // lookup and host parsing entirely rather than redoing it per phantom request.
  // Nuxt carries the resolved public organization in its native error payload.
  // Error rendering must not repeat the operation that produced the error.
  if (isInternalSelfFetch(event)) {
    return;
  }

  const url = event.url;
  const tenantPath = normalizedPath(url.pathname);
  // Diagnostics must still reach operational logs when tenant/D1 resolution fails.
  if (tenantPath === BROWSER_ERROR_PATH) return;
  if (tenantPath === "/api/auth" || tenantPath.startsWith("/api/auth/")) return;
  // The dashboard, organization, MCP and invite-link APIs are scoped by the session and the
  // organization the request names, never by the host. Resolving the platform
  // site for them cost every call its tenant row, its redirect lookups and the
  // preview check before authentication ran: six D1 statements and 100-190 ms
  // on a 401. Nothing on these paths reads the resolved tenant; the one shared
  // helper, resolvePublicOrigin, answers the platform origin without it.
  if (SESSION_SCOPED_API_PREFIXES.some(prefix => tenantPath === prefix || tenantPath.startsWith(`${prefix}/`))) return;
  // `/api/public/**` used to be skipped here because each of those routes
  // carried its own site id in the path. That id was a second answer to "which
  // tenant", arriving beside the host that already knew — and a route reachable
  // with one tenant's id on another tenant's domain. The id is gone and the
  // host is the only answer, so the public API resolves here like everything
  // else and reads `event.context.organizationId`.
  const host = (event.req.headers.get("host")) || "";
  const env = cloudflareEnv(event);

  // The local harness and the staging alias name the tenant explicitly.
  // An unresolvable selector must never become the platform's homepage.
  const previewSlug = usesTenantHeader(host) ? event.req.headers.get("x-preview-tenant") : null
  const aliasSlug = environmentTenantAliasSlug(host, env)
  const requestedSlug = previewSlug ?? aliasSlug
  const isPlatformRequest = requestedSlug === null && isPlatformHost(host, env)
  const tenant = requestedSlug !== null
    ? env.db && /^[a-z0-9-]+$/.test(requestedSlug)
      ? await resolveRegisteredSubdomainTenant(env.db, requestedSlug)
      : null
    : isPlatformRequest
      ? env.db ? await resolvePlatformTenant(env.db) : null
      : await resolveTenant(host, event)

  if (tenant && isSpentSubdomainResolution(tenant)) {
    if (tenant.successorDomain) {
      return redirect(`https://${tenant.successorDomain}${url.pathname}${url.search}`, 301)
    }
    throw new HTTPError({ statusCode: 410, statusMessage: 'Gone' })
  }

  if (tenant && await authorizeTenant(event, tenant)) {
    try {
      setResolvedTenantContext(event, tenant, host, requestedSlug !== null ? hostnameOf(host) : tenant.canonical_domain)
    } catch (error) {
      if (HTTPError.isError(error)) throw error
      throw new HTTPError({
        statusCode: 500,
        statusMessage: 'Tenant metadata is invalid',
        cause: error,
        data: { code: 'TENANT_METADATA_INVALID', reason: error instanceof Error ? error.message : String(error) },
      })
    }
    return
  }

  if (isPlatformRequest) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'No active organization runs the platform template', data: { code: 'PLATFORM_TENANT_MISSING' } })
  }
  throw new HTTPError({ statusCode: 404, statusMessage: 'Organization Not Found' })
});

export async function resolveTenant(
  host: string,
  event: Parameters<typeof cloudflareEnv>[0],
): Promise<TenantRow | SpentSubdomainResolution | null> {
  const runtimeEnv = cloudflareEnv(event);
  const db = runtimeEnv.db;
  const hostname = hostnameOf(host);

  if (!db || !hostname) return null;

  // Local development support (e.g., demo.localhost)
  if (hostname.includes(".localhost")) {
    const subdomain = hostname.split(".")[0];
    return await queryFirst<TenantRow>(
      db,
      `
      ${TENANT_SELECT_SQL},
             o.subdomain || '.localhost' AS canonical_domain
      FROM organization o
      WHERE o.subdomain = ?
      LIMIT 1
    `,
      [subdomain],
    );
  }

  const tenant = await queryFirst<TenantRow>(
    db,
    `
    ${TENANT_SELECT_SQL},
           COALESCE(canonical.domain, sd.domain) AS canonical_domain
    FROM organization o
    JOIN organization_domains sd ON o.id = sd.organization_id
    LEFT JOIN organization_domains canonical
      ON canonical.organization_id = o.id AND canonical.role = 'canonical' AND canonical.status = 'active'
    WHERE sd.domain = ? AND sd.type IN ('custom', 'subdomain') AND sd.status = 'active'
    LIMIT 1
  `,
    [hostname],
  )
  if (tenant) return tenant

  const spent = await queryFirst<{ successor_domain: string | null }>(
    db,
    "SELECT successor_domain FROM organization_domains WHERE domain = ? AND status = 'retired' LIMIT 1",
    [hostname],
  )
  return spent
    ? { spent: true, successorDomain: spent.successor_domain }
    : null
}
