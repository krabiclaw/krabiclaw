import { defineHandler, HTTPError } from 'nitro'
import { queryFirst } from '~/server/db'
import { createStayHome, placeStayHomePhotosFirst, readStayHome, stayAccessFor, stayHomeInput, stayHomeSetupAddress, updateStayHome } from '~/server/domain/stays'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireStays } from '~/server/utils/cms-capabilities'
import { dashboardOrganizationRequired, dashboardOrgQueryParam, getDashboardMemberContext, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { firstHomeSetupPath } from '~/server/utils/dashboard-links'
import { BATCH_VIEWER, memberAccessPrincipal } from '~/server/utils/member-access'
import { planStayListing } from '~/server/utils/product-management'
import { isRecord } from '~/server/utils/type-guards'
import { STAY_SETUP_DESCRIPTION_LIMIT, STAY_SETUP_TITLE_LIMIT, stayHomeDraftInput, staySetupNightlyRates } from '~/shared/stay-home-setup'
import { isStayAmenityCodes, parseStayMapSharing, STAY_LISTING_TYPES } from '~/shared/stay-listing'
import { coordinatesFailure } from '~/utils/location-map'
import { isCurrencyCode } from '~/shared/currencies'
import { STAY_SAFETY_DETAILS_LIMIT } from '~/shared/stay-safety'
import { prepareStayHomeSetup, stayHomeSetupAddressDefaults, type StayHomeSetupLocation, stayHomeSetupSteps as steps, highlightChoices, disclosures, suggestedDiscounts, propertyGroups, clearStayHomeSetupDraft, readStayHomeSetupDraft, reopenUncommittedStayHomeSetupDraft, stayHomeDraftChanged, stayHomeDraftPhotos, writeStayHomeSetupDraft } from '~/server/utils/stay-home-setup-draft'
import { creationDedupeKey, readCreationRecord } from '~/server/utils/organization-events'

const roomStep = steps.find(step => step.id === 'rooms')!
const highlightStep = steps.find(step => step.id === 'highlights')!
const bookingStep = steps.find(step => step.id === 'booking')!
const discountStep = steps.find(step => step.id === 'discounts')!

export default defineHandler(async (event) => {
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const plan = body.step === undefined ? prepareStayHomeSetup(BATCH_VIEWER) : null
  const initial = plan
    ? await readDashboardMemberResources(event, { slug: dashboardOrgQueryParam(event) ?? (() => { throw dashboardOrganizationRequired() })() }, plan.queries)
    : null
  const { env, db, organization } = initial ?? await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const access = await stayAccessFor(principal)
  if (!access.manage) throw new HTTPError({ statusCode: 403, message: 'Only managers can add a home' })
  if (plan && initial) return jsonResponse(plan.read(initial.rows))
  await requireStays(db, organization.id)
  const defaults = async (locationId?: string) => {
    const main = await queryFirst<StayHomeSetupLocation>(db, `
      SELECT id, address, timezone, latitude, longitude, stay_map_sharing FROM business_locations
      WHERE organization_id = ? AND slug = 'main' AND status = 'active'
        AND ${locationId ? 'id = ?' : 'NOT EXISTS (SELECT 1 FROM product_stay_configs WHERE organization_id = ?)'}
    `, [organization.id, locationId ?? organization.id])
    const address = stayHomeSetupAddressDefaults(main)
    return { main, address }
  }

  const workspace = await queryFirst<{ timezone: string | null; default_currency: string }>(db, 'SELECT timezone, default_currency FROM organization WHERE id = ?', [organization.id])
  if (!isCurrencyCode(workspace?.default_currency)) throw new Error('Workspace is missing its pricing currency')
  const currency = workspace.default_currency
  const current = await readStayHomeSetupDraft(db, organization)

  const index = steps.findIndex(step => step.id === body.step)
  if (index === -1 || !isRecord(body.answers)) throw new HTTPError({ statusCode: 400, message: 'Choose a home setup step and supply its answers' })
  const answers = body.answers
  const step = steps[index]!
  const next = () => jsonResponse({ next: steps[index + 1]!.id })
  const invalid = (field: string, message: string): never => {
    throw new HTTPError({ statusCode: 422, message, data: { code: 'VALIDATION_ERROR', field } })
  }
  if (body.action !== undefined && body.action !== 'exit') return invalid('action', 'Choose a home setup action')
  const revision = body.revision ?? null
  const key = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
  const finishing = step.id === 'disclosures' && body.action !== 'exit'
  const snapshot = () => {
    const { amenities = [], photo_ids = [], ...values } = answers
    const parsed = stayHomeDraftInput.safeParse({ step: step.id, answers: values, amenities, photo_ids, idempotency_key: key })
    if (!parsed.success) return invalid('answers', 'Home setup answers could not be saved')
    if (!isStayAmenityCodes(parsed.data.amenities)) return invalid('amenities', 'Choose amenities from the listing options')
    return parsed.data
  }
  const savedHome = (home: Awaited<ReturnType<typeof readStayHome>>) => jsonResponse({ home, to: firstHomeSetupPath(organization.slug) }, { status: 201 })
  const completedHome = finishing && key && key.length <= 200
    ? await readCreationRecord(db, creationDedupeKey('product', organization.id, key))
    : null
  const retryingFinish = finishing && current?.finishHash && current.idempotency_key === key
  if (current ? !retryingFinish && (current.revision !== revision || current.idempotency_key !== key) : revision !== null && !completedHome) throw stayHomeDraftChanged()
  if (body.action === 'exit') {
    const input = snapshot()
    await stayHomeDraftPhotos(db, organization.id, input.photo_ids)
    await writeStayHomeSetupDraft(db, organization, input, current)
    return jsonResponse({ to: firstHomeSetupPath(organization.slug) })
  }
  if (step.id === 'address-search') return next()
  const address = stayHomeSetupAddress(answers)
  if (step.id === 'address') return next()
  const propertyType = answers.property_type
  const group = propertyGroups.find(([, entry]) => (entry.types as readonly unknown[]).includes(propertyType))
  if (!group) return invalid('property_type', 'Choose a property type')
  if (step.id === 'property') return next()
  const listingType = answers.listing_type
  if (typeof listingType !== 'string' || !Object.hasOwn(STAY_LISTING_TYPES, listingType)) return invalid('listing_type', 'Choose what space guests will have')
  if (step.id === 'access') return next()

  const pin = { latitude: (answers.latitude ?? null) as number | null, longitude: (answers.longitude ?? null) as number | null }
  const pinError = coordinatesFailure(pin)
  if (pinError) return invalid(pinError.field, pinError.error)
  if (step.id === 'pin') return next()
  if (answers.stay_map_sharing !== 'general' && answers.stay_map_sharing !== 'specific') return invalid('stay_map_sharing', 'Choose how to show your location')
  const sharing = parseStayMapSharing(answers.stay_map_sharing)
  if (step.id === 'visibility') return next()

  for (const { key, min, max, step: increment } of roomStep.counts) {
    const value = answers[key]
    if (typeof value !== 'number' || value < min || value > max || !Number.isInteger(value / increment)) {
      return invalid(key, 'Enter a valid room or guest count')
    }
  }
  if (step.id === 'rooms') return next()
  const { property_type_group, property_type, listing_type, bedrooms, beds, bathrooms, amenities } = planStayListing({
    property_type_group: group[0], property_type: propertyType, listing_type: listingType, bedrooms: answers.bedrooms, beds: answers.beds, bathrooms: answers.bathrooms,
    amenities: answers.amenities ?? [],
  })
  if (step.id === 'amenities') return next()
  const photoIds = answers.photo_ids ?? []
  if (!Array.isArray(photoIds) || photoIds.some(id => typeof id !== 'string' || !id)) return invalid('photo_ids', 'Choose photos from your library')
  await stayHomeDraftPhotos(db, organization.id, photoIds)
  if (step.id === 'photos') return next()
  if (typeof answers.name !== 'string' || !answers.name.trim() || answers.name.trim().length > STAY_SETUP_TITLE_LIMIT) return invalid('name', `Enter a listing title of up to ${STAY_SETUP_TITLE_LIMIT} characters`)
  if (step.id === 'title') return next()
  const selected = highlightChoices.filter(choice => answers[choice.value] === 1)
  if (selected.length > highlightStep.max_selections) return invalid('highlights', 'Choose up to two highlights')
  if (step.id === 'highlights') return jsonResponse({ next: steps[index + 1]!.id, suggested_description: selected.map(choice => choice.line).join(' ') })
  if (answers.description !== undefined && (typeof answers.description !== 'string' || answers.description.length > STAY_SETUP_DESCRIPTION_LIMIT)) return invalid('description', `Enter a description of up to ${STAY_SETUP_DESCRIPTION_LIMIT} characters`)

  if (step.id === 'description') return next()
  const minNights = answers.min_nights
  if (typeof minNights !== 'number' || !Number.isInteger(minNights) || minNights < bookingStep.counts[0]!.min || minNights > bookingStep.counts[0]!.max) return invalid('min_nights', 'Enter a valid minimum stay')
  if (step.id === 'booking') return next()
  const base = answers.base_price
  const adjustment = answers.weekend_adjustment ?? 0
  if (typeof base !== 'string') return invalid('base_price', 'Enter a base price')
  if (typeof adjustment !== 'number') return invalid('weekend_adjustment', 'Enter a whole percentage')
  let rates: ReturnType<typeof staySetupNightlyRates>
  try {
    rates = staySetupNightlyRates(base, currency, adjustment)
  } catch (cause) {
    return invalid('pricing', cause instanceof Error ? cause.message : 'Enter a valid price')
  }
  if (step.id === 'pricing') return next()
  const directDiscounts = Object.fromEntries(discountStep.counts.flatMap(({ key, min, max }) => {
    if (answers[`${key}_enabled`] !== 1) return []
    const value = answers[key] ?? suggestedDiscounts[key as keyof typeof suggestedDiscounts]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return invalid(key, 'Enter a whole percentage from 1 to 99')
    return [[key, value]]
  }))
  if (step.id === 'discounts') return next()
  const details = Object.fromEntries(disclosures.flatMap<[string, string | boolean]>(({ key, label, detail_key }) => {
    const selected = answers[key] === 1
    const detail = answers[detail_key]
    if (selected && (typeof detail !== 'string' || !detail.trim() || detail.length > STAY_SAFETY_DETAILS_LIMIT)) {
      return invalid(detail_key, `Add details for ${label.toLowerCase()}`)
    }
    return selected ? [[key, true], [detail_key, String(detail).trim()]] : [[key, false]]
  }))

  if (!key || key.length > 200) throw new HTTPError({ statusCode: 400, message: 'A valid idempotency key is required' })
  let locationId: string | undefined
  if (!completedHome && typeof answers.location_id === 'string' && answers.location_id) {
    const { main, address: original } = await defaults(answers.location_id)
    if (!main) throw new HTTPError({ statusCode: 409, message: 'The starting location changed. Open home setup again.' })
    if (Object.entries(address).every(([key, value]) => (value ?? '') === original[key as keyof typeof original])) locationId = main.id
  }
  const home = stayHomeInput({
    ...address, name: answers.name, internal_name: answers.name, max_guests: answers.max_guests,
    min_nights: minNights, base_price_minor: rates.basePrice,
    calendar_rules: { ...(adjustment === 0 ? {} : { weekend_price_minor: rates.weekendPrice }), direct_discounts: directDiscounts },
    assigned_member_id: organization.memberId,
  })
  home.details = details
  home.listing = { property_type_group, property_type, listing_type, bedrooms, beds, bathrooms, amenities }
  home.description = typeof answers.description === 'string' ? answers.description.trim() : ''
  const existing = completedHome ? await readStayHome(db, access, completedHome.entityId) : null
  if (existing && !current) {
    const replay = await createStayHome(env, db, access, home, key, existing.location_id)
    if (replay.latitude !== pin.latitude || replay.longitude !== pin.longitude || replay.stay_map_sharing !== sharing
      || photoIds.some((id, index) => replay.photos[index]?.id !== id)) throw stayHomeDraftChanged()
    return savedHome(replay)
  }
  if (existing && !current?.finishHash) throw stayHomeDraftChanged()
  const claimed = await writeStayHomeSetupDraft(db, organization, snapshot(), current, true)
  let saved = await createStayHome(env, db, access, home, key, existing?.location_id ?? locationId).catch(async error => {
    if (HTTPError.isError(error) && error.status >= 400 && error.status < 500 && (!isRecord(error.data) || error.data.committed !== true)) {
      await reopenUncommittedStayHomeSetupDraft(db, organization, claimed, key)
    }
    throw error
  })
  if (!saved.live && (saved.latitude !== pin.latitude || saved.longitude !== pin.longitude || saved.stay_map_sharing !== sharing)) {
    saved = (await updateStayHome(env, db, access, saved.product_id, { ...pin, stay_map_sharing: sharing })).home
  }
  if (!saved.live && photoIds.some(id => !saved.photos.some(photo => photo.id === id))) {
    saved = await placeStayHomePhotosFirst(db, env, access, principal, saved.product_id, photoIds)
  }
  await clearStayHomeSetupDraft(db, organization, claimed)
  return savedHome(saved)
})
