import { HTTPError } from 'nitro'
import { organizationSupportsBlawbyTemplate, resolvePublicTemplate } from '~/utils/template-registry'
import { getPublicCompliance, getPublicConsultationSettings } from '~/server/utils/professional-services'
import { deleteConfig, getConfig, setConfig } from '~/server/utils/organization-config'
import { createSystemSubdomain, isSystemSubdomainSpent } from '~/server/utils/domains'
import { reconcileZarazAnalytics } from '~/server/utils/zaraz-analytics'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { ORGANIZATION_FONT_PRESETS, isOrganizationFontPreset, resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { purgeOrganizationCaches, purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import type { UpdateOrganizationSettingsRequest } from '~/server/types/organization'
import { integrationSummary, listIntegrations } from '~/server/utils/organization-integrations'
import { execute, executeBatch, queryFirst, type DbClient } from '~/server/db'
import { formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'
import { buildSingleMediaPlacementQueries, hydrateMediaAssetRefs, readMediaPlacements } from '~/server/utils/media-asset-manager'
import { applySitePalettePatch, isPaletteTemplate, resolveSitePalette } from '~/shared/site-palette'
import { LOGO_SLOTS, ORIGINAL_LOGO_PRESENTATION, parseLogoPresentation } from '~/shared/media-placement-contract'
import { refreshSocialCard } from '~/server/utils/social-card'
import { organizationAdapter } from '~/server/utils/member-access'
import type { CloudflareEnv } from '~/server/utils/auth'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

type SetupEnv = Parameters<typeof createSystemSubdomain>[0]

const MAX_SLUG_ATTEMPTS = 10

interface OrganizationSettingsRow {
  id: string
  status: string
  subdomain: string | null
  name: string | null
  vertical: string
  theme_id: string
}

interface FullOrganizationRow extends OrganizationSettingsRow {
  public_url: string | null
  custom_domain_status: string | null
  default_currency: CurrencyCode
  timezone: string
  brand_description: string | null
  announcement_json: string | null
  announcement_media_id: string | null
  announcement_public_url: string | null
  announcement_thumbnail_url: string | null
  announcement_kind: 'image' | 'video' | null
  favicon_media_id: string | null
  favicon_public_url: string | null
  favicon_thumbnail_url: string | null
  favicon_kind: 'image' | 'video' | null
  social_share_media_id: string | null
  social_share_public_url: string | null
  social_share_thumbnail_url: string | null
  social_share_kind: 'image' | 'video' | null
  contact_email: string | null
  seo_title: string | null
  seo_description: string | null
  canonical_url: string | null
  consultation_mode: 'native' | 'external_url' | 'native_disabled' | null
  created_at: string
  updated_at: string
}

export interface OrganizationSettingsUpdateResult {
  status: number
  data: Record<string, unknown>
}


function buildSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 30)
}

export async function loadSettingsPayload(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
) {
  const updatedOrganization = await queryFirst<FullOrganizationRow & { vertical: string; theme_id: string; locations_json: string }>(db, `
    SELECT organization.id, subdomain, organization.status,
           (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url, COALESCE((SELECT status FROM organization_domains WHERE organization_id = organization.id AND type = 'custom' AND status NOT IN ('deleted', 'disabled') ORDER BY role = 'canonical' DESC, created_at, id LIMIT 1), 'none') AS custom_domain_status, default_currency, timezone,
           name, brand_description,
           json_extract(organization.settings_json, '$.config.announcement') AS announcement_json,
           amp.asset_id AS announcement_media_id, ama.public_url AS announcement_public_url,
           ama.thumbnail_url AS announcement_thumbnail_url, ama.kind AS announcement_kind,
           fmp.asset_id AS favicon_media_id, fma.public_url AS favicon_public_url,
           fma.thumbnail_url AS favicon_thumbnail_url, fma.kind AS favicon_kind,
           smp.asset_id AS social_share_media_id, sma.public_url AS social_share_public_url,
           sma.thumbnail_url AS social_share_thumbnail_url, sma.kind AS social_share_kind,
           contact_email,
           seo_title, seo_description, canonical_url,
           CASE WHEN json_type(organization.consultation_settings_json) = 'object' THEN json_extract(organization.consultation_settings_json, '$.mode') END AS consultation_mode,
           strftime('%Y-%m-%dT%H:%M:%fZ', organization."createdAt", 'unixepoch') AS created_at, organization.updated_at,
           vertical, theme_id,
           (SELECT json_group_array(json_object('id', id, 'slug', slug, 'title', title, 'address', address,
                     'phone', phone, 'website_url', website_url, 'image', image,
                     'google_place_id', google_place_id, 'rating', rating, 'review_count', review_count,
                     'last_synced_at', last_synced_at))
              FROM (SELECT bl.*, COALESCE(hma.thumbnail_url, hma.public_url) AS image FROM business_locations bl
                      LEFT JOIN media_placements hmp ON hmp.owner_type = 'business_location' AND hmp.owner_id = bl.id
                        AND hmp.slot = 'hero' AND hmp.sort_order = 0 AND hmp.status = 'active'
                      LEFT JOIN media_assets hma ON hma.id = hmp.asset_id AND hma.status = 'active'
                     WHERE bl.organization_id = organization.id AND bl.status = 'active' ORDER BY bl.title, bl.id)) AS locations_json
    FROM organization
    LEFT JOIN media_placements amp ON amp.organization_id = organization.id AND amp.owner_type = 'organization'
      AND amp.owner_id = organization.id AND amp.slot = 'announcement' AND amp.sort_order = 0 AND amp.status = 'active'
    LEFT JOIN media_assets ama ON ama.id = amp.asset_id AND ama.status = 'active'
    LEFT JOIN media_placements fmp ON fmp.organization_id = organization.id AND fmp.owner_type = 'organization'
      AND fmp.owner_id = organization.id AND fmp.slot = 'favicon' AND fmp.sort_order = 0 AND fmp.status = 'active'
    LEFT JOIN media_assets fma ON fma.id = fmp.asset_id AND fma.status = 'active'
    LEFT JOIN media_placements smp ON smp.organization_id = organization.id AND smp.owner_type = 'organization'
      AND smp.owner_id = organization.id AND smp.slot = 'social_share' AND smp.sort_order = 0 AND smp.status = 'active'
    LEFT JOIN media_assets sma ON sma.id = smp.asset_id AND sma.status = 'active'
    WHERE organization.id = ?
    LIMIT 1
  `, [organizationId])

  if (!updatedOrganization) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  }

  const siteConfig = await getConfig(db, organizationId)
  const template = resolvePublicTemplate({ themeId: updatedOrganization.theme_id }).slug
  const [compliance, consultation] = organizationSupportsBlawbyTemplate({ vertical: updatedOrganization.vertical, themeId: updatedOrganization.theme_id })
    ? await Promise.all([getPublicCompliance(db, organizationId), getPublicConsultationSettings(db, organizationId)])
    : [null, null]
  // Both logos with their presentation, through the canonical placement reader.
  const logos = (await readMediaPlacements(db, { organizationId, ownerType: 'organization', ownerIds: [organizationId] }))
    .get(organizationId)!.filter(item => (LOGO_SLOTS as readonly string[]).includes(item.slot))

  return {
    id: updatedOrganization.id,
    subdomain: updatedOrganization.subdomain,
    theme: template,
    status: updatedOrganization.status,

    public_url: updatedOrganization.public_url ? tenantOrganizationOrigin({
      platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
      freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
      subdomain: updatedOrganization.subdomain ?? '',
      canonicalDomain: updatedOrganization.public_url,
    }) : null,
    custom_domain_status: updatedOrganization.custom_domain_status,
    name: updatedOrganization.name,
    brand_description: updatedOrganization.brand_description,
    announcement: updatedOrganization.announcement_json ? { format: 'modal', ...JSON.parse(updatedOrganization.announcement_json) } : null,
    media: [
      ...(updatedOrganization.announcement_media_id ? [{
        asset_id: updatedOrganization.announcement_media_id,
        slot: 'announcement',
        public_url: updatedOrganization.announcement_public_url,
        thumbnail_url: updatedOrganization.announcement_thumbnail_url,
        kind: updatedOrganization.announcement_kind,
      }] : []),
      ...logos.map(logo => ({
        asset_id: logo.asset_id,
        slot: logo.slot,
        public_url: logo.public_url,
        thumbnail_url: logo.thumbnail_url,
        kind: logo.kind,
        presentation: logo.presentation ?? ORIGINAL_LOGO_PRESENTATION,
      })),
      ...(updatedOrganization.favicon_media_id ? [{
        asset_id: updatedOrganization.favicon_media_id,
        slot: 'favicon',
        public_url: updatedOrganization.favicon_public_url,
        thumbnail_url: updatedOrganization.favicon_thumbnail_url,
        kind: updatedOrganization.favicon_kind,
      }] : []),
      ...(updatedOrganization.social_share_media_id ? [{
        asset_id: updatedOrganization.social_share_media_id,
        slot: 'social_share',
        public_url: updatedOrganization.social_share_public_url,
        thumbnail_url: updatedOrganization.social_share_thumbnail_url,
        kind: updatedOrganization.social_share_kind,
      }] : []),
    ],
    contact_email: updatedOrganization.contact_email,
    seo_title: updatedOrganization.seo_title,
    seo_description: updatedOrganization.seo_description,
    canonical_url: updatedOrganization.canonical_url,
    // The website's booking switch exists only where consultation settings do.
    consultation_mode: consultation?.mode ?? updatedOrganization.consultation_mode,
    ...(consultation ? { address_visibility: compliance?.address_visibility ?? 'hidden' } : {}),
    palette: isPaletteTemplate(template) ? resolveSitePalette(template, siteConfig.palette) : null,
    palette_source: isPaletteTemplate(template) ? (siteConfig.palette ? 'custom' : 'template') : null,
    font_preset: resolveOrganizationFontPreset(siteConfig.font_preset),
    default_currency: updatedOrganization.default_currency,
    timezone: updatedOrganization.timezone,
    press_email: siteConfig.press_email || '',
    partnerships_email: siteConfig.partnerships_email || '',
    catering_email: siteConfig.catering_email || '',
    careers_email: siteConfig.careers_email || '',
    google_analytics_measurement_id: siteConfig.google_analytics_measurement_id || '',
    integrations: integrationsSummary(await listIntegrations(db, organizationId), JSON.parse(updatedOrganization.locations_json) as IntegrationLocation[]),
    created_at: updatedOrganization.created_at,
    updated_at: updatedOrganization.updated_at,
  }
}

interface IntegrationLocation {
  id: string
  slug: string
  title: string
  address: string | null
  phone: string | null
  website_url: string | null
  /** The location's hero, which is what the tenant recognises it by. */
  image: string | null
  google_place_id: string | null
  rating: number | null
  review_count: number | null
  last_synced_at: string | null
}

/**
 * What each integration is connected to, for the Integrations list and its
 * leaves — names and ids, never a token. Google Maps is per location, so
 * its answer is the locations and which of them name a place.
 */
function integrationsSummary(integrations: Awaited<ReturnType<typeof listIntegrations>>, locations: IntegrationLocation[]) {
  const connected = (provider: typeof integrations[number]['provider']) => integrationSummary(integrations.find(integration => integration.provider === provider) ?? null)
  return {
    google_maps: locations.map(location => ({ ...location, address: formatPostalAddress(parsePostalAddress(location.address)) || null })),
    google_calendar: (() => { const row = integrations.find(row => row.provider === 'google_calendar'); return row ? { account_id: row.account_id, calendar_name: row.target_name, status: row.status, connected_at: row.created_at } : null })(),
    google_analytics: connected('google_analytics'),
    google_ads: connected('google_ads'),
    google_search_console: connected('google_search_console'),
    facebook: connected('facebook'),
    instagram: connected('instagram'),
    discord: connected('discord'),
  }
}

async function updateNonOrganizationConfigFields(
  db: D1Database,
  organizationId: string,
  updates: UpdateOrganizationSettingsRequest
): Promise<OrganizationSettingsUpdateResult | null> {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  for (const key of ['press_email', 'partnerships_email', 'catering_email', 'careers_email'] as const) {
    if (updates[key] !== undefined && updates[key] !== null) {
      const emailVal = String(updates[key]).trim()
      if (emailVal !== '' && !emailPattern.test(emailVal)) {
        return {
          status: 400,
          data: { error: `Invalid email address for ${key.replace('_', ' ')}` },
        }
      }
    }
  }

  for (const key of ['press_email', 'partnerships_email', 'catering_email', 'careers_email'] as const) {
    if (updates[key] !== undefined) {
      const value = updates[key]
      if (value) {
        await setConfig(db, organizationId, key, value)
      } else {
        await deleteConfig(db, organizationId, key)
      }
    }
  }

  return null
}

async function attemptOrganizationUpdate(
  db: D1Database,
  env: SetupEnv & CloudflareEnv,
  organization: OrganizationSettingsRow,
  organizationId: string,
  updates: UpdateOrganizationSettingsRequest,
  userId: string,
  subdomain: string | null
): Promise<OrganizationSettingsUpdateResult> {
  const setParts: string[] = []
  const params: Array<string | null> = []
  // Extra WHERE terms the UPDATE must still satisfy at the moment it runs.
  const guards: string[] = []
  const organizationMedia = updates.media

  const settingsPatch: Record<string, unknown> = {}
  if (updates.font_preset !== undefined) settingsPatch.config = { font_preset: updates.font_preset }
  // Resolved to a whole palette by updateOrganizationSettingsFields; null removes
  // it (json_patch deletes a key patched with null), returning to the template's.
  if (updates.palette !== undefined) settingsPatch.config = { ...(settingsPatch.config as Record<string, unknown> | undefined), palette: updates.palette }
  if (updates.address_visibility !== undefined) settingsPatch.compliance = { address_visibility: updates.address_visibility }
  if (updates.name !== undefined) {
    setParts.push('name = ?', 'subdomain = ?')
    params.push(updates.name, subdomain)
  }
  if (updates.brand_description !== undefined) {
    setParts.push('brand_description = ?')
    params.push(updates.brand_description ?? null)
  }
  if (updates.announcement !== undefined) {
    settingsPatch.config = {
      ...(settingsPatch.config as Record<string, unknown> | undefined),
      // json_patch removes the key entirely when the patch value is JSON null.
      announcement: updates.announcement === null ? null : {
        headline: updates.announcement.headline.trim(),
        description: updates.announcement.description?.trim() || null,
        cta_label: updates.announcement.cta_label?.trim() || null,
        cta_url: updates.announcement.cta_url?.trim() || null,
        dismissible: updates.announcement.dismissible ?? true,
        enabled: updates.announcement.enabled ?? true,
        format: updates.announcement.format === 'banner' ? 'banner' : 'modal',
      },
    }
  }
  if (Object.keys(settingsPatch).length > 0) {
    // A newly created compliance object requires its two collection containers.
    const settingsJson = updates.address_visibility === undefined ? 'settings_json'
      : `CASE WHEN json_type(settings_json, '$.compliance') IS NULL THEN json_set(settings_json, '$.compliance', json('{"same_as":[],"contact_points":[]}')) ELSE settings_json END`
    setParts.push(`settings_json = json_patch(${settingsJson}, json(?))`)
    params.push(JSON.stringify(settingsPatch))
  }
  if (updates.contact_email !== undefined) {
    if (updates.contact_email !== null && updates.contact_email !== '') {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailPattern.test(String(updates.contact_email).trim())) {
        return {
          status: 400,
          data: { error: 'Invalid email address for contact email' },
        }
      }
    }
    setParts.push('contact_email = ?')
    params.push(updates.contact_email ? String(updates.contact_email).trim().toLowerCase() : null)
  }
  if (updates.default_currency !== undefined) {
    if (typeof updates.default_currency !== 'string') {
      return {
        status: 400,
        data: { error: 'Invalid default currency' },
      }
    }
    const currency = updates.default_currency.toUpperCase().trim()
    if (!isCurrencyCode(currency)) {
      return {
        status: 400,
        data: { error: 'Invalid default currency' },
      }
    }
    setParts.push('default_currency = ?')
    params.push(currency)
  }
  if (updates.timezone !== undefined) {
    const timezone = typeof updates.timezone === 'string' ? updates.timezone.trim() : null
    if (!isValidTimezone(timezone)) return { status: 400, data: { error: 'timezone must be an IANA time zone' } }
    setParts.push('timezone = ?')
    params.push(timezone)
  }
  if (updates.status !== undefined) {
    // Draft and Live are the tenant's to move between. 'suspended' is the
    // platform's hold, so the tenant neither sets it nor clears it. The read
    // answers plainly; the guard on the UPDATE is what a suspension landing
    // between the two cannot outrun.
    if (updates.status !== 'active' && updates.status !== 'inactive') {
      return { status: 400, data: { error: 'Website status must be active or inactive' } }
    }
    if (organization.status === 'suspended') {
      return { status: 409, data: { error: 'This website is suspended. Contact support to restore it.' } }
    }
    setParts.push('status = ?')
    params.push(updates.status)
    guards.push("status <> 'suspended'")
  }
  if (updates.seo_title !== undefined) {
    setParts.push('seo_title = ?')
    params.push(updates.seo_title ?? null)
  }
  if (updates.seo_description !== undefined) {
    setParts.push('seo_description = ?')
    params.push(updates.seo_description ?? null)
  }
  if (updates.canonical_url !== undefined) {
    setParts.push('canonical_url = ?')
    params.push(updates.canonical_url ?? null)
  }
  if (setParts.length === 0 && organizationMedia === undefined) {
    const settings = await loadSettingsPayload(db, env, organizationId)
    return {
      status: 200,
      data: {
        success: true,
        settings,
        message: 'Organization settings updated successfully',
      },
    }
  }

  const now = new Date().toISOString()
  if (setParts.length > 0) {
    setParts.push('updated_at = ?', 'updated_by = ?')
    params.push(now, userId)
  }

  const organizationUpdate = {
    sql: `
    UPDATE organization
    SET ${setParts.join(', ')}
    WHERE id = ?${guards.map(guard => ` AND ${guard}`).join('')}
  `,
    values: [...params, organizationId],
  }

  // A guard that matched nothing means the row no longer answers to this
  // write — a suspended tenant being told to go Live. Reporting success would
  // leave the owner believing they published it.
  if (guards.length > 0 && setParts.length > 0) {
    const guarded = await queryFirst<{ status: string }>(db,
      'SELECT status FROM organization WHERE id = ? LIMIT 1', [organizationId])
    if (guarded?.status === 'suspended') {
      return { status: 409, data: { error: 'This website is suspended. Contact support to restore it.' } }
    }
  }

  const isRename = updates.name !== undefined && subdomain && subdomain !== organization.subdomain
  if (isRename && setParts.length > 0) {
    await createSystemSubdomain(env, db, organizationId, subdomain, { organizationUpdate })
  } else if (setParts.length > 0) {
    const result = await execute(db, organizationUpdate.sql, organizationUpdate.values)
    if (!result.success) {
      throw new Error('Failed to update organization settings')
    }
  }

  // A status change adds or removes this site's indexed content. Typography,
  // colors and announcements affect only its public resource and HTML caches.
  if (updates.status !== undefined || updates.address_visibility !== undefined) {
    await purgePublicResourceCacheNow(env, organizationId)
  } else if (updates.font_preset !== undefined || updates.palette !== undefined || updates.announcement !== undefined) {
    if (!env.ORGANIZATION_CACHE) throw new Error('ORGANIZATION_CACHE is not bound; site caches cannot be purged')
    await purgeOrganizationCaches(db, env.ORGANIZATION_CACHE, organizationId, env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
  }

  // Zaraz serves analytics only for tenants that are Live, so taking one to
  // Draft has to withdraw its tag rather than leave it collecting from a
  // website the owner believes is unpublished.
  if (updates.status !== undefined) await reconcileZarazAnalytics(env, db)

  if (organizationMedia !== undefined && organizationMedia.length > 0) {
    const targetSlots = new Set(organizationMedia.map(item => item.slot))
    const queries = [...targetSlots].flatMap(slot => buildSingleMediaPlacementQueries({
      organizationId,
      
      placement: { owner_type: 'organization', owner_id: organizationId, slot },
      media: organizationMedia.filter(item => item.slot === slot && item.asset_id).map(item => ({ asset_id: String(item.asset_id), presentation: item.presentation ?? null })),
      now,
    }))
    await executeBatch(db, queries)
  }

  const cardInputChanged = updates.name !== undefined
    || updates.brand_description !== undefined
    || updates.seo_title !== undefined
    || updates.seo_description !== undefined
    || organizationMedia?.some(item => item.slot === 'logo' || item.slot === 'social_share') === true
  if (cardInputChanged) {
    await refreshSocialCard({ db, env, owner: { owner_type: 'organization', owner_id: organizationId }, actorId: userId })
  }

  const settings = await loadSettingsPayload(db, env, organizationId)
  return {
    status: 200,
    data: {
      success: true,
      settings,
      message: 'Organization settings updated successfully',
    },
  }
}

export async function updateOrganizationSettingsFields(
  db: D1Database,
  env: SetupEnv & CloudflareEnv,
  organizationId: string,
  updates: UpdateOrganizationSettingsRequest,
  userId: string
): Promise<OrganizationSettingsUpdateResult> {
  if (Object.keys(updates).length === 0) {
    return {
      status: 400,
      data: { error: 'No update fields provided' },
    }
  }

  const organization = await queryFirst<OrganizationSettingsRow>(db, `
    SELECT id, status, subdomain, name, vertical, theme_id
    FROM organization
    WHERE id = ?
    LIMIT 1
  `, [organizationId])

  if (!organization) {
    return {
      status: 404,
      data: { error: 'Organization not found or access denied' },
    }
  }

  if (updates.address_visibility !== undefined) {
    if (updates.address_visibility !== 'visible' && updates.address_visibility !== 'hidden') return { status: 400, data: { error: 'address_visibility must be visible or hidden' } }
    if (!organizationSupportsBlawbyTemplate({ vertical: organization.vertical, themeId: organization.theme_id })) return { status: 400, data: { error: 'Office address visibility is available for service websites' } }
  }

  // Validate before any settings writes. Preset IDs are not CSS or font URLs.
  if (updates.font_preset !== undefined && !isOrganizationFontPreset(updates.font_preset)) {
    return { status: 400, data: { error: `font_preset must be one of: ${ORGANIZATION_FONT_PRESETS.join(', ')}` } }
  }

  // A palette change resolves to the whole palette the site will render, so
  // what is stored is always complete and validated before anything is written.
  if (updates.palette !== undefined) {
    const template = resolvePublicTemplate({ themeId: organization.theme_id }).slug
    if (!isPaletteTemplate(template)) {
      return { status: 400, data: { error: 'Website colors are available for the Saya and Blawby templates' } }
    }
    if (updates.palette !== null) {
      const current = resolveSitePalette(template, (await getConfig(db, organizationId)).palette)
      try {
        updates = { ...updates, palette: applySitePalettePatch(current, updates.palette) }
      } catch (error) {
        return { status: 400, data: { error: (error as Error).message } }
      }
    }
  }

  if (updates.announcement !== undefined && updates.announcement !== null) {
    const { headline, description, cta_label, cta_url, dismissible, enabled, format } = updates.announcement
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return { status: 400, data: { error: 'Announcement enabled must be a boolean' } }
    }
    if (dismissible !== undefined && typeof dismissible !== 'boolean') {
      return { status: 400, data: { error: 'Announcement dismissible must be a boolean' } }
    }
    if (format !== undefined && format !== null && format !== 'modal' && format !== 'banner') {
      return { status: 400, data: { error: "Announcement format must be 'modal' or 'banner'" } }
    }
    // A disabled announcement may be saved with a blank headline — the owner is turning it off,
    // not necessarily deleting draft text they intend to re-enable later. It still has to be a
    // string within the length limit either way: attemptOrganizationUpdate trims it unconditionally,
    // and a missing/null headline would throw there rather than fail this validation cleanly.
    if (typeof headline !== 'string' || headline.trim().length > 120) {
      return { status: 400, data: { error: 'Announcement headline must be a string of 120 characters or fewer' } }
    }
    if (enabled !== false && !headline.trim()) {
      return { status: 400, data: { error: 'Announcement headline is required' } }
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.trim().length > 500)) {
      return { status: 400, data: { error: 'Announcement description must be 500 characters or fewer' } }
    }
    if (cta_label !== undefined && cta_label !== null && typeof cta_label !== 'string') {
      return { status: 400, data: { error: 'Announcement CTA label must be a string' } }
    }
    if (cta_url !== undefined && cta_url !== null && typeof cta_url !== 'string') {
      return { status: 400, data: { error: 'Announcement CTA URL must be a string' } }
    }
    if ((cta_label && !cta_url) || (!cta_label && cta_url)) {
      return { status: 400, data: { error: 'A call-to-action needs both a label and a URL' } }
    }
    if (cta_url) {
      try {
        const url = new URL(cta_url)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol')
      } catch {
        return { status: 400, data: { error: 'Announcement CTA URL must be a valid http or https URL' } }
      }
    }
  }

  const organizationMedia = updates.media
  if (organizationMedia !== undefined) {
    if (!Array.isArray(organizationMedia) || organizationMedia.some(item => !item || !['logo', 'logo_dark', 'favicon', 'social_share', 'announcement'].includes(item.slot) || (item.asset_id !== null && typeof item.asset_id !== 'string'))) {
      return { status: 400, data: { error: 'media must contain an asset_id and a logo, logo_dark, favicon, social_share, or announcement slot' } }
    }
    for (const item of organizationMedia) {
      if (item.presentation == null) continue
      if (!(LOGO_SLOTS as readonly string[]).includes(item.slot)) return { status: 400, data: { error: 'Only the logo slots take a presentation' } }
      try {
        parseLogoPresentation(item.presentation)
      } catch (error) {
        return { status: 400, data: { error: (error as Error).message } }
      }
    }
    try {
      await hydrateMediaAssetRefs(db, {
        organizationId,
        
        refs: organizationMedia.filter(item => item.asset_id).map(item => ({ asset_id: String(item.asset_id) })),
        allowedKinds: ['image'],
      })
    } catch {
      return { status: 400, data: { error: 'Invalid media references' } }
    }
  }

  const configError = await updateNonOrganizationConfigFields(db, organizationId, updates)
  if (configError) return configError
  if (updates.name !== undefined) {
    const baseSlug = buildSlug(updates.name)
    if (!baseSlug) {
      return {
        status: 400,
        data: { error: 'Brand name must contain at least one alphanumeric character' },
      }
    }

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const subdomain = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`

      const existing = await queryFirst(db, `
        SELECT id
        FROM organization
        WHERE subdomain = ? AND id != ?
        LIMIT 1
      `, [subdomain, organizationId])
      if (existing) continue
      if (await isSystemSubdomainSpent(env, db, subdomain)) continue

      let result: OrganizationSettingsUpdateResult
      try {
        result = await attemptOrganizationUpdate(
          db,
          env,
          organization,
          organizationId,
          updates,
          userId,
          subdomain
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/UNIQUE constraint failed/i.test(message)) continue
        throw error
      }
      // One business, one name. The organization Better Auth holds is that
      // business, so it takes the brand name a guest sees rather than keeping
      // a second name of its own. Outside the retry: a failure here is not a
      // subdomain collision and must not spend another attempt.
      if (result.status === 200) {
        const adapter = await organizationAdapter(env)
        await adapter.updateOrganization(organizationId, { name: updates.name.trim() })
      }
      return result
    }

    return {
      status: 409,
      data: { error: `Unable to allocate a unique subdomain after ${MAX_SLUG_ATTEMPTS} attempts` },
    }
  }

  return attemptOrganizationUpdate(
    db,
    env,
    organization,
    organizationId,
    updates,
    userId,
    null
  )
}
