import { HTTPError } from 'nitro'
import { isLodgingConfirmationMode, LODGING_BOOKING_CHOICES } from '~/shared/lodging-booking'
import { LODGING_BOOKING_POLICY_COLUMNS, lodgingBookingPolicy } from '~/server/utils/lodging-booking-policy'
import { isLegalPracticeSite, PLATFORM_THEME_ID, resolvePublicSite } from '~/utils/site-routing'
import { publicConsultationFromJson } from '~/server/utils/professional-services'
import { CONFIG_COLUMNS, deleteConfig, getConfig, parseConfig, setConfig, type ConfigRow } from '~/server/utils/organization-config'
import { createSystemSubdomain, isSystemSubdomainSpent } from '~/server/utils/domains'
import { reconcileZarazAnalytics } from '~/server/utils/zaraz-analytics'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { ORGANIZATION_FONT_PRESETS, isOrganizationFontPreset, resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { purgeOrganizationCaches, purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import type { UpdateOrganizationSettingsRequest } from '~/server/types/organization'
import { integrationSummary, integrationsFromRows, integrationsQuery } from '~/server/utils/organization-integrations'
import { executeBatch, queryFirst, type DbClient } from '~/server/db'
import { formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'
import { buildSingleMediaPlacementQueries, groupMediaPlacements, hydrateMediaAssetRefs, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { applySitePalettePatch, resolveSitePalette } from '~/shared/site-palette'
import { SITE_RECIPE_KEYS, SITE_RECIPE_OPTIONS, isSiteRecipeValue, parseSiteRecipe } from '~/shared/site-recipe'
import { LOGO_SLOTS, ORIGINAL_LOGO_PRESENTATION, parseLogoPresentation } from '~/shared/media-placement-contract'
import { organizationSocialCardRefresh, organizationSocialCardRefreshQuery, refreshSocialCard, queueOrganizationSocialCardRefresh } from '~/server/utils/social-card'
import { BUSINESS_CURRENCY_FIXED, businessCurrencyFixed, type CloudflareEnv } from '~/server/utils/auth'
import { prepareFormQuestionsWrite, readFormQuestions } from '~/server/domain/form-questions'
import { formQuestionsRevision, parseStoredFormQuestions, type FormQuestion } from '~/shared/form-questions'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { pageTasks, prepareTenantPages } from '~/server/utils/content/pages'
import { recentArticleCards, recentArticleCardsQuery } from '~/server/utils/content/publishing'
import { recentPostCardsQuery } from '~/server/utils/post-management'

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
  consultation_settings_json: string | null
  address_visibility: string | null
  questions: string | null
  policy_type: string | null
  confirmation_mode: unknown
  contact_email: string | null
  seo_title: string | null
  seo_description: string | null
  canonical_url: string | null
  consultation_mode: 'native' | 'external_url' | 'native_disabled' | null
  reviews_count: number | null
  average_rating: number | null
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

const INTEGRATION_LOCATIONS_JSON = `(SELECT json_group_array(json_object('id', id, 'slug', slug, 'title', title, 'address', address,
                     'phone', phone, 'website_url', website_url, 'image', image,
                     'google_place_id', google_place_id, 'rating', rating, 'review_count', review_count,
                     'last_synced_at', last_synced_at))
              FROM (SELECT bl.*, COALESCE(hma.thumbnail_url, hma.public_url) AS image FROM business_locations bl
                      LEFT JOIN media_placements hmp ON hmp.organization_id = bl.organization_id AND hmp.owner_type = 'business_location' AND hmp.owner_id = bl.id
                        AND hmp.slot = 'hero' AND hmp.sort_order = 0 AND hmp.status = 'active'
                      LEFT JOIN media_assets hma ON hma.organization_id = hmp.organization_id AND hma.id = hmp.asset_id AND hma.status = 'active'
                     WHERE bl.organization_id = organization.id AND bl.status = 'active' ORDER BY bl.title, bl.id))`

export async function loadConnectionSummary(db: DbClient, organizationId: string, locations?: IntegrationLocation[]) {
  const plan = prepareConnectionSummary(organizationId, locations)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read Connections and locations' }))
}

export function prepareConnectionSummary(organizationId: string | { sql: string }, locations?: IntegrationLocation[]) {
  const org = typeof organizationId === 'string' ? '?' : organizationId.sql
  const params = typeof organizationId === 'string' ? [organizationId] : []
  const queries = [
    integrationsQuery(organizationId),
    { query: `SELECT a.id AS account_id, u.email, u.name FROM account a JOIN user u ON u.id = a.userId
      WHERE a.id IN (SELECT i.account_id FROM organization_integrations i WHERE i.organization_id = ${org} AND i.status IS NOT 'setting_up')`, params },
    { query: `SELECT status, connected_at FROM channex_connections WHERE organization_id = ${org} ORDER BY status = 'connected' DESC, connected_at, id LIMIT 1`, params },
    ...(locations ? [] : [{ query: `SELECT ${INTEGRATION_LOCATIONS_JSON} AS locations_json FROM organization WHERE id = ${org}`, params }]),
  ]
  return { queries, read: ([linked, ownerRows, channels, business]: D1Result[]) => {
    const organization = business?.results[0] as { locations_json: string } | undefined
    if (!locations && !organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
    const addressRows = locations ?? JSON.parse(organization!.locations_json) as IntegrationLocation[]
    const owners = new Map((ownerRows!.results as { account_id: string; email: string | null; name: string | null }[])
      .map(({ account_id, email, name }) => [account_id, { email, name }]))
    const channex = channels!.results[0] as { status: string; connected_at: string | null } | undefined
    return integrationsSummary(integrationsFromRows(linked!.results), addressRows, owners, channex)
  } }
}

export async function loadSettingsPayload(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
) {
  const plan = prepareSettingsPayload(organizationId, env)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read website settings' }))
}

export function prepareWebsiteSettings(organizationId: string | { sql: string }, env: CloudflareEnv) {
  const settings = prepareSettingsPayload(organizationId, env)
  const pages = prepareTenantPages(organizationId)
  return {
    queries: [...settings.queries, ...pages.queries, recentArticleCardsQuery(organizationId), recentPostCardsQuery(organizationId)],
    read(rows: D1Result[]) {
      const saved = settings.read(rows.slice(0, settings.queries.length))
      const { pages: pageRows, source_locale } = pages.read(rows.slice(settings.queries.length, -2), saved.id)
      return {
        success: true, settings: saved,
        pages: pageRows, tasks: pageTasks(pageRows),
        source_locale,
        articles: recentArticleCards(rows.at(-2)!.results), posts: rows.at(-1)!.results,
      }
    },
  }
}

export function prepareSettingsPayload(organizationId: string | { sql: string }, env: CloudflareEnv) {
  const org = typeof organizationId === 'string' ? '?' : organizationId.sql
  const params = typeof organizationId === 'string' ? [organizationId] : []
  const connections = prepareConnectionSummary(organizationId)
  const queries = [{ query: `
    SELECT o.id, subdomain, o.status,
           (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = o.id AND role = 'canonical' AND status = 'active') AS public_url, COALESCE((SELECT status FROM organization_domains WHERE organization_id = o.id AND type = 'custom' AND status NOT IN ('deleted', 'disabled') ORDER BY role = 'canonical' DESC, created_at, id LIMIT 1), 'none') AS custom_domain_status, default_currency, timezone,
           name, brand_description,
           json_extract(o.settings_json, '$.config.announcement') AS announcement_json,
           ${CONFIG_COLUMNS},
           ${LODGING_BOOKING_POLICY_COLUMNS},
           json_extract(o.settings_json, '$.inquiry.questions') AS questions,
           json_extract(o.settings_json, '$.compliance.address_visibility') AS address_visibility,
           CASE WHEN json_type(o.consultation_settings_json) = 'object' THEN o.consultation_settings_json END AS consultation_settings_json,
           contact_email,
           seo_title, seo_description, canonical_url,
           CASE WHEN json_type(o.consultation_settings_json) = 'object' THEN json_extract(o.consultation_settings_json, '$.mode') END AS consultation_mode,
           strftime('%Y-%m-%dT%H:%M:%fZ', o."createdAt", 'unixepoch') AS created_at, o.updated_at,
           vertical, theme_id,
           COALESCE(NULLIF((SELECT COUNT(*) FROM reviews WHERE organization_id = o.id AND status = 'approved'), 0), (SELECT SUM(review_count) FROM business_locations WHERE organization_id = o.id AND status = 'active'), 0) AS reviews_count,
           COALESCE((SELECT ROUND(AVG(rating), 2) FROM reviews WHERE organization_id = o.id AND status = 'approved'), (SELECT ROUND(AVG(rating), 2) FROM business_locations WHERE organization_id = o.id AND status = 'active' AND rating > 0), 0) AS average_rating
    FROM organization o WHERE o.id = ${org}
  `, params },
  mediaPlacementsQuery({ organizationId, ownerType: 'organization', owners: { sql: `SELECT ${org}`, params } }),
  organizationSocialCardRefreshQuery(organizationId),
  ...connections.queries]

  return { queries, read }

  function read([organization, placements, refresh, ...integrationRows]: D1Result[]) {
    const updatedOrganization = organization!.results[0] as FullOrganizationRow & ConfigRow | undefined
    if (!updatedOrganization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
    const id = updatedOrganization.id
    const siteConfig = parseConfig(updatedOrganization)
    const site = resolvePublicSite({ themeId: updatedOrganization.theme_id }).slug
    const isLegal = isLegalPracticeSite({ vertical: updatedOrganization.vertical, themeId: updatedOrganization.theme_id })
    const consultation = isLegal ? publicConsultationFromJson(updatedOrganization.consultation_settings_json) : null
    if (isLegal && !consultation) throw new HTTPError({ statusCode: 500, statusMessage: 'Professional-service consultation settings are missing', data: { code: 'CONSULTATION_SETTINGS_MISSING' } })
    const media = groupMediaPlacements(placements!.results).get(id) ?? []
    const questions = updatedOrganization.questions === null ? [] : parseStoredFormQuestions(updatedOrganization.questions)

    return {
      id: updatedOrganization.id,
      subdomain: updatedOrganization.subdomain,
      theme: site,
      status: updatedOrganization.status,

      public_url: updatedOrganization.public_url ? tenantOrganizationOrigin({
        platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
        freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
        subdomain: updatedOrganization.subdomain ?? '',
        canonicalDomain: updatedOrganization.public_url,
      }) : null,
      custom_domain_status: updatedOrganization.custom_domain_status,
      name: updatedOrganization.name,
      social_card_refresh: organizationSocialCardRefresh(refresh!.results[0] as Parameters<typeof organizationSocialCardRefresh>[0]),
      brand_description: updatedOrganization.brand_description,
      announcement: updatedOrganization.announcement_json ? { format: 'modal', ...JSON.parse(updatedOrganization.announcement_json) } : null,
      media: media.filter(item => ['announcement', 'favicon', 'social_share', ...LOGO_SLOTS].includes(item.slot)).map(item => ({
        asset_id: item.asset_id,
        slot: item.slot,
        public_url: item.public_url,
        thumbnail_url: item.thumbnail_url,
        kind: item.kind,
        ...((LOGO_SLOTS as readonly string[]).includes(item.slot) ? { presentation: item.presentation ?? ORIGINAL_LOGO_PRESENTATION } : {}),
      })),
      contact_email: updatedOrganization.contact_email,
      seo_title: updatedOrganization.seo_title,
      seo_description: updatedOrganization.seo_description,
      canonical_url: updatedOrganization.canonical_url,
      // The website's booking switch exists only where consultation settings do.
      consultation_mode: consultation?.mode ?? updatedOrganization.consultation_mode,
      ...(updatedOrganization.vertical === 'lodging' ? {
        lodging_booking: lodgingBookingPolicy(id, updatedOrganization),
        lodging_booking_choices: LODGING_BOOKING_CHOICES,
      } : {}),
      ...(consultation ? { address_visibility: updatedOrganization.address_visibility === 'visible' ? 'visible' as const : 'hidden' as const } : {}),
      palette: site !== 'platform' ? resolveSitePalette(siteConfig.palette) : null,
      palette_source: site !== 'platform' ? (siteConfig.palette ? 'custom' : 'default') : null,
      font_preset: resolveOrganizationFontPreset(siteConfig.font_preset),
      // A choice the site has not made reads as absent: the Default applies.
      ...parseSiteRecipe(siteConfig),
      default_currency: updatedOrganization.default_currency,
      timezone: updatedOrganization.timezone,
      press_email: siteConfig.press_email || '',
      partnerships_email: siteConfig.partnerships_email || '',
      catering_email: siteConfig.catering_email || '',
      careers_email: siteConfig.careers_email || '',
      google_analytics_measurement_id: siteConfig.google_analytics_measurement_id || '',
      // The inquiry form's own questions, and the revision a write or a form names.
      inquiry_questions: questions,
      inquiry_questions_revision: formQuestionsRevision(questions),
      integrations: connections.read(integrationRows),
      vertical: updatedOrganization.vertical,
      reviews_count: Number(updatedOrganization.reviews_count || 0),
      average_rating: Number(updatedOrganization.average_rating || 0),
      created_at: updatedOrganization.created_at,
      updated_at: updatedOrganization.updated_at,
    }
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
function integrationsSummary(
  integrations: ReturnType<typeof integrationsFromRows>, locations: IntegrationLocation[],
  owners: Map<string, { email: string | null; name: string | null }>,
  channex: { status: string; connected_at: string | null } | undefined,
) {
  const connected = (provider: typeof integrations[number]['provider']) => {
    const summary = integrationSummary(integrations.find(integration => integration.provider === provider) ?? null)
    return summary && { ...summary, connected_through: owners.get(summary.account_id) ?? null }
  }
  return {
    google_maps: locations.map(location => ({ ...location, address: formatPostalAddress(parsePostalAddress(location.address)) || null })),
    google_calendar: (() => { const row = integrations.find(row => row.provider === 'google_calendar'); return row ? { account_id: row.account_id, calendar_name: row.target_name, status: row.status, last_error: row.last_error, connected_at: row.created_at, connected_through: owners.get(row.account_id) ?? null } : null })(),
    google_analytics: connected('google_analytics'),
    google_ads: connected('google_ads'),
    meta_ads: connected('meta_ads'),
    google_search_console: connected('google_search_console'),
    facebook: connected('facebook'),
    instagram: connected('instagram'),
    discord: connected('discord'),
    airbnb: channex ? {
      status: channex.status,
      connected_at: channex.connected_at,
    } : null,
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
  const guardParams: Array<string | null> = []
  const organizationMedia = updates.media
  const nameChanged = updates.name !== undefined && updates.name.trim() !== organization.name
  const socialCardRefresh = nameChanged ? queueOrganizationSocialCardRefresh(organizationId) : null

  const settingsPatch: Record<string, unknown> = {}
  if (updates.lodging_booking) {
    settingsPatch.lodging_booking = { confirmation_mode: updates.lodging_booking.confirmation_mode }
  }
  if (updates.font_preset !== undefined) settingsPatch.config = { font_preset: updates.font_preset }
  for (const key of SITE_RECIPE_KEYS) {
    if (updates[key] !== undefined) settingsPatch.config = { ...(settingsPatch.config as Record<string, unknown> | undefined), [key]: updates[key] }
  }
  // Resolved to a whole palette by updateOrganizationSettingsFields; null removes
  // it (json_patch deletes a key patched with null), returning to the site's.
  if (updates.palette !== undefined) settingsPatch.config = { ...(settingsPatch.config as Record<string, unknown> | undefined), palette: updates.palette }
  if (updates.address_visibility !== undefined) settingsPatch.compliance = { address_visibility: updates.address_visibility }
  // The inquiry questions are replaced whole, and only over the list the caller read.
  let inquiryQuestions: FormQuestion[] | null = null
  if (updates.inquiry_questions !== undefined) {
    const current = await readFormQuestions(db, { kind: 'inquiry', organizationId })
    inquiryQuestions = prepareFormQuestionsWrite(current, { questions: updates.inquiry_questions, expectedRevision: updates.expected_inquiry_questions_revision })
    settingsPatch.inquiry = { questions: inquiryQuestions }
    guards.push("COALESCE(json_extract(settings_json, '$.inquiry.questions'), '[]') = json(?)")
    guardParams.push(JSON.stringify(current))
  }
  if (updates.name !== undefined) {
    setParts.push('name = ?')
    params.push(updates.name.trim())
    guards.push('name IS ?')
    guardParams.push(organization.name)
    if (subdomain !== null) {
      setParts.push('subdomain = ?')
      params.push(subdomain)
    }
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
    const canonicalStatus = updates.status === 'published' ? 'active' : updates.status === 'draft' ? 'inactive' : updates.status
    if (canonicalStatus !== 'active' && canonicalStatus !== 'inactive') {
      return { status: 400, data: { error: 'Website status must be active or inactive' } }
    }
    if (organization.status === 'suspended') {
      return { status: 409, data: { error: 'This website is suspended. Contact support to restore it.' } }
    }
    setParts.push('status = ?')
    params.push(canonicalStatus)
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
    query: `
    UPDATE organization
    SET ${setParts.join(', ')}
    WHERE id = ?${guards.map(guard => ` AND ${guard}`).join('')}
  `,
    params: [...params, organizationId, ...guardParams],
  }
  const mediaWrites = [...new Set(organizationMedia?.map(item => item.slot))].flatMap(slot => buildSingleMediaPlacementQueries({
    organizationId,
    placement: { owner_type: 'organization', owner_id: organizationId, slot },
    media: (organizationMedia ?? []).filter(item => item.slot === slot && item.asset_id)
      .map(item => ({ asset_id: String(item.asset_id), presentation: item.presentation ?? null })),
    now,
  }))
  const organizationWrites = [
    organizationUpdate,
    ...(guards.length === 0 ? [] : [{ query: "SELECT CASE WHEN changes() = 1 THEN NULL ELSE json_extract('{}', 'ORGANIZATION_SETTINGS_CHANGED') END" }]),
    ...(socialCardRefresh?.queries ?? []),
    ...mediaWrites,
  ]

  // A guard that matched nothing means the row no longer answers to this
  // write — a suspended tenant being told to go Live. Reporting success would
  // leave the owner believing they published it.
  if (updates.status !== undefined && setParts.length > 0) {
    const guarded = await queryFirst<{ status: string }>(db,
      'SELECT status FROM organization WHERE id = ? LIMIT 1', [organizationId])
    if (guarded?.status === 'suspended') {
      return { status: 409, data: { error: 'This website is suspended. Contact support to restore it.' } }
    }
  }

  const isRename = updates.name !== undefined && subdomain && subdomain !== organization.subdomain
  try {
    if (isRename && setParts.length > 0) {
      await createSystemSubdomain(env, db, organizationId, subdomain, { organizationWrites })
    } else if (setParts.length > 0) {
      await executeBatch(db, organizationWrites, { operation: 'Update organization settings' })
    } else if (mediaWrites.length > 0) {
      await executeBatch(db, mediaWrites, { operation: 'Update organization media' })
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('ORGANIZATION_SETTINGS_CHANGED')) {
      return { status: 409, data: { error: 'Organization settings changed while saving. Read them again.' } }
    }
    throw error
  }

  // A guarded question write that lost the race changed nothing; saying it saved would hide that.
  if (inquiryQuestions !== null) {
    const saved = await readFormQuestions(db, { kind: 'inquiry', organizationId })
    if (formQuestionsRevision(saved) !== formQuestionsRevision(inquiryQuestions)) return { status: 409, data: { error: 'The inquiry questions changed before saving. Read them again.', code: 'questions_changed' } }
  }

  // A status change adds or removes this site's indexed content. Typography,
  // colors, recipe tokens and announcements affect only its public resource and HTML caches.
  // The inquiry form's questions are part of every public form that renders it.
  if (updates.name !== undefined || updates.status !== undefined || updates.address_visibility !== undefined || updates.inquiry_questions !== undefined) {
    await purgePublicResourceCacheNow(env, organizationId)
  } else if (
    updates.lodging_booking !== undefined ||
    updates.font_preset !== undefined ||
    updates.palette !== undefined ||
    updates.announcement !== undefined ||
    SITE_RECIPE_KEYS.some(key => updates[key] !== undefined)
  ) {
    if (!env.ORGANIZATION_CACHE) throw new Error('ORGANIZATION_CACHE is not bound; site caches cannot be purged')
    await purgeOrganizationCaches(db, env.ORGANIZATION_CACHE, organizationId, env)
  }

  // Zaraz serves analytics only for tenants that are Live, so taking one to
  // Draft has to withdraw its tag rather than leave it collecting from a
  // website the owner believes is unpublished.
  if (updates.status !== undefined) await reconcileZarazAnalytics(env, db)

  const cardInputChanged = updates.brand_description !== undefined
    || updates.seo_title !== undefined
    || updates.seo_description !== undefined
    || organizationMedia?.some(item => item.slot === 'logo' || item.slot === 'social_share') === true
  if (cardInputChanged && !nameChanged) {
    await refreshSocialCard({ db, env, owner: { owner_type: 'organization', owner_id: organizationId }, actorId: userId })
  }

  const settings = await loadSettingsPayload(db, env, organizationId)
  if (updates.name !== undefined && (settings.name !== updates.name.trim() || (socialCardRefresh && settings.social_card_refresh?.id !== socialCardRefresh.id))) {
    return { status: 409, data: { error: 'A newer change superseded this brand name. Read the current organization settings.' } }
  }
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

  if (updates.lodging_booking !== undefined) {
    if (organization.vertical !== 'lodging') return { status: 400, data: { error: 'Stay booking settings are available for lodging websites' } }
    if (!isLodgingConfirmationMode(updates.lodging_booking?.confirmation_mode)) {
      return { status: 400, data: { error: 'Choose Instant Book or Approve requests' } }
    }
    if (updates.lodging_booking.online_payment_required !== undefined && updates.lodging_booking.online_payment_required !== true) {
      return { status: 400, data: { error: 'Direct stays require online payment' } }
    }
  }

  if (updates.address_visibility !== undefined) {
    if (updates.address_visibility !== 'visible' && updates.address_visibility !== 'hidden') return { status: 400, data: { error: 'address_visibility must be visible or hidden' } }
    if (!isLegalPracticeSite({ vertical: organization.vertical, themeId: organization.theme_id })) return { status: 400, data: { error: 'Office address visibility is available for service websites' } }
  }

  if (updates.font_preset !== undefined && !isOrganizationFontPreset(updates.font_preset)) {
    return { status: 400, data: { error: `font_preset must be one of: ${ORGANIZATION_FONT_PRESETS.join(', ')}` } }
  }

  for (const key of SITE_RECIPE_KEYS) {
    if (updates[key] !== undefined && !isSiteRecipeValue(key, updates[key])) {
      return { status: 400, data: { error: `${key} must be one of: ${SITE_RECIPE_OPTIONS[key].join(', ')}` } }
    }
  }

  // A palette change resolves to the whole palette the site will render, so
  // what is stored is always complete and validated before anything is written.
  if (updates.palette !== undefined) {
    if (organization.theme_id === PLATFORM_THEME_ID) {
      return { status: 400, data: { error: "Blawby's own site has fixed colors" } }
    }
    if (updates.palette !== null) {
      const current = resolveSitePalette((await getConfig(db, organizationId)).palette)
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

  if (typeof updates.default_currency === 'string' && await businessCurrencyFixed(db, organizationId, updates.default_currency.toUpperCase().trim())) {
    return { status: 409, data: { error: BUSINESS_CURRENCY_FIXED, code: 'CURRENCY_FIXED' } }
  }

  const configError = await updateNonOrganizationConfigFields(db, organizationId, updates)
  if (configError) return configError
  if (updates.name !== undefined) {
    const baseSlug = updates.name.trim() === organization.name && organization.subdomain ? organization.subdomain : buildSlug(updates.name)
    if (!baseSlug) {
      return {
        status: 400,
        data: { error: 'Brand name must contain at least one alphanumeric character' },
      }
    }

    // The platform hostname is deployment configuration. Its stored alias
    // remains routable across a display name change.
    if (organization.theme_id === PLATFORM_THEME_ID) {
      return attemptOrganizationUpdate(db, env, organization, organizationId, updates, userId, null)
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

      try {
        return await attemptOrganizationUpdate(db, env, organization, organizationId, updates, userId, subdomain)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/UNIQUE constraint failed/i.test(message)) continue
        throw error
      }
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
