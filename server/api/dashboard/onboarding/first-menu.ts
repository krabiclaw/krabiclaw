import { defineHandler, HTTPError } from 'nitro'
import { getQuery, readBody } from 'nitro/h3'
import { z } from 'zod'
import { execute, queryFirst } from '~/server/db'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertOrganizationWideAccess, assertRoleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { firstMenuSectionSetupPath } from '~/server/utils/dashboard-links'
import { getLocation } from '~/server/utils/location-management'
import { createCollection, createProduct, listCollectionProducts, listCollections, resolveVariantPrice, updateCollection, updateProduct } from '~/server/utils/product-management'
import { firstMenuSetupApplies, parseOnboardingDraftPayload } from '~/server/utils/onboarding-drafts'
import { organizationPublicUrl } from '~/server/utils/domains'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { locationSurfacePath } from '~/utils/product-presentation'
import { getMediaPlacements, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { PRODUCT_LIMITS } from '~/shared/product-limits'

const stages = ['section', 'dish', 'price', 'photo', 'review'] as const
const stageId = z.enum(stages)
const answer = z.object({
  value: z.string().trim().max(256).nullable(),
  record_id: z.string().nullable(),
  version: z.string().nullable(),
  exit: z.boolean(),
})

export default defineHandler(async (event) => {
  const { db, env, organization, userId } = await getDashboardMemberContext(event)
  if (organization.vertical !== 'restaurant' || organization.onboarding_status !== 'active' || organization.status !== 'inactive') {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Menu setup is unavailable for this website' })
  }
  const principal = memberAccessPrincipal(organization, { env, event })
  await assertOrganizationWideAccess(db, principal)
  await assertRoleAllows({ ...principal, permissions: { products: ['create'] } })
  const draft = await queryFirst<{ id: string; payload_json: string }>(db, "SELECT id, payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed'", [organization.id])
  const payload = draft ? parseOnboardingDraftPayload(draft.payload_json) : null
  if (!draft || !payload || !firstMenuSetupApplies(payload)) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'This website already has a menu setup path' })
  }

  const { location_id: locationId, step: requested } = getQuery(event)
  if (typeof locationId !== 'string' || !locationId.trim()) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a location for the menu' })
  }
  const requestedStep = stageId.safeParse(requested)
  if (requested !== undefined && !requestedStep.success) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Unknown menu setup step' })
  }
  const location = await getLocation(db, organization.id, locationId)
  if (location?.id !== locationId || location.status !== 'active') {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Active location not found' })
  }

  const sections = await listCollections(db, { organizationId: organization.id, locationId })
  const section = sections[0]
  const products = section ? await listCollectionProducts(db, { organizationId: organization.id, collectionId: section.id }) : []
  const dish = products[0]
  const today = `/dashboard/${encodeURIComponent(organization.slug)}`
  if (sections.length > 1 || products.length > 1 || dish && (dish.kind !== 'dish' || dish.variants.length !== 1 || !dish.locations.some(row => row.location_id === locationId))) {
    if (event.req.method !== 'GET') throw new HTTPError({ statusCode: 409, statusMessage: 'This menu has changed. Reopen setup to continue.' })
    return { resume_url: `${today}/products/menu?location_id=${encodeURIComponent(locationId)}` }
  }

  const currency = organization.default_currency
  if (!isCurrencyCode(currency)) throw new Error('Menu setup requires the website currency')
  const variant = dish?.variants[0]
  const price = variant ? resolveVariantPrice(variant, { currency, location_id: locationId, billing: { type: 'one_time' } }) : null
  const photo = dish ? (await getMediaPlacements(db, {
    organizationId: organization.id, ownerType: 'product', ownerIds: [dish.id], slot: 'image',
  })).get(dish.id)?.[0] : undefined
  const skips = payload.first_menu_skips?.dish_id === dish?.id ? payload.first_menu_skips : undefined
  const resume = !section ? 'section' : !dish ? 'dish' : !price && !skips?.price ? 'price' : !photo && !skips?.photo ? 'photo' : 'review'
  const step = requestedStep.success && stages.indexOf(requestedStep.data) <= stages.indexOf(resume) ? requestedStep.data : resume
  const index = stages.indexOf(step)
  const setup = firstMenuSectionSetupPath(organization.slug, locationId)
  const stepUrl = (id: typeof stages[number]) => `${setup}&step=${id}`
  const chrome = {
    exit_url: today,
    back_url: index === 0 ? today : stepUrl(stages[index - 1]!),
    back_label: 'Back',
    exit_label: 'Exit',
    next_label: step === 'review' ? 'Done' : 'Next',
    save_exit_label: 'Save & exit',
    progress: Math.min(index + 1, stages.length - 1),
    question_count: stages.length - 1,
  }
  if (step === 'review') {
    if (event.req.method !== 'GET') throw new HTTPError({ statusCode: 409, statusMessage: 'Your dish is already saved. Reopen setup to review it.' })
    if (!dish || !section || !location.slug) throw new Error('Saved menu is missing its section, dish, or location slug')
    const origin = await organizationPublicUrl(env, db, organization.id)
    const secret = previewSecretOf(env)
    if (!origin || !secret) throw new Error('Private menu preview is unavailable')
    const preview = new URL(locationSurfacePath(location.slug, 'menu'), origin)
    preview.searchParams.set(PREVIEW_TOKEN_QUERY, await createPreviewToken(secret, organization.id, Date.now() + PREVIEW_TOKEN_TTL_MS))
    return {
      ...chrome,
      id: step,
      title: 'Your first dish is saved',
      section_name: section.name,
      dish_name: dish.name,
      price_label: price ? formatMinorAmount(price.unit_amount, currency) : null,
      preview_url: preview.toString(),
    }
  }

  const record = step === 'section' ? section : dish
  const identity = { ...chrome, id: step, record_id: record?.id ?? null, version: record?.updated_at ?? null }
  if (event.req.method === 'GET') {
    if (step === 'price') return {
      ...identity, title: 'What does this dish cost?', field_label: `Price (${currency})`, currency,
      currency_symbol: new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0).find(part => part.type === 'currency')!.value,
      amount: price ? minorAmountToMajor(price.unit_amount, currency) : '', skip_label: 'Skip',
    }
    if (step === 'photo') return {
      ...identity, title: 'Add a photo of your dish', field_label: 'Dish photo', skip_label: 'Skip',
      asset_id: photo?.asset_id ?? null, photo_url: mediaStillUrl(photo), dish_name: dish?.name,
    }
    return {
      ...identity,
      title: step === 'section' ? 'What should your first menu section be called?' : 'What’s your first dish called?',
      field_label: step === 'section' ? 'Section name' : 'Dish name',
      example: step === 'section' ? 'For example, Small plates' : 'For example, Tamarind prawns',
      max_length: step === 'section' ? PRODUCT_LIMITS.collectionName : PRODUCT_LIMITS.name,
      name: record?.name ?? '',
    }
  }
  if (event.req.method !== 'POST') throw new HTTPError({ statusCode: 405, statusMessage: 'Method not allowed' })
  const parsed = answer.safeParse(await readBody(event))
  if (!parsed.success) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid menu setup answer' })
  const { value, record_id: recordId, version, exit } = parsed.data
  if (requested !== step || recordId !== identity.record_id || version !== identity.version) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'This menu changed while you were editing. Reopen setup to continue.' })
  }

  const actor = { actorId: userId }
  if (step === 'section' || step === 'dish') {
    const max = step === 'section' ? PRODUCT_LIMITS.collectionName : PRODUCT_LIMITS.name
    if (!value || value.length > max) throw new HTTPError({ statusCode: 400, statusMessage: `Enter a name of 1 to ${max} characters` })
    if (step === 'section') {
      if (!section) await createCollection(db, { organizationId: organization.id, collection: { name: value, location_id: locationId }, actor, firstAtLocation: true })
      else if (value !== section.name) await updateCollection(db, { organizationId: organization.id, collectionId: section.id, patch: { name: value }, actor })
    } else if (!section) {
      throw new Error('First dish setup is missing its section')
    } else if (!dish) {
      await createProduct(db, {
        organizationId: organization.id, env, actor, product: { kind: 'dish', name: value },
        publication: { published: false }, firstMenuSection: { id: section.id, locationId },
      })
    } else if (value !== dish.name) {
      await updateProduct(db, { organizationId: organization.id, env, actor, productId: dish.id, patch: { name: value, updated_at: dish.updated_at } })
    }
  } else {
    if (!dish || !variant) throw new Error('Menu setup needs a saved dish and variant')
    if (step === 'price' && value) {
      let unitAmount: number
      try {
        unitAmount = majorAmountToMinor(value, currency)
      } catch (cause) {
        throw new HTTPError({ statusCode: 400, statusMessage: `Enter a valid ${currency} price`, cause })
      }
      if (price?.unit_amount !== unitAmount) {
        const scopedPrice = price?.location_id === locationId ? price : null
        await updateProduct(db, { organizationId: organization.id, env, actor, productId: dish.id, patch: {
          updated_at: dish.updated_at,
          variants: [{ id: variant.id, prices: [scopedPrice ? { id: scopedPrice.id, unit_amount: unitAmount } : { location_id: locationId, currency, unit_amount: unitAmount }] }],
        } })
      }
    }
    if (step === 'price' && !value && price?.location_id === locationId) {
      await updateProduct(db, { organizationId: organization.id, env, actor, productId: dish.id, patch: {
        updated_at: dish.updated_at, variants: [{ id: variant.id, prices: [{ id: price.id, active: false }] }],
      } })
    }
    if (step === 'photo' && value !== (photo?.asset_id ?? null)) {
      await setSingleMediaPlacement(db, { organizationId: organization.id, env, principal,
        placement: { owner_type: 'product', owner_id: dish.id, slot: 'image' }, assetId: value, imageOnly: true })
    }
    // A saved price or asset answers its question. Record an explicit skip on
    // the existing onboarding draft so resume can distinguish it from an unanswered step.
    if (!value) {
      const result = await execute(db, `UPDATE onboarding_drafts
        SET payload_json = json_set(payload_json, '$.first_menu_skips', json_set(
          CASE WHEN json_extract(payload_json, '$.first_menu_skips.dish_id') = ?
            THEN json_extract(payload_json, '$.first_menu_skips') ELSE json_object('dish_id', ?) END, ?, json('true')))
        WHERE id = ? AND organization_id = ? AND status = 'committed'`,
      [dish.id, dish.id, `$.${step}`, draft.id, organization.id])
      if (result.meta.changes !== 1) throw new Error('Menu setup could not save the skipped answer')
    }
  }
  return { next_url: exit ? today : stepUrl(stages[index + 1]!) }
})
