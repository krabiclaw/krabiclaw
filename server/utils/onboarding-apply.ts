import { HTTPError } from 'nitro'
import { getSourceLocale } from '~/server/utils/organization-locales'
// Writing an onboarding draft's answers onto its real tenant.
//
// The wizard's answers live in onboarding_drafts while the owner is answering,
// but the tenant they describe is real from the first save: a pending
// organization on its own subdomain, previewable with its preview token and
// invisible to the public until it is activated. Every save re-applies the
// whole draft, so this is a full rebuild and idempotent by construction — the
// same code path that used to run once at commit now runs on each save, which
// is why there is no second "draft renderer" to keep in step with the real one.

import { prepareContentDocumentDeletion, prepareContentDocumentWithBlocks } from '~/server/utils/content/documents'
import { parseOpeningHours, parseSpecialHours } from '~/shared/reservation-hours'
import { getPlaceDetails, googleReviewUpserts } from '~/server/utils/google-places'
import { execute, executeBatch, queryAll, queryFirst, type BatchQuery } from '~/server/db'
import { resourceLocalizationDeletionQueries } from '~/server/utils/localization'
import { getProduct, planProductCreateWrites, publishStayProducts, slugCandidate } from '~/server/utils/product-management'
import { updateLocation } from '~/server/utils/location-management'
import { getDraftMedia, normalizeOnboardingDraftInput, onboardingPublicationMissingFields, readOnboardingDraft, upsertActiveOnboardingDraft, type OnboardingDraftInput, onboardingDraftWriteGuard, onboardingPageBlocks, onboardingPagePath, onboardingPageType, parseOnboardingDraftPayload, readActiveOnboardingDraft, type OnboardingDraftPayload, type SavedOnboardingDraft } from '~/server/utils/onboarding-drafts'
import { createMediaAsset, insertInitialMediaPlacements, type CreateInput } from '~/server/utils/media-asset-manager'
import { applyOnboardingTenantPages, getPublishedTenantPage, prepareTenantPageDelete, refreshTenantPageCard } from '~/server/utils/content/pages'
import { activateOrganization, completeOnboarding, createOrganization, provisionOrganization, type OrganizationProvisioningResult } from '~/server/utils/organization-provisioning'
import { isOrganizationWideRole, resolveUserOrganization } from '~/server/utils/member-access'
import { organizationPublicUrl } from '~/server/utils/domains'
import { refreshSocialCard } from '~/server/utils/social-card'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { OrganizationVertical } from '~/utils/vertical-copy'
import type { CurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { starterPalette } from '~/shared/site-palette'
import { resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { parseLogoPresentation } from '~/shared/media-placement-contract'
import { creationRequestHash } from '~/server/utils/organization-events'

type ProvisioningEnv = Parameters<typeof provisionOrganization>[0]

export interface OnboardingTarget {
  vertical: OrganizationVertical
  organizationId: string
  subdomain: string
  locationId: string
  locationSlug: string | null
  /** The two answers a site cannot exist without, checked before it was created. */
  defaultCurrency: CurrencyCode
  timezone: string
}

/** A draft's answers, as they are stored while the owner is still answering. */
export interface OnboardingDraftRow {
  id: string
  updated_at: string
  organization_id: string | null
  name: string
  vertical: OrganizationVertical
  subdomain_candidate: string
  source_locale: string | null
  default_currency: CurrencyCode | null
  timezone: string | null
}

export async function saveOnboardingDraft(env: CloudflareEnv, db: D1Database, userId: string, input: OnboardingDraftInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HTTPError({ statusCode: 400, statusMessage: 'Website answers must be an object' })
  if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== 'string' || input.draftId !== undefined && typeof input.draftId !== 'string' || input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== null && typeof input.expectedUpdatedAt !== 'string') throw new HTTPError({ statusCode: 400, statusMessage: 'Draft identity, revision and creation key must be text' })
  const key = input.idempotencyKey?.trim()
  const keyedId = key ? `mcp-website-${await creationRequestHash({ userId, key })}` : undefined
  const existingRow = input.draftId || keyedId
    ? await queryFirst<SavedOnboardingDraft>(db, 'SELECT * FROM onboarding_drafts WHERE id = ? AND user_id = ?', [input.draftId ?? keyedId!, userId])
    : await readActiveOnboardingDraft(db, userId)
  if (input.draftId && !existingRow) throw new HTTPError({ statusCode: 404, statusMessage: 'Website draft not found' })
  if (existingRow && input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== null && existingRow.updated_at !== input.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; read it before saving', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: existingRow.id } })
  if (existingRow?.status === 'abandoned') throw new HTTPError({ statusCode: 409, statusMessage: 'This website draft was discarded', data: { code: 'ONBOARDING_DRAFT_ABANDONED', draft_id: existingRow.id } })
  const existing = existingRow ? parseOnboardingDraftPayload(existingRow.payload_json) : null
  if (existing && existingRow) existing.preview.subdomainCandidate = existingRow.subdomain_candidate
  const sourceType = input.sourceType ?? existing?.source.type ?? 'manual'
  if (sourceType !== 'manual' && sourceType !== 'google_places') throw new HTTPError({ statusCode: 400, statusMessage: 'sourceType must be manual or google_places' })
  let place: Parameters<typeof normalizeOnboardingDraftInput>[2] = null
  if (sourceType === 'google_places') {
    const placeId = typeof input.placeId === 'string' ? input.placeId.trim() : existing?.source.placeId
    if (!placeId) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a Google place before importing it' })
    if (existing?.source.place?.placeId === placeId) place = existing.source.place
    else {
      if (!env.GOOGLE_PLACES_API_KEY) throw new HTTPError({ statusCode: 503, statusMessage: 'Google Places API key not configured' })
      place = await getPlaceDetails(env.GOOGLE_PLACES_API_KEY, placeId)
    }
  }
  const payload = normalizeOnboardingDraftInput(input, existing, place)
  const draft = await upsertActiveOnboardingDraft(db, {
    userId, name: payload.preview.brandName, vertical: payload.preview.vertical, sourceType, payload,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null, draftId: input.draftId, idempotencyKey: key,
  })
  const saved = await readOnboardingDraft(db, userId, draft.id)
  if (saved.row.status === 'committed') return saved
  const target = await ensureOnboardingTarget(env, db, userId, {
    id: draft.id, updated_at: draft.updatedAt, organization_id: draft.organizationId,
    name: draft.payload.preview.brandName, vertical: draft.payload.preview.vertical,
    subdomain_candidate: draft.subdomainCandidate, source_locale: draft.payload.source.details.sourceLocale,
    default_currency: draft.payload.source.details.currency, timezone: draft.payload.source.details.timezone,
  })
  if ('error' in target) throw new HTTPError({ statusCode: target.status, statusMessage: target.error, data: { ...target.data, draft_id: draft.id } })
  const applied = await applyOnboardingDraft(env, db, {
    userId, target: target.target, payload: draft.payload,
    draft: { id: draft.id, user_id: userId, updated_at: draft.updatedAt },
  })
  if ('error' in applied) throw new HTTPError({ statusCode: applied.status, statusMessage: applied.error, data: { draft_id: draft.id } })
  return readOnboardingDraft(db, userId, draft.id)
}

export async function activateOnboardingDraft(env: CloudflareEnv, db: D1Database, input: {
  userId: string
  draftId: string
  expectedUpdatedAt: string
  origin: { headers: Headers } | null
  activateSession?: (_organizationId: string) => Promise<void>
}) {
  let draft = await queryFirst<SavedOnboardingDraft | null>(db,
    'SELECT * FROM onboarding_drafts WHERE id = ? AND user_id = ? LIMIT 1', [input.draftId, input.userId])
  if (!draft) throw new HTTPError({ statusCode: 404, statusMessage: 'Draft not found' })
  if (draft.status === 'committing') draft = await readActiveOnboardingDraft(db, input.userId)
  if (!draft || draft.id !== input.draftId || !['active', 'committed'].includes(draft.status)) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft is no longer available', data: { code: 'ONBOARDING_DRAFT_UNAVAILABLE', draft_id: input.draftId } })
  const payload = parseOnboardingDraftPayload(draft.payload_json)
  const { currency, timezone, sourceLocale } = payload.source.details
  const missingFields = onboardingPublicationMissingFields(draft, payload)
  if (missingFields.length) throw new HTTPError({ statusCode: 400, statusMessage: `Missing website fields: ${missingFields.join(', ')}`, data: { code: 'ONBOARDING_INCOMPLETE', draft_id: draft.id, missing_fields: missingFields } })
  if (!currency || !sourceLocale || !timezone) throw new Error('Validated website setup has missing values')
  let organizationId = draft.organization_id
  if (organizationId) {
    const membership = await resolveUserOrganization(env, { userId: input.userId, organizationId })
    if (!membership || !isOrganizationWideRole(membership.role)) throw new HTTPError({ statusCode: 403, statusMessage: 'Organization-level access required', data: { code: 'WEBSITE_CREATION_ACCESS_DENIED', draft_id: draft.id, organization_id: organizationId } })
  }
  const existing = organizationId ? await queryFirst<{ onboarding_status: string }>(db,
    'SELECT onboarding_status FROM organization WHERE id = ?', [organizationId]) : null
  const live = existing?.onboarding_status === 'active'
  if (!live) {
    if (draft.updated_at !== input.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; read it before publishing', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: draft.id } })
    const revision = new Date(Math.max(Date.now(), Date.parse(draft.updated_at) + 1)).toISOString()
    const claim = await execute(db, "UPDATE onboarding_drafts SET updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active' AND updated_at = ?", [revision, draft.id, input.userId, draft.updated_at])
    if (!claim.meta.changes) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; retry the same request', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: draft.id, organization_id: organizationId } })
    draft.updated_at = revision
  }
  try {
    if (!live) {
      const target = await ensureOnboardingTarget(env, db, input.userId, { ...draft, source_locale: sourceLocale, default_currency: currency, timezone })
      if ('error' in target) throw new HTTPError({ statusCode: target.status, statusMessage: target.error, data: target.data })
      organizationId = target.target.organizationId
      const applied = await applyOnboardingDraft(env, db, { userId: input.userId, target: target.target, payload, draft, activate: true })
      if ('error' in applied) throw new HTTPError({ statusCode: applied.status, statusMessage: applied.error })
    }
    if (!organizationId) throw new Error('Activated website has no organization')
    const now = new Date().toISOString()
    if (live) await execute(db, "UPDATE onboarding_drafts SET status = 'committed', committed_at = COALESCE(committed_at, ?), updated_at = ? WHERE id = ? AND user_id = ? AND organization_id = ? AND EXISTS (SELECT 1 FROM organization WHERE id = ? AND onboarding_status = 'active')", [now, now, draft.id, input.userId, organizationId, organizationId])
    const completion = await completeOnboarding(env, db, organizationId, input.origin)
    try {
      if (input.activateSession) await input.activateSession(organizationId)
      await refreshSocialCard({ db, env, owner: { owner_type: 'organization', owner_id: organizationId }, actorId: input.userId })
    } finally {
      await purgePublicResourceCacheNow(env, organizationId)
    }
    const organization = await resolveUserOrganization(env, { userId: input.userId, organizationId })
    const locations = await queryAll<{ id: string; slug: string | null }>(db, "SELECT id, slug FROM business_locations WHERE organization_id = ? AND status = 'active' ORDER BY created_at, id LIMIT 1", [organizationId])
    const publicUrl = await organizationPublicUrl(env, db, organizationId)
    const site = await queryFirst<{ onboarding_status: string }>(db, 'SELECT onboarding_status FROM organization WHERE id = ?', [organizationId])
    const homepage = await getPublishedTenantPage(db, organizationId, '/', sourceLocale)
    if (!organization || site?.onboarding_status !== 'active' || !homepage?.blocks.length || !locations.length || !publicUrl) throw new Error('Activated website could not be read back')
    if (completion.measurement.status === 'failed' || completion.operator_email.status === 'failed') {
      throw new Error([completion.measurement.status === 'failed' ? completion.measurement.reason : null, completion.operator_email.status === 'failed' ? completion.operator_email.reason : null].filter(Boolean).join('; '))
    }
    return { organizationId, orgSlug: organization.slug, subdomain: draft.subdomain_candidate, locationId: locations[0]!.id, locationSlug: locations[0]!.slug, publicUrl, ...completion }
  } catch (error) {
    const recorded = await queryFirst<{ organization_id: string | null; onboarding_status: string | null }>(db,
      'SELECT d.organization_id, o.onboarding_status FROM onboarding_drafts d LEFT JOIN organization o ON o.id = d.organization_id WHERE d.id = ?', [draft.id])
    const current = await queryFirst<{ updated_at: string; status: string }>(db, 'SELECT updated_at, status FROM onboarding_drafts WHERE id = ? AND user_id = ?', [draft.id, input.userId])
    if (!live && current && (current.updated_at !== draft.updated_at || current.status !== 'active') && recorded?.onboarding_status !== 'active') throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft changed; retry the same request', data: { code: 'ONBOARDING_DRAFT_CHANGED', draft_id: draft.id, organization_id: recorded?.organization_id ?? null }, cause: error })
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500
    const details = error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object' ? error.data : {}
    const message = error && typeof error === 'object' && 'statusMessage' in error && typeof error.statusMessage === 'string' ? error.statusMessage : error instanceof Error ? error.message : String(error)
    throw new HTTPError({ statusCode, statusMessage: message, data: { code: 'WEBSITE_CREATION_FAILED', ...details, draft_id: draft.id, organization_id: recorded?.organization_id ?? null }, cause: error })
  }
}

function summarizeBatchQueries(batchQueries: BatchQuery[]) {
  return batchQueries.map((entry, index) => ({
    index, statement: entry.query.trim().split(/\s+/).slice(0, 12).join(' '), params: Array.isArray(entry.params) ? entry.params.length : 0, }))
}

/**
 * Media assets carry the draft's own asset id, so re-applying a draft must not
 * insert the same asset twice.
 */
async function ensureMediaAsset(db: D1Database, data: CreateInput & { category?: string; status?: string; created_by_user_id?: string }, writeGuard: BatchQuery) {
  const existing = await queryFirst<{ id: string }>(db, 'SELECT id FROM media_assets WHERE id = ? LIMIT 1', [data.id])
  if (existing) return
  await createMediaAsset(db, data, undefined, writeGuard)
}

/**
 * Reuse the draft's pending native organization across interrupted provisioning.
 * Once its website address is claimed, later saves keep that address.
 */
export async function ensureOnboardingTarget(
  env: CloudflareEnv,
  db: D1Database,
  userId: string,
  draft: OnboardingDraftRow,
): Promise<{ target: OnboardingTarget } | { error: string; status: number; data?: Record<string, unknown> }> {
  if (!draft.source_locale) return { status: 400, error: 'Choose a supported website language' }
  // The site is created here, and it cannot exist without these two answers.
  if (!draft.default_currency) return { status: 400, error: 'Choose the currency you price in', data: { missing_fields: ['currency'] } }
  if (!isValidTimezone(draft.timezone)) return { status: 400, error: 'Choose your timezone', data: { missing_fields: ['timezone'] } }
  const revision = { id: draft.id, user_id: userId, updated_at: draft.updated_at }
  const writeGuard = onboardingDraftWriteGuard(revision)
  await executeBatch(db, [writeGuard])
  let organizationId = draft.organization_id
  if (!organizationId) {
    const created = await createOrganization(env, userId, draft.name, { draftId: draft.id, slug: draft.subdomain_candidate }, { defaultCurrency: draft.default_currency, timezone: draft.timezone })
    await executeBatch(db, [writeGuard, {
      query: 'UPDATE onboarding_drafts SET organization_id = ? WHERE id = ? AND user_id = ? AND organization_id IS NULL',
      params: [created.organizationId, draft.id, userId],
    }])
    const claimed = await queryFirst<{ organization_id: string | null }>(db, `
      SELECT organization_id FROM onboarding_drafts WHERE id = ? LIMIT 1
    `, [draft.id])
    if (!claimed?.organization_id) return { status: 500, error: 'Could not record the new organization.' }
    if (claimed.organization_id !== created.organizationId) return { status: 409, error: 'Website draft organization changed; retry the same request.' }
    organizationId = claimed.organization_id
  }

  const membership = await resolveUserOrganization(env, { userId, organizationId })
  if (!membership || !isOrganizationWideRole(membership.role)) return { status: 403, error: 'Organization-level access required.' }
  const existing = await queryFirst<{ subdomain: string | null; vertical: string; onboarding_status: string; locale: string | null; has_domain: number }>(db, `
    SELECT o.subdomain, o.vertical, o.onboarding_status, l.locale,
      EXISTS(SELECT 1 FROM organization_domains WHERE organization_id = o.id AND type = 'subdomain' AND status = 'active') AS has_domain
    FROM organization o LEFT JOIN organization_locales l ON l.organization_id = o.id AND l.is_source = 1 WHERE o.id = ?
  `, [organizationId])
  if (existing?.locale && existing.locale !== draft.source_locale) return { status: 409, error: 'Existing website content cannot be relabelled into another language.' }
  const complete = existing?.onboarding_status === 'pending' && existing.subdomain === draft.subdomain_candidate && existing.vertical === draft.vertical && existing.locale === draft.source_locale && existing.has_domain
  const result: OrganizationProvisioningResult = complete ? { status: 200, data: { subdomain: existing!.subdomain } } : await provisionOrganization(env as ProvisioningEnv, db, userId, {
    organizationId,
    name: draft.name,
    subdomain: draft.subdomain_candidate,
    vertical: draft.vertical,
    sourceLocale: draft.source_locale,
    activate: false,
    origin: null,
    writeGuard: onboardingDraftWriteGuard(revision, organizationId),
  })
  if (result.status !== 200) {
    await executeBatch(db, [onboardingDraftWriteGuard(revision, organizationId)])
    return {
      status: result.status || 500,
      error: typeof result.data.error === 'string' ? result.data.error : 'Could not provision this organization. Please try again.',
      data: result.data,
    }
  }
  const subdomain = result.data.subdomain as string

  // An onboarding tenant has exactly one location. More than one means something
  // seeded a second one, which would make every later save ambiguous, so this
  // refuses rather than picking.
  const locations = await queryAll<{ id: string; slug: string | null }>(db, `
    SELECT id, slug FROM business_locations
     WHERE organization_id = ? AND status = 'active'
    ORDER BY created_at, id
  `, [ organizationId])
  if (locations.length !== 1) {
    return {
      status: 500,
      error: locations.length === 0
        ? 'No active location found for this organization.'
        : `This organization has ${locations.length} locations; onboarding expects one.`,
    }
  }

  return {
    target: {
      vertical: draft.vertical,
      organizationId,
      subdomain,
      locationId: locations[0]!.id,
      locationSlug: locations[0]!.slug,
      defaultCurrency: draft.default_currency,
      timezone: draft.timezone,
    },
  }
}

/** Applies every answer in the draft to its tenant. Safe to call on every save. */
export async function applyOnboardingDraft(
  env: CloudflareEnv,
  db: D1Database,
  input: {
    userId: string
    target: OnboardingTarget
    payload: OnboardingDraftPayload
    draft: Pick<SavedOnboardingDraft, 'id' | 'user_id' | 'updated_at'>
    activate?: boolean
  },
): Promise<{ locationSlug: string | null } | { error: string; status: number }> {
  const { userId, payload } = input
  // The organization was created with these answers; a later save while the
  // site is pending writes a changed answer back.
  const { organizationId, defaultCurrency, timezone } = input.target
  const writeGuard = onboardingDraftWriteGuard(input.draft, organizationId)
  const locationRow = { id: input.target.locationId }
  const organization = await queryFirst<{ onboarding_status: string | null; has_bookings: number }>(db, `
    SELECT onboarding_status, EXISTS(SELECT 1 FROM bookings WHERE organization_id = organization.id) AS has_bookings
      FROM organization WHERE id = ? LIMIT 1
  `, [organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  if (organization.onboarding_status !== 'pending' || organization.has_bookings) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Onboarding can only replace a pending site with no bookings', data: { code: 'ONBOARDING_REBUILD_NOT_ALLOWED' } })
  }

  const settingsQueries: BatchQuery[] = [{ query: `
      UPDATE organization
      SET default_currency = ?, timezone = ?, updated_at = ?
      WHERE id = ?
    `, params: [defaultCurrency, timezone, new Date().toISOString(), organizationId] }]

  // The look the owner chose in the brand step: a starter palette and a font,
  // written to the site so the preview and the launched site both wear them.
  const draftConfig = payload.preview.config
  if (typeof draftConfig.palette_starter === 'string') {
    settingsQueries.push({ query: 'UPDATE organization SET settings_json = json_set(settings_json, \'$.config.palette\', json(?)) WHERE id = ?',
      params: [JSON.stringify(starterPalette(draftConfig.palette_starter)), organizationId] })
  }
  if (typeof draftConfig.font_preset === 'string') {
    settingsQueries.push({ query: 'UPDATE organization SET settings_json = json_set(settings_json, \'$.config.font_preset\', ?) WHERE id = ?',
      params: [resolveOrganizationFontPreset(draftConfig.font_preset), organizationId] })
  }
  if (settingsQueries.length) await executeBatch(db, [writeGuard, ...settingsQueries])
  const logoPresentation = typeof draftConfig.logo_shape === 'string'
    ? parseLogoPresentation({ shape: draftConfig.logo_shape, focus: { x: 0.5, y: 0.5 } })
    : null

  const logoDraftImage = getDraftMedia(payload, 'logo')
  const heroDraftImage = getDraftMedia(payload, 'hero')
  const heroAssetId = heroDraftImage?.draftAssetId ?? null

  if (logoDraftImage) {
    await ensureMediaAsset(db, {
      id: logoDraftImage.draftAssetId, organization_id: organizationId, kind: 'image', provider: 'cloudflare_images', source: 'uploaded', cloudflare_image_id: logoDraftImage.cloudflareImageId, public_url: logoDraftImage.publicUrl, thumbnail_url: logoDraftImage.thumbnailUrl, mime_type: logoDraftImage.mimeType, file_name: logoDraftImage.fileName, file_size: logoDraftImage.fileSize, status: 'active', created_by_user_id: userId, }, writeGuard)
    await executeBatch(db, [writeGuard, ...insertInitialMediaPlacements({ organizationId, placement: { owner_type: 'organization', owner_id: organizationId, slot: 'logo' }, media: [{ asset_id: logoDraftImage.draftAssetId, presentation: logoPresentation }] })])
  }

  if (heroDraftImage) {
    await ensureMediaAsset(db, {
      id: heroDraftImage.draftAssetId, organization_id: organizationId, kind: 'image', provider: 'cloudflare_images', source: 'uploaded', cloudflare_image_id: heroDraftImage.cloudflareImageId, public_url: heroDraftImage.publicUrl, thumbnail_url: heroDraftImage.thumbnailUrl, mime_type: heroDraftImage.mimeType, file_name: heroDraftImage.fileName, file_size: heroDraftImage.fileSize, category: 'other', status: 'active', created_by_user_id: userId, }, writeGuard)
    // The photo is the home page's hero and the business's sharing image. It
    // is not also the location's hero: the location, its card and its email
    // resolve to the sharing image until the owner gives the location its own.
    await executeBatch(db, [writeGuard, ...insertInitialMediaPlacements({ organizationId, placement: { owner_type: 'organization', owner_id: organizationId, slot: 'social_share' }, media: [{ asset_id: heroDraftImage.draftAssetId }] })])
  }

  const draftLocation = payload.preview.locations.find(location => location.id === 'draft-location-main')
  let updatedSlug: string | null = input.target.locationSlug
  if (draftLocation) {
    // buildOnboardingDraftPayload always derives the location slug from the brand name.
    updatedSlug = draftLocation.slug
    const updateResult = await updateLocation(db, organizationId, locationRow.id, {
      title: draftLocation.title, slug: updatedSlug, address: draftLocation.address, description: draftLocation.description, phone: draftLocation.phone, website_url: draftLocation.website_url, opening_hours: parseOpeningHours(draftLocation.opening_hours), special_hours: parseSpecialHours(draftLocation.special_hours), rating: draftLocation.rating, review_count: draftLocation.review_count, timezone: payload.source.details.timezone, status: 'active', maps_url: payload.source.place?.mapsUrl, google_place_id: payload.source.placeId, }, userId, env, writeGuard)

    // updateLocation answers with a status and a message naming the field it
    // refused — a 400 for an unusable timezone or notification phone, a 409 for
    // a slug already taken. Rethrowing those as a bare Error turned every one of
    // them into a 500 that told the owner nothing about what to change, so the
    // status and the message travel back to the caller intact.
    if (updateResult.status !== 200) {
      await executeBatch(db, [writeGuard])
      return {
        status: updateResult.status,
        error: typeof updateResult.data?.error === 'string'
          ? updateResult.data.error
          : 'Location update failed.',
      }
    }
  }

  const contentByPage = new Map<string, typeof payload.preview.content>()
  for (const row of payload.preview.content) {
    const rows = contentByPage.get(row.page) ?? []
    rows.push(row)
    contentByPage.set(row.page, rows)
  }
  await applyOnboardingTenantPages(db, {
    env,
    writeGuard,
    organizationId, userId: userId, pages: [...contentByPage].map(([pageName, rows]) => {
      const pageType = onboardingPageType(pageName)
      // The draft is the whole document. Onboarding does not collect SEO
      // metadata or an explicit order, so it states null for them rather than
      // leaving them to whatever a previous commit wrote.
      return {
        path: onboardingPagePath(pageName), title: rows.find(row => row.field === 'hero')?.hero_title ?? pageName, pageType, recipe: pageName, blocks: onboardingPageBlocks(rows), trustedSystemPage: pageType === 'system',
        summary: null, seoTitle: null, seoDescription: null, canonicalUrl: null, robots: null, sortOrder: null, }
    }), })

  for (const [pageName, rows] of contentByPage) {
    for (const row of rows) {
      const assetId = pageName === 'home' && row.field === 'hero' ? heroAssetId : row.asset_id
      if (!assetId) continue
      const block = await queryFirst<{ id: string }>(db, `
        SELECT cb.id FROM content_blocks cb
        JOIN content_documents d ON d.id = cb.document_id AND d.kind = 'page' AND d.row_role = 'root'
        WHERE d.organization_id = ? AND d.path = ?
          AND (cb.type = 'hero' AND ? = 'hero' OR json_extract(cb.data_json, '$.field') = ?)
        ORDER BY cb.position LIMIT 1
      `, [organizationId, onboardingPagePath(pageName), row.field, row.field])
      if (block) {
        const slot = row.field === 'hero' ? 'media' : row.field.endsWith('.image') ? row.field : 'gallery'
        await executeBatch(db, [writeGuard, ...insertInitialMediaPlacements({ organizationId, placement: { owner_type: 'content_block', owner_id: block.id, slot }, media: [{ asset_id: assetId }] })])
      }
    }
  }

  // The catalogue rebuild (Products/qa/reviews delete+insert) runs as a
  // guarded atomic D1 batch, so a failure partway through
  // never leaves the tenant with half-cleared content — see incident notes for why
  // sequential execute() calls here are unsafe.
  const now = new Date().toISOString()
  const orderedProducts = [...payload.preview.products].sort((a, b) => a.sort_order - b.sort_order)

  // Products go in through the one canonical writer, which owns variants,
  // prices and slugs. This replaces the whole imported catalogue: the previous
  // import's Products are removed first, so re-running onboarding does not
  // leave two copies of every dish.
  const previouslyImported = await queryAll<{ id: string; kind: string }>(db, `
    SELECT p.id, p.kind FROM products p
    JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id 
    WHERE p.organization_id = ? AND p.source = 'import'
  `, [ organizationId])
  const deletedHomes = await Promise.all(previouslyImported.filter(product => product.kind === 'stay').map(product => getProduct(db, organizationId, product.id)))
  const boundPages = previouslyImported.length ? await queryAll<{ id: string; path: string; updated_at: string }>(db, `
    SELECT id, path, updated_at FROM content_documents
     WHERE organization_id = ? AND kind = 'page' AND row_role = 'root'
       AND product_id IN (SELECT value FROM json_each(?))
  `, [organizationId, JSON.stringify(previouslyImported.map(row => row.id))]) : []
  const pageDeletions = await Promise.all(boundPages.map(page => prepareTenantPageDelete(db, page.id, { scope: { organizationId }, expectedUpdatedAt: page.updated_at })))
  const batchQueries: BatchQuery[] = previouslyImported.length
    ? [
        ...pageDeletions.flatMap(page => page.queries),
        ...resourceLocalizationDeletionQueries('product', { query: 'SELECT value FROM json_each(?)', params: [JSON.stringify(previouslyImported.map(row => row.id))] }),
        { query: `DELETE FROM products WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))`, params: [organizationId, JSON.stringify(previouslyImported.map(row => row.id))] },
      ]
    : []

  let productIds: string[] = []
  let productPages: Array<{ variantId: string; path: string }> = []
  if (orderedProducts.length) {
    const { ids, queries, pages } = await planProductCreateWrites(db, {
      organizationId, env, replacedProductIds: new Set(previouslyImported.map(product => product.id)), replacedPages: new Map(boundPages.map(page => [page.path, page.id])),
      actor: { actorId: userId },
      now,
      products: orderedProducts.map(product => ({
        kind: input.target.vertical === 'restaurant' ? 'dish' : input.target.vertical === 'service' ? 'service' : 'item',
        name: product.name,
        description: product.description,
        order_url: product.order_url,
        source: product.source,
        // What a customer buys is a variant, and the price belongs to it. A
        // Product the owner did not price gets a variant with no price, which
        // reads as "not purchasable here" rather than as a price of zero.
        variants: [{
          name: product.name,
          // The writer resolves the organization's currency for a price that
          // names none — it reads the row this function has already updated —
          // so resolving it a second time here could only disagree with it.
          prices: product.price ? [product.price] : [],
        }],
      })),
    })
    batchQueries.push(...queries)
    productPages = pages

    // Publication and location membership are separate rows, and onboarding
    // states both explicitly.
    orderedProducts.forEach((product, index) => {
      const productId = ids[index]!
      batchQueries.push({
        query: `INSERT INTO product_publications (organization_id, product_id, published, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, 1, ?, ?, ?, ?)`,
        params: [organizationId, productId, now, now, userId, userId],
      })
      batchQueries.push({
        query: `INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        params: [organizationId, productId, locationRow.id, now, now, userId, userId],
      })
    })
    productIds = ids
  }

  // The owner's sections are the organization's whole set of collections while
  // the tenant is pending, so each save reconciles that set: a section keeps its
  // collection (and its id and slug) across saves by name, a section the owner
  // renamed or emptied loses its collection, and every section is ordered as
  // the owner ordered it. Slugs come from the canonical collection slug rule,
  // suffixed within this organization, so two sections never share a row.
  const existingCollections = await queryAll<{ id: string; name: string; slug: string }>(db, `
    SELECT id, name, slug FROM collections WHERE organization_id = ? AND location_id IS NULL
  `, [organizationId])
  const sectionNames = [...new Set(orderedProducts.map(product => product.collection))]
  const kept = new Map(existingCollections.filter(row => sectionNames.includes(row.name)).map(row => [row.name, row]))
  const retired = existingCollections.filter(row => !kept.has(row.name)).map(row => row.id)
  if (retired.length) {
    const retiredIds = JSON.stringify(retired)
    batchQueries.push(
      ...resourceLocalizationDeletionQueries('collection', { query: 'SELECT value FROM json_each(?)', params: [retiredIds] }),
      { query: "DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'collection' AND owner_id IN (SELECT value FROM json_each(?))", params: [organizationId, retiredIds] },
      { query: 'DELETE FROM collections WHERE organization_id = ? AND location_id IS NULL AND id IN (SELECT value FROM json_each(?))', params: [organizationId, retiredIds] },
    )
  }
  const takenSlugs = new Set([...kept.values()].map(row => row.slug))
  const collectionIds = new Map<string, string>()
  sectionNames.forEach((name, sortOrder) => {
    const existing = kept.get(name)
    if (existing) {
      collectionIds.set(name, existing.id)
      batchQueries.push({
        query: 'UPDATE collections SET sort_order = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?',
        params: [sortOrder, now, userId, organizationId, existing.id],
      })
      return
    }
    let attempt = 0
    while (takenSlugs.has(slugCandidate(name, attempt))) attempt += 1
    const slug = slugCandidate(name, attempt)
    takenSlugs.add(slug)
    const id = crypto.randomUUID()
    collectionIds.set(name, id)
    batchQueries.push({
      query: `INSERT INTO collections (id, organization_id, location_id, name, slug, sort_order, created_at, updated_at, created_by, updated_by)
              VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, organizationId, name, slug, sortOrder, now, now, userId, userId],
    })
  })
  // Membership of a kept collection went with the products the previous save
  // imported (collection_products cascades from products), so every dish is
  // placed again under the id resolved above.
  orderedProducts.forEach((product, index) => {
    batchQueries.push({
      query: `INSERT INTO collection_products (organization_id, collection_id, product_id, sort_order, created_at, updated_at, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [organizationId, collectionIds.get(product.collection)!, productIds[index]!, index, now, now, userId, userId],
    })
  })

  // Onboarding writes the questions it drafted; the organization's posts are its own, so a re-apply leaves them.
  const replaced = await queryAll<{ id: string }>(db, "SELECT id FROM content_documents WHERE organization_id = ? AND row_role = 'root' AND kind = 'qa'", [organizationId])
  for (const document of replaced) batchQueries.push(...prepareContentDocumentDeletion({ documentId: document.id, organizationId }))
  for (const item of payload.preview.qa) batchQueries.push(...prepareContentDocumentWithBlocks({
    id: item.id, organizationId, kind: 'qa', rowRole: 'root', locale: await getSourceLocale(db, organizationId), locationId: locationRow.id,
    title: item.question, summary: item.answer, source: 'template', status: 'published', sortOrder: item.sort_order,
    metadata: { answer_author: item.answer_author, is_owner_answer: 1, upvote_count: 0 },
  }, []).queries)

  batchQueries.push(...googleReviewUpserts({ organizationId, locationId: locationRow.id }, payload.preview.reviews, now))

  try {
    // A draft with nothing in it yet — the owner has answered only the name —
    // writes nothing, and D1 rejects an empty batch outright.
    if (batchQueries.length) await executeBatch(db, [writeGuard, ...batchQueries])
  } catch (batchError) {
    console.error('onboarding_apply_batch_failed', {
      organizationId, batchSize: batchQueries.length, contentRows: payload.preview.content.length, products: payload.preview.products.length, qaRows: payload.preview.qa.length, reviews: payload.preview.reviews.length, queries: summarizeBatchQueries(batchQueries), error: batchError instanceof Error ? {
        name: batchError.name, message: batchError.message, stack: batchError.stack, } : String(batchError), })
    throw batchError
  }
  await publishStayProducts(env, deletedHomes)
  for (const page of productPages) await refreshTenantPageCard(db, env, page, userId)
  if (input.activate) await activateOrganization(db, organizationId, writeGuard, input.draft)
  return { locationSlug: updatedSlug }
}
