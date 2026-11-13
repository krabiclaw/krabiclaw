import { HTTPError } from 'nitro'
import type { DbClient } from '~/server/db'
import { execute, queryAll, queryFirst } from '~/server/db'
import type { OfferingSetupAnswer, OfferingSetupResponse } from '~/shared/offering-setup'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { firstMenuSectionSetupPath } from '~/server/utils/dashboard-links'
import { getLocation } from '~/server/utils/location-management'
import { getMediaPlacements, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { firstMenuSetupApplies, parseOnboardingDraftPayload } from '~/server/utils/onboarding-drafts'
import { createCollection, createProduct, listCollectionProducts, listCollections, listLocationProducts, organizationDefaultCurrency, resolveVariantPrice, setCollectionProducts, updateCollection, updateProduct } from '~/server/utils/product-management'
import { requireTrimmedProductString } from '~/server/utils/product-validation'
import { currencySymbol, invalidOfferingAnswer, offeringDestination, offeringField, offeringProductCreation, offeringScreen, offeringSetupChanged, offeringToday, submittedValue, type OfferingSetupContext } from '~/server/utils/offering-setup'

const menuKey = (locationId: string) => `first-menu-setup:${locationId}`
const stages = ['section', 'dish', 'photo', 'description', 'price'] as const
type Step = typeof stages[number]

async function readMenuSetup(db: DbClient, organizationId: string, locationId: string) {
  const [draft, sections, products, creation, currency] = await Promise.all([
    queryFirst<{ id: string; payload_json: string }>(db, "SELECT id, payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed'", [organizationId]),
    listCollections(db, { organizationId }),
    listLocationProducts(db, { organizationId, locationId, kind: 'dish' }),
    offeringProductCreation(db, organizationId, menuKey(locationId)),
    organizationDefaultCurrency(db, organizationId),
  ])
  const payload = draft ? parseOnboardingDraftPayload(draft.payload_json) : null
  if (!draft || !payload || !firstMenuSetupApplies(payload)) return null
  const menuSections = sections.filter(section => section.location_id === locationId || section.location_id === null)
  const draftDishes = products.filter(product => product.variants.length === 1 && !product.publications.some(row => row.published)
    && product.locations.some(row => row.location_id === locationId && row.active && !row.published))
  const dish = creation.productId ? draftDishes.find(product => product.id === creation.productId)
    : draftDishes.find(product => product.id === payload.first_menu_skips?.dish_id)
      ?? (draftDishes.length === 1 && products.length === 1 ? draftDishes[0] : undefined)
  if (products.length && !dish) return null
  const selectedSectionId = !payload.first_menu_location_id || payload.first_menu_location_id === locationId ? payload.first_menu_section_id : undefined
  const section = menuSections.find(candidate => candidate.id === selectedSectionId
    && (!dish || dish.collections.some(row => row.collection_id === candidate.id)))
    ?? (dish ? menuSections.find(candidate => dish.collections.some(row => row.collection_id === candidate.id)) : undefined)
    ?? (menuSections.length === 1 ? menuSections[0] : undefined)
  const variant = dish?.variants[0]
  const price = variant ? resolveVariantPrice(variant, { currency, location_id: locationId, billing: { type: 'one_time' } }) : null
  const photo = dish ? (await getMediaPlacements(db, {
    organizationId, ownerType: 'product', ownerIds: [dish.id], slot: 'image',
  })).get(dish.id)?.[0] : undefined
  const skips = payload.first_menu_skips?.dish_id === dish?.id ? payload.first_menu_skips : undefined
  const resume: Step | undefined = !dish
    ? section ? 'dish' : 'section'
    : !photo && !skips?.photo ? 'photo'
      : !dish.description.trim() && !skips?.description ? 'description'
        : !price && !skips?.price ? 'price' : undefined
  return { draft, menuSections, section, creationKey: creation.key, chosenSectionId: selectedSectionId, dish, variant, currency, price, photo, resume }
}

export async function firstMenuSetupLocation(db: DbClient, organizationId: string, raw: string, begunOnly: boolean) {
  const payload = parseOnboardingDraftPayload(raw)
  if (!firstMenuSetupApplies(payload)) return null
  const candidates = await queryAll<{ id: string; has_draft_dish: number }>(db, `
    SELECT l.id, EXISTS (
      SELECT 1 FROM product_locations pl JOIN products p ON p.organization_id=pl.organization_id AND p.id=pl.product_id
      WHERE pl.organization_id=l.organization_id AND pl.location_id=l.id AND pl.active=1 AND pl.published=0 AND p.kind='dish'
        AND NOT EXISTS (SELECT 1 FROM product_publications pp WHERE pp.organization_id=p.organization_id AND pp.product_id=p.id AND pp.published=1)
    ) AS has_draft_dish
    FROM business_locations l
    WHERE l.organization_id = ? AND l.status = 'active'
    ORDER BY CASE WHEN l.id = ? THEN 0
      WHEN EXISTS (SELECT 1 FROM collections c WHERE c.organization_id = l.organization_id AND c.id = ? AND c.location_id = l.id) THEN 1
      ELSE 2 END, l.created_at, l.id
  `, [organizationId, payload.first_menu_location_id ?? null, payload.first_menu_section_id ?? null])
  for (const [index, candidate] of candidates.entries()) {
    if (index > 0 && !candidate.has_draft_dish) continue
    const setup = await readMenuSetup(db, organizationId, candidate.id)
    const started = Boolean(setup?.dish || setup?.chosenSectionId)
    if (setup?.resume && (started || !begunOnly && index === 0)) return { id: candidate.id, started }
  }
  return null
}

export async function firstMenuSetup(context: OfferingSetupContext, locationId: string | undefined, requested: string | undefined, answer: OfferingSetupAnswer | null): Promise<OfferingSetupResponse> {
  const { db, env, organizationId, orgSlug, actorId, principal } = context
  if (!locationId) throw invalidOfferingAnswer('Choose a location for the menu')
  const location = await getLocation(env.DB, organizationId, locationId)
  if (location?.id !== locationId || location.status !== 'active') {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Active location not found' })
  }
  const today = offeringToday(orgSlug)
  const state = await readMenuSetup(db, organizationId, locationId)
  if (!state) return { to: `${today}/products/menu?location_id=${encodeURIComponent(locationId)}` }
  const { draft, menuSections, section, chosenSectionId, creationKey, dish, variant, currency, price, photo, resume } = state
  if (!resume && dish) return answer?.action === 'exit' ? { to: today } : offeringDestination(orgSlug, dish.id, locationId)
  const canNameSection = menuSections.length === 0
    || (menuSections.length === 1 && section?.location_id === locationId && chosenSectionId === section.id)
  const steps = stages.filter(step => step !== 'section' || menuSections.length > 1 || canNameSection)
  const resumeIndex = steps.indexOf(resume!)
  const requestedIndex = steps.findIndex(step => step === requested)
  const index = requestedIndex >= 0 && requestedIndex <= resumeIndex ? requestedIndex : resumeIndex
  const step = steps[index]!
  const guide = firstMenuSectionSetupPath(orgSlug, locationId)
  const stepPath = (next: Step) => `${guide}&step=${next}`
  const revision = JSON.stringify([section?.id, section?.updated_at, dish?.id, dish?.updated_at, photo?.asset_id, menuSections.map(row => row.id)])
  const actor = { actorId }
  const questions = {
    section: menuSections.length > 1 ? { title: 'Which menu section does this dish belong in?', fields: [
      offeringField('section', 'Menu section', 'choice', section?.id, { choices: menuSections.map(row => ({ value: row.id, label: row.name })) }),
    ] } : { title: 'What should your first menu section be called?', fields: [
      offeringField('section', 'Section name', 'text', section?.name, { placeholder: 'Small plates', max_length: PRODUCT_LIMITS.collectionName }),
    ] },
    dish: { title: 'What’s your first dish called?', fields: [
      offeringField('dish', 'Dish name', 'text', dish?.name, { placeholder: 'Tamarind prawns', max_length: PRODUCT_LIMITS.name }),
    ] },
    photo: { title: 'Add a photo of the dish', fields: [
      offeringField('photo', 'Dish photo', 'photo', photo?.asset_id, { optional: true, display_url: mediaStillUrl(photo) ?? undefined }),
    ] },
    description: { title: 'How would you describe it?', fields: [
      offeringField('description', 'Description', 'textarea', dish?.description, { optional: true, max_length: PRODUCT_LIMITS.description }),
    ] },
    price: { title: 'What does it cost?', fields: [
      offeringField('price', 'Price', 'money', price ? minorAmountToMajor(price.unit_amount, currency) : '', { optional: true, symbol: currencySymbol(currency), min: 0 }),
    ] },
  }
  if (!answer) return offeringScreen({ id: step, ...questions[step], index, total: steps.length, backTo: index > 0 ? stepPath(steps[index - 1]!) : today, exitTo: today, revision })
  if (answer.step !== step || answer.revision !== revision) throw offeringSetupChanged()
  const value = submittedValue(answer, step)
  const exit = answer.action === 'exit'
  if (exit && !value && (!questions[step].fields[0]?.optional || !questions[step].fields[0]?.value)) return { to: today }
  if (step === 'section') {
    let selected = section
    if (menuSections.length > 1) {
      selected = menuSections.find(candidate => candidate.id === value)
      if (!selected) throw invalidOfferingAnswer('Choose a menu section')
      if (dish && section && selected.id !== section.id) {
        const [source, destination] = await Promise.all([section, selected].map(row =>
          listCollectionProducts(db, { organizationId, collectionId: row.id }).then(products => products.map(product => product.id)),
        ))
        if (!source || !destination || !source.includes(dish.id)) throw offeringSetupChanged()
        await setCollectionProducts(db, {
          organizationId, collectionId: section.id, actor, expectedProductIds: source,
          productIds: source.filter(id => id !== dish.id),
          moveTo: { collection_id: selected.id, expected_product_ids: destination },
        })
      }
    } else {
      const name = requireTrimmedProductString(value, 'section name', PRODUCT_LIMITS.collectionName)
      if (!selected) selected = await createCollection(db, { organizationId, collection: { name, location_id: locationId }, actor, firstAtLocation: true })
      else if (selected.location_id !== locationId) throw offeringSetupChanged()
      else if (name !== selected.name) await updateCollection(db, { organizationId, collectionId: selected.id, patch: { name }, actor, expectedUpdatedAt: selected.updated_at })
    }
    const result = await execute(db, "UPDATE onboarding_drafts SET payload_json = json_set(payload_json, '$.first_menu_section_id', ?, '$.first_menu_location_id', ?) WHERE id = ? AND organization_id = ? AND status = 'committed'", [selected.id, locationId, draft.id, organizationId])
    if (result.meta.changes !== 1) throw offeringSetupChanged()
  } else if (step === 'dish') {
    const name = requireTrimmedProductString(value, 'dish name', PRODUCT_LIMITS.name)
    if (!dish) {
      if (!section) throw offeringSetupChanged()
      const existing = await listCollectionProducts(db, { organizationId, collectionId: section.id })
      await createProduct(db, {
        organizationId, env, actor, product: { kind: 'dish', name }, publication: { published: false },
        firstMenuSection: { id: section.id, locationId, expectedProductIds: existing.map(row => row.id) }, idempotencyKey: creationKey,
      })
      const scoped = await execute(db, "UPDATE onboarding_drafts SET payload_json = json_set(payload_json, '$.first_menu_location_id', ?) WHERE id = ? AND organization_id = ? AND status = 'committed'", [locationId, draft.id, organizationId])
      if (scoped.meta.changes !== 1) throw offeringSetupChanged()
    } else if (name !== dish.name) {
      await updateProduct(db, { organizationId, env, actor, productId: dish.id, patch: { name, updated_at: dish.updated_at } })
    }
  } else {
    if (!dish || !variant) throw offeringSetupChanged()
    const target = { organizationId, env, actor, productId: dish.id }
    if (step === 'price') {
      let unitAmount: number | undefined
      if (value) {
        try { unitAmount = majorAmountToMinor(value, currency) }
        catch (cause) { throw new HTTPError({ statusCode: 400, statusMessage: 'Enter a valid price', cause }) }
      }
      const scoped = price?.location_id === locationId ? price : null
      const prices = unitAmount === undefined ? scoped ? [{ id: scoped.id, active: false }] : []
        : scoped?.unit_amount === unitAmount ? [] : [scoped ? { id: scoped.id, unit_amount: unitAmount } : { location_id: locationId, currency, unit_amount: unitAmount }]
      if (prices.length) await updateProduct(db, { ...target, patch: { updated_at: dish.updated_at, variants: [{ id: variant.id, prices }] } })
    }
    if (step === 'photo' && value !== (photo?.asset_id ?? '')) {
      await setSingleMediaPlacement(db, { organizationId, env, principal, placement: { owner_type: 'product', owner_id: dish.id, slot: 'image' }, assetId: value || null, imageOnly: true })
    }
    if (step === 'description' && value !== dish.description) {
      if (value.length > PRODUCT_LIMITS.description) throw invalidOfferingAnswer('The description is too long')
      await updateProduct(db, { ...target, patch: { description: value, updated_at: dish.updated_at } })
    }
    if (!value) {
      const result = await execute(db, `UPDATE onboarding_drafts
        SET payload_json = json_set(payload_json, '$.first_menu_skips', json_set(
          CASE WHEN json_extract(payload_json, '$.first_menu_skips.dish_id') = ?
            THEN json_extract(payload_json, '$.first_menu_skips') ELSE json_object('dish_id', ?) END, ?, json('true')))
        WHERE id = ? AND organization_id = ? AND status = 'committed'`, [dish.id, dish.id, `$.${step}`, draft.id, organizationId])
      if (result.meta.changes !== 1) throw offeringSetupChanged()
    }
  }
  if (exit) return { to: today }
  if (step === 'price' && dish) return offeringDestination(orgSlug, dish.id, locationId)
  return { to: stepPath(steps[index + 1]!), guide: true }
}
