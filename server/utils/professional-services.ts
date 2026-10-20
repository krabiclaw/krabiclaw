import { getSourceLocale } from '~/server/utils/organization-locales'
import { platformLocale } from '~/shared/platform-locales'
import { loadPublicProductCollection } from '~/server/utils/public-products'
import { listOrganizationProducts, publicProduct } from '~/server/utils/product-management'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { HTTPError } from 'nitro';
import { z } from 'zod'
import type { CloudflareEnv } from '~/server/utils/auth'
import {
  loadExactPublicLocalizations,
  type ExactPublicLocalization,
} from '~/server/utils/public-localization'
import { loadPublicSocialMedia } from '~/server/utils/public-social-image'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import { publicTemplateRegistry, organizationSupportsBlawbyTemplate } from '~/utils/template-registry'

const BLAWBY_TEMPLATE = publicTemplateRegistry.blawby
import { getPublicTenantPageForPath } from '~/server/utils/public-tenant-pages'
import { listPublishedTenantPagePaths } from '~/server/utils/content/pages'
import { isBlawbyShellOnlyRouteRecipe } from '~/types/blawby'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import type {
  PublicBlawbyIdentity,
  PublicBlawbyRouteData,
  PublicBlawbyShellData,
  PublicCompliance,
  PublicComplianceContactPoint,
  PublicConsultationSettings,
} from '~/types/blawby'

const consultationSettingsSchema = z.object({
  mode: z.enum(['native', 'external_url', 'native_disabled']),
  cta_label: z.string().trim().min(1),
  external_url: z.url({ protocol: /^https?$/, normalize: true, abort: true }).refine(value => {
    const destination = new URL(value)
    return !destination.username && !destination.password
  }, 'external_url must be an absolute HTTP or HTTPS URL without credentials').nullable(),
  schedule_path: z.string().trim().startsWith('/'),
  confirmation_path: z.string().trim().startsWith('/'),
  tracking_enabled: z.boolean(),
  metadata_json: z.looseObject({}).nullable().optional(),
}).superRefine((settings, context) => {
  if (settings.mode === 'external_url' && settings.external_url === null) {
    context.addIssue({ code: 'custom', path: ['external_url'], message: 'An external scheduler URL is required' })
  }
})

function requiredText(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new HTTPError({ statusCode: 500, statusMessage: `Stored ${field} is missing`, data: { code: 'INVALID_STORED_CONTENT', field } })
}

/**
 * The site behind a Blawby route.
 *
 * `previewAuthorized` is the same contract every other public surface honours:
 * a site that is not yet active still renders for someone holding its preview
 * token. Without it a professional-services site could not be previewed at all
 * during onboarding — the pending site 404'd as "Blawby is not enabled" no
 * matter what token the frame carried. Legal-access callers pass nothing and so
 * keep requiring an active site, which is what an eligibility check wants.
 */
export async function getActiveBlawbyOrganization(
  db: DbClient,
  organizationId: string,
  options: { previewAuthorized?: boolean } = {},
): Promise<{ id: string; vertical: string; theme_id: string } | null> {
  const organization = await queryFirst<{ id: string; vertical: string; theme_id: string }>(db, `
    SELECT id, vertical, theme_id
      FROM organization
     WHERE id = ? AND ${publicTenantVisibilitySql('organization', options.previewAuthorized)}
     LIMIT 1
  `, [organizationId])

  return organizationSupportsBlawbyTemplate({ vertical: organization?.vertical, themeId: organization?.theme_id })
    ? organization
    : null
}

/** Initialize the canonical consultation settings through the shared adapter. */
export async function initializePublicConsultationSettings(db: DbClient, organizationId: string, settings: Omit<NonNullable<import('~/shared/organization-settings').OrganizationSettings['consultation']>, 'created_at' | 'updated_at' | 'updated_by'>, writeGuard?: BatchQuery) {
  const validated = consultationSettingsSchema.parse(settings)
  await executeBatch(db, [...(writeGuard ? [writeGuard] : []), {
    query: `UPDATE organization SET consultation_settings_json = json(?), updated_at = ? WHERE id = ? AND consultation_settings_json IS NULL`,
    params: [JSON.stringify({ ...validated, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: null }), new Date().toISOString(), organizationId],
  }, publicResourceCacheInvalidationQuery(organizationId, 'consultation_settings_initialized')], { operation: 'Initialize consultation settings' })
}

/** Only this adapter writes consultation settings. */
export async function setPublicConsultationMode(db: DbClient, organizationId: string, mode: PublicConsultationSettings['mode'], externalUrl?: unknown): Promise<PublicConsultationSettings> {
  const settings = await getPublicConsultationSettings(db, organizationId)
  const validated = consultationSettingsSchema.safeParse({ ...settings, mode, external_url: externalUrl === undefined ? settings.external_url : externalUrl })
  if (!validated.success) {
    throw new HTTPError({ statusCode: 400, statusMessage: validated.error.issues[0]!.message, data: { code: 'INVALID_CONSULTATION_SETTINGS', issues: validated.error.issues }, cause: validated.error })
  }
  const external = validated.data.external_url
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: `UPDATE organization SET consultation_settings_json = json_set(consultation_settings_json, '$.mode', ?, '$.external_url', ?, '$.updated_at', ?), updated_at = ? WHERE id = ?`,
    params: [mode, external, now, now, organizationId],
  }, publicResourceCacheInvalidationQuery(organizationId, 'consultation_mode_changed')], { operation: 'Set consultation mode' })
  return { ...settings, mode, external_url: external }
}

export async function getOptionalPublicConsultationSettings(db: DbClient, organizationId: string): Promise<PublicConsultationSettings | null> {
  const row = await queryFirst<{ consultation_settings_json: string }>(db, `
    SELECT consultation_settings_json
      FROM organization
     WHERE id = ? AND json_type(consultation_settings_json) = 'object'
     LIMIT 1
  `, [organizationId])

  if (!row) return null
  let settings: z.output<typeof consultationSettingsSchema>
  try {
    settings = consultationSettingsSchema.parse(JSON.parse(row.consultation_settings_json) as unknown)
  } catch (error) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Stored professional-service consultation settings are invalid', data: { code: 'INVALID_STORED_CONTENT' }, cause: error })
  }
  const { metadata_json: _metadata, ...consultation } = settings
  return consultation
}

export async function getPublicConsultationSettings(db: DbClient, organizationId: string): Promise<PublicConsultationSettings> {
  const consultation = await getOptionalPublicConsultationSettings(db, organizationId)
  if (!consultation) throw new HTTPError({ statusCode: 500, statusMessage: 'Professional-service consultation settings are missing', data: { code: 'CONSULTATION_SETTINGS_MISSING' } })
  return consultation
}

export async function getPublicCompliance(db: DbClient, organizationId: string): Promise<PublicCompliance | null> {
  const row = await queryFirst<ApiRecord>(db, `
    SELECT json_extract(settings_json, '$.compliance.entity_name') AS entity_name,
           json_extract(settings_json, '$.compliance.dba_name') AS dba_name,
           json_extract(settings_json, '$.compliance.entity_type') AS entity_type,
           json_extract(settings_json, '$.compliance.nonprofit_status') AS nonprofit_status,
           json_extract(settings_json, '$.compliance.registration_number') AS registration_number,
           json_extract(settings_json, '$.compliance.service_area') AS service_area,
           json_extract(settings_json, '$.compliance.service_area_type') AS service_area_type,
           json_extract(settings_json, '$.compliance.disclaimer') AS disclaimer,
           json_extract(settings_json, '$.compliance.footer_disclaimer') AS footer_disclaimer,
           json_extract(settings_json, '$.compliance.founder_name') AS founder_name,
           json_extract(settings_json, '$.compliance.founding_date') AS founding_date,
           json_extract(settings_json, '$.compliance.same_as') AS same_as,
           json_extract(settings_json, '$.compliance.contact_points') AS contact_points,
           json_extract(settings_json, '$.compliance.address_visibility') AS address_visibility
      FROM organization
     WHERE id = ? AND json_type(settings_json, '$.compliance') = 'object'
     LIMIT 1
  `, [organizationId])
  if (!row) return null
  const mediaRows = await queryAll<ApiRecord>(db, `
    SELECT ma.id, ma.public_url, ma.kind, ma.alt_text, ma.file_name,
           mp.slot
      FROM media_placements mp
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
     WHERE mp.organization_id = ? AND mp.owner_type = 'organization' AND mp.owner_id = ?
       AND mp.slot = 'compliance_document' AND mp.status = 'active'
     ORDER BY mp.sort_order
  `, [organizationId, organizationId])
  return {
    entity_name: typeof row.entity_name === 'string' ? row.entity_name : null,
    dba_name: typeof row.dba_name === 'string' ? row.dba_name : null,
    entity_type: typeof row.entity_type === 'string' ? row.entity_type : null,
    nonprofit_status: typeof row.nonprofit_status === 'string' ? row.nonprofit_status : null,
    registration_number: typeof row.registration_number === 'string' ? row.registration_number : null,
    service_area: typeof row.service_area === 'string' ? row.service_area : null,
    service_area_type: typeof row.service_area_type === 'string' ? row.service_area_type : null,
    disclaimer: typeof row.disclaimer === 'string' ? row.disclaimer : null,
    footer_disclaimer: typeof row.footer_disclaimer === 'string' ? row.footer_disclaimer : null,
    media: mediaRows.map(item => ({
      asset_id: String(item.id),
      slot: String(item.slot),
      public_url: typeof item.public_url === 'string' && item.public_url ? item.public_url : null,
      kind: typeof item.kind === 'string' ? item.kind : null,
      alt_text: typeof item.alt_text === 'string' ? item.alt_text : null,
      file_name: typeof item.file_name === 'string' ? item.file_name : null,
    })),
    founder_name: typeof row.founder_name === 'string' ? row.founder_name : null,
    founding_date: typeof row.founding_date === 'string' ? row.founding_date : null,
    same_as: row.same_as ? JSON.parse(row.same_as) as string[] : [],
    contact_points: row.contact_points ? JSON.parse(row.contact_points) as PublicComplianceContactPoint[] : [],
    address_visibility: row.address_visibility === 'visible' ? 'visible' : 'hidden',
  }
}


export async function getPublicBlawbyIdentity(db: DbClient, organizationId: string): Promise<PublicBlawbyIdentity> {
  const [row, placements] = await Promise.all([
    queryFirst<ApiRecord>(db, `
    SELECT s.name, s.brand_description, s.contact_phone
      FROM organization s
     WHERE s.id = ?
     LIMIT 1
    `, [organizationId]),
    loadPublicSocialMedia(db, organizationId, 'organization', [organizationId]),
  ])
  const socialMedia = placements.get(organizationId)

  return {
    name: requiredText(row?.name, `organization ${organizationId}.name`),
    brand_description: typeof row?.brand_description === 'string' ? row.brand_description : null,
    media: (socialMedia?.media ?? []).map(item => ({ asset_id: item.asset_id, slot: item.slot, public_url: item.public_url, thumbnail_url: item.thumbnail_url, kind: item.kind })),
    social_image: socialMedia?.social_image ?? null,
    phone: typeof row?.contact_phone === 'string' ? row.contact_phone : null,
  }
}

export async function getPublicBlawbyShellData(
  db: DbClient,
  organizationId: string,
  sourceLocale: string,
  options: { previewAuthorized?: boolean; locale?: string | null; localizations?: readonly ExactPublicLocalization[]; env?: CloudflareEnv } = {},
): Promise<PublicBlawbyShellData> {
  const locale = options.locale ?? sourceLocale
  const localizations = options.localizations ?? []
  const organizationLocalization = localizations.find(item => item.resourceType === 'organization' && item.resourceId === organizationId) ?? null
  const consultationSettings = getPublicConsultationSettings(db, organizationId)
  const [sourceIdentity, sourceConsultation, sourceCompliance, publishedPages, verification, experienceCollection, bookableServices] = await Promise.all([
    getPublicBlawbyIdentity(db, organizationId),
    consultationSettings,
    getPublicCompliance(db, organizationId),
    listPublishedTenantPagePaths(db, organizationId, locale),
    queryFirst<{ token: string | null }>(db, `
      SELECT (SELECT i.verification_token FROM organization_integrations i WHERE i.organization_id = organization.id AND i.provider = 'google_search_console') AS token
        FROM organization WHERE id = ? LIMIT 1
    `, [organizationId]),
    loadPublicProductCollection(db, organizationId, 'experiences', options.previewAuthorized === true, undefined, options.env),
    consultationSettings.then(settings => settings.mode === 'native'
      ? listOrganizationProducts(db, { organizationId, kind: 'service', publishedOnly: true, bookableOnly: true, env: options.env }).then(products => products.map(publicProduct))
      : []),
  ])
  if (!verification) throw new Error(`Organization ${organizationId} was not found for its Blawby shell`)
  const canSchedule = sourceConsultation.mode === 'native' ? bookableServices.length > 0
    : sourceConsultation.mode === 'external_url' && Boolean(sourceConsultation.external_url)
  const pageLinks = publishedPages.filter(page => page.path !== '/schedule' || canSchedule)
    .map(page => ({ id: page.id, path: page.path, title: page.title }))
  if (experienceCollection?.products.length && !pageLinks.some(page => page.path === '/experiences')) {
    const title = platformLocale(locale)?.messages['saya.footer.experiences']
    if (!title) throw new Error(`Experience navigation label is unavailable for ${locale}`)
    pageLinks.push({ id: 'experiences', path: '/experiences', title })
  }
  const localizedRepresentation = locale !== sourceLocale
  const identity = localizedRepresentation
    ? {
        ...sourceIdentity,
        name: requiredText(organizationLocalization?.values.name, `organization ${organizationId}.${locale}.name`),
        brand_description: typeof organizationLocalization?.values.brand_description === 'string' ? organizationLocalization.values.brand_description : null,
      }
    : sourceIdentity
  let consultation = sourceConsultation
  let compliance = sourceCompliance
  if (localizedRepresentation) {
    const consultationValues = organizationLocalization?.values.consultation as { cta_label?: unknown } | undefined
    consultation = {
      ...sourceConsultation,
      cta_label: requiredText(consultationValues?.cta_label, `organization ${organizationId}.${locale}.consultation.cta_label`),
    }
    const complianceValues = organizationLocalization?.values.compliance as { service_area?: unknown; disclaimer?: unknown; footer_disclaimer?: unknown } | undefined
    compliance = sourceCompliance
      ? {
          ...sourceCompliance,
          service_area: typeof complianceValues?.service_area === 'string' ? complianceValues.service_area : null,
          disclaimer: typeof complianceValues?.disclaimer === 'string' ? complianceValues.disclaimer : null,
          footer_disclaimer: typeof complianceValues?.footer_disclaimer === 'string' ? complianceValues.footer_disclaimer : null,
          media: sourceCompliance.media.map(item => ({ ...item, alt_text: null, file_name: null })),
        }
      : null
  }
  return {
    identity,
    consultation,
    canSchedule,
    compliance,
    pageLinks,
    searchConsoleVerification: verification.token,
  }
}

export async function getPublicBlawbyDocumentData(
  db: DbClient,
  organizationId: string,
  recipe: PublicBlawbyRouteData['recipe'],
  options: { previewAuthorized?: boolean; slug?: string | null; locale?: string | null } = {},
  env: CloudflareEnv,
): Promise<{ shell: PublicBlawbyShellData; route: PublicBlawbyRouteData } | null> {
  const organization = await getActiveBlawbyOrganization(db, organizationId, { previewAuthorized: options.previewAuthorized })
  if (!organization) return null
  const sourceLocale = await getSourceLocale(db, organizationId)
  const locale = options.locale ?? sourceLocale
  const localizations = locale === sourceLocale
    ? []
    : await loadExactPublicLocalizations(env, db, organizationId, locale)

  const [shell, route] = await Promise.all([
    getPublicBlawbyShellData(db, organizationId, sourceLocale, { previewAuthorized: options.previewAuthorized, locale, localizations, env }),
    getPublicBlawbyRouteData(db, organizationId, recipe, sourceLocale, { ...options, locale, localizations }, env),
  ])
  // Which path each recipe's document lives at is declared once, per template,
  // in utils/template-registry.ts; 'page' names its own path.
  const pagePath = recipe === 'page' ? options.slug ?? null : BLAWBY_TEMPLATE.pageDocuments.recipes[recipe] ?? null
  // An article and a post carry their own locale representations.
  if (recipe === 'article' || recipe === 'posts' || recipe === 'experiences') return { shell, route }
  // Every route on this template is a page now, so locale representations
  // come from the document — there is no second resource kind to branch on.
  if (route.page) {
    if (!route.page.localeRepresentations) throw new HTTPError({ statusCode: 500, statusMessage: 'Public page locale representations are unavailable' })
    route.localeRepresentations = route.page.localeRepresentations
  } else {
    route.localeRepresentations = await listPublicLocaleRepresentations(env, db, {
      organizationId,
      sourcePath: pagePath ?? '/',
    })
  }
  return { shell, route }
}

export async function resolvePublicBlawbyDocumentOrThrow(
  db: DbClient,
  organizationId: string,
  recipe: PublicBlawbyRouteData['recipe'],
  options: { previewAuthorized?: boolean; slug?: string | null; locale?: string | null } = {},
  env: CloudflareEnv,
): Promise<{ success: true; shell: PublicBlawbyShellData; route: PublicBlawbyRouteData }> {
  const document = await getPublicBlawbyDocumentData(db, organizationId, recipe, options, env)
  if (!document) {
    throw new HTTPError({
      statusCode: 404,
      statusMessage: 'Blawby is not enabled for this organization',
      data: { code: 'BLAWBY_NOT_ENABLED' },
    })
  }
  if (!hasPublicBlawbyRouteContent(document.route)) {
    throw new HTTPError({
      statusCode: 404,
      statusMessage: 'Route content not found',
      data: { code: 'BLAWBY_ROUTE_NOT_FOUND' },
    })
  }
  return { success: true, ...document }
}

export async function getPublicBlawbyRouteData(
  db: DbClient,
  organizationId: string,
  recipe: PublicBlawbyRouteData['recipe'],
  sourceLocale: string,
  options: { previewAuthorized?: boolean; slug?: string | null; locale?: string | null; localizations?: readonly ExactPublicLocalization[] } = {},
  env: CloudflareEnv,
): Promise<PublicBlawbyRouteData> {
  // Declared once, per template, in utils/template-registry.ts.
  const pagePath = recipe === 'page' ? options.slug ?? null : BLAWBY_TEMPLATE.pageDocuments.recipes[recipe] ?? null
  const localized = options.locale != null && options.locale !== sourceLocale

  const page = pagePath
    ? await getPublicTenantPageForPath(env, db, organizationId, pagePath, {
        locale: options.locale,
        localizations: localized ? options.localizations ?? [] : null,
      })
    : null
  return {
    recipe,
    localeRepresentations: [],
    page,
  }
}

export function hasPublicBlawbyRouteContent(route: PublicBlawbyRouteData): boolean {
  if (route.recipe === 'confirmation' || isBlawbyShellOnlyRouteRecipe(route.recipe)) return true
  return Boolean(route.page)
}
