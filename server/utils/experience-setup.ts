import { HTTPError } from 'nitro'
import type { OfferingSetupAnswer, OfferingSetupResponse } from '~/shared/offering-setup'
import { majorAmountToMinor, minorAmountToMajor, selectPrice } from '~/shared/prices'
import { type DbClient, execute, queryFirst } from '~/server/db'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
import { createSession, setProductBookingConfig } from '~/server/utils/availability'
import { listDashboardLocations } from '~/server/utils/dashboard-context'
import { firstExperienceSetupPath } from '~/server/utils/dashboard-links'
import { createLocation, type LocationRecord } from '~/server/utils/location-management'
import { getMediaPlacements, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { parseOnboardingDraftPayload } from '~/server/utils/onboarding-drafts'
import { creationDedupeKey, readCreationRecord } from '~/server/utils/organization-events'
import {
  createProduct, getProduct, listOrganizationProducts, organizationDefaultCurrency, removeProductLocation,
  setProductLocation, updateProduct,
} from '~/server/utils/product-management'
import { PRODUCT_LIMITS, requireTrimmedProductString } from '~/server/utils/product-validation'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import {
  currencySymbol, invalidOfferingAnswer, offeringDestination, offeringField, offeringScreen, offeringSetupChanged,
  offeringTimezone, offeringToday, submittedValue, type OfferingSetupContext,
} from '~/server/utils/offering-setup'
import { isValidCalendarDate, isValidTimezone, localDateAt, localDateTimeToInstant, MINUTE_TIME_PATTERN } from '~/utils/timezone'

const stages = ['title', 'location', 'host', 'duration', 'capacity', 'photo', 'description', 'price', 'session'] as const
type Step = typeof stages[number]
const productKey = 'first-experience-setup'
const sessionKey = (productId: string) => `first-experience-setup:${productId}`

export async function firstExperienceSetupProgress(db: DbClient, organizationId: string) {
  const created = await readCreationRecord(db, creationDedupeKey('product', organizationId, productKey))
  if (!created) return null
  const product = await queryFirst<{ id: string; kind: string }>(db, 'SELECT id, kind FROM products WHERE organization_id = ? AND id = ?', [organizationId, created.entityId])
  if (!product || product.kind !== 'experience') return null
  const session = await readCreationRecord(db, `session:${organizationId}:${sessionKey(product.id)}`)
  return { productId: product.id, sessionId: session?.entityId ?? null }
}

async function loadSetup(context: OfferingSetupContext) {
  const { db, organizationId, env, actorId } = context
  const progress = await firstExperienceSetupProgress(db, organizationId)
  const existing = progress ? [] : await listOrganizationProducts(db, { organizationId, kind: 'experience', window: { limit: 1, offset: 0 } })
  const product = progress ? await getProduct(db, organizationId, progress.productId) : null
  const [currency, workspaceLocations, { members }, draft, placements] = await Promise.all([
    organizationDefaultCurrency(db, organizationId),
    listDashboardLocations(db, organizationId),
    memberSchedulingList({ env, organizationId, userId: actorId }),
    queryFirst<{ id: string; payload_json: string }>(db, "SELECT id, payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed' AND vertical = 'experience'", [organizationId]),
    product ? getMediaPlacements(db, { organizationId, ownerType: 'product', ownerIds: [product.id], slot: 'image' }) : null,
  ])
  const payload = draft ? parseOnboardingDraftPayload(draft.payload_json) : null
  const photo = product ? placements?.get(product.id)?.[0] : undefined
  const locations = workspaceLocations.filter(location => isValidTimezone(location.timezone))
  const variant = product?.variants[0]
  const price = variant ? selectPrice(variant.prices, { currency, location_id: null }) : null
  const placedAt = product?.locations.filter(placement => placement.active && locations.some(location => location.id === placement.location_id)) ?? []
  const savedLocation = placedAt.length === 1 ? locations.find(entry => entry.id === placedAt[0]!.location_id) : undefined
  const location = savedLocation ?? (locations.length === 1 ? locations[0] : undefined)
  const booking = product?.booking
  const host = members.find(member => member.id === booking?.assigned_member_id) ?? (members.length === 1 ? members[0] : undefined)
  const steps = stages.filter(step => (step !== 'location' || locations.length !== 1) && (step !== 'host' || members.length !== 1))
  const resume: Step = !product ? 'title'
    : !location ? 'location'
      : !host ? 'host'
        : !booking?.duration_minutes ? 'duration'
          : !booking.default_capacity ? 'capacity'
            : !photo && payload?.first_experience_photo_skipped !== product.id ? 'photo'
              : !product.description.trim() ? 'description'
                : price?.type !== 'one_time' ? 'price' : 'session'
  return { product, existing, sessionId: progress?.sessionId, currency, price, variant, locations, location, savedLocation, members, host, booking, steps, resume, draft, payload, photo }
}

function positiveInteger(value: string, label: string) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw invalidOfferingAnswer(`Enter a positive whole number for ${label}.`)
  return number
}

export async function firstExperienceSetup(context: OfferingSetupContext, requested: string | undefined, answer: OfferingSetupAnswer | null): Promise<OfferingSetupResponse> {
  const { db, env, organizationId, orgSlug, actorId, principal } = context
  const state = await loadSetup(context)
  const { product, steps, resume, booking, location, host, locations, members, photo, currency, price, variant } = state
  const today = offeringToday(orgSlug)
  if (product && (state.sessionId || product.publications.some(row => row.published))) return answer?.action === 'exit' ? { to: today } : offeringDestination(orgSlug, product.id)
  if (state.existing[0]) return offeringDestination(orgSlug, state.existing[0].id)

  const resumeIndex = steps.indexOf(resume)
  const requestedIndex = steps.findIndex(step => step === requested)
  const index = requestedIndex >= 0 && requestedIndex <= resumeIndex ? requestedIndex : resumeIndex
  const step = steps[index]!
  const stepPath = (next?: Step) => firstExperienceSetupPath(orgSlug, next)
  const scheduleDate = location && isValidTimezone(location.timezone) ? localDateAt(new Date(), location.timezone) : undefined
  const questions = {
    title: { title: 'What’s your experience called?', fields: [
      offeringField('title', 'Experience title', 'text', product?.name, { max_length: PRODUCT_LIMITS.name }),
    ] },
    location: locations.length ? { title: 'Where will guests meet?', fields: [
      offeringField('location', 'Venue', 'choice', location?.id, { choices: locations.map(row => ({ value: row.id, label: row.title })) }),
    ] } : { title: 'Where will guests meet?', fields: [
      offeringField('title', 'Venue name', 'text', '', { max_length: PRODUCT_LIMITS.name }),
      offeringTimezone(state.payload?.source.details.timezone ?? ''),
    ] },
    host: { title: 'Who will host it?', fields: [
      offeringField('host', 'Host', 'choice', host?.id, { choices: members.map(row => ({ value: row.id, label: row.name })) }),
    ] },
    duration: { title: 'How long does it last?', fields: [
      offeringField('duration', 'Duration in minutes', 'number', booking?.duration_minutes?.toString(), { min: 1 }),
    ] },
    capacity: { title: 'How many guests can join?', fields: [
      offeringField('capacity', 'Places per session', 'number', booking?.default_capacity?.toString(), { min: 1 }),
    ] },
    photo: { title: 'Add a photo of the experience', fields: [
      offeringField('photo', 'Experience photo', 'photo', photo?.asset_id, { optional: true, display_url: mediaStillUrl(photo) ?? undefined }),
    ] },
    description: { title: 'What will guests do?', fields: [
      offeringField('description', 'Description', 'textarea', product?.description, { max_length: PRODUCT_LIMITS.description }),
    ] },
    price: { title: 'What does it cost per guest?', detail: 'Enter 0 if it’s free.', fields: [
      offeringField('price', 'Price per guest', 'money', price ? minorAmountToMajor(price.unit_amount, currency) : '', { symbol: currencySymbol(currency), min: 0 }),
    ] },
    session: { title: 'When is the first session?', detail: location && host ? `${location.title} · ${host.name} · ${location.timezone}` : undefined, fields: [
      offeringField('date', 'Date', 'date', '', { min_date: scheduleDate }),
      offeringField('time', 'Start time', 'time'),
    ] },
  }
  if (!answer) return offeringScreen({ id: step, ...questions[step], index, total: steps.length, backTo: index ? stepPath(steps[index - 1]) : today, exitTo: today })
  if (answer.step !== step) throw offeringSetupChanged()
  const exit = answer.action === 'exit'
  if (exit && questions[step].fields.some(field => !field.optional && !submittedValue(answer, field.key))) return { to: today }

  const actor = { actorId }
  const value = submittedValue(answer, step)
  if (!product) {
    const name = requireTrimmedProductString(value, 'title', PRODUCT_LIMITS.name)
    await createProduct(db, { env, organizationId, actor, product: { kind: 'experience', name }, publication: { published: false }, idempotencyKey: productKey })
  } else {
    const target = { env, organizationId, productId: product.id }
    switch (step) {
      case 'title':
      case 'description': {
        const field = step === 'title' ? 'name' : 'description'
        const saved = requireTrimmedProductString(value, field, PRODUCT_LIMITS[field])
        if (product[field] !== saved) await updateProduct(db, { ...target, actor, patch: { [field]: saved, updated_at: product.updated_at } })
        break
      }
      case 'price': {
        let amount: number
        try { amount = majorAmountToMinor(value, currency) }
        catch (cause) { throw new HTTPError({ statusCode: 400, statusMessage: 'Enter a valid price', cause }) }
        if (!variant) throw new Error('The saved experience has no ticket variant')
        if (price?.unit_amount !== amount) await updateProduct(db, { ...target, actor, patch: { updated_at: product.updated_at, variants: [{
          id: variant.id, prices: [{ ...(price ? { id: price.id } : {}), unit_amount: amount, currency, location_id: null }],
        }] } })
        break
      }
      case 'photo': {
        if (exit && !value && !photo) return { to: today }
        if (value !== (photo?.asset_id ?? '')) {
          await setSingleMediaPlacement(db, { organizationId, env, principal, placement: { owner_type: 'product', owner_id: product.id, slot: 'image' }, assetId: value || null, imageOnly: true })
        }
        if (!value && state.payload?.first_experience_photo_skipped !== product.id) {
          if (!state.draft) throw new Error('The experience onboarding draft was not found')
          const saved = await execute(db, "UPDATE onboarding_drafts SET payload_json = json_set(payload_json, '$.first_experience_photo_skipped', ?) WHERE id = ? AND organization_id = ? AND status = 'committed'", [product.id, state.draft.id, organizationId])
          if (saved.meta.changes !== 1) throw offeringSetupChanged()
        }
        break
      }
      case 'location': {
        let id = locations.find(row => row.id === value)?.id
        if (!locations.length) {
          const title = requireTrimmedProductString(submittedValue(answer, 'title'), 'venue name', PRODUCT_LIMITS.name)
          const timezone = submittedValue(answer, 'timezone')
          if (!isValidTimezone(timezone)) throw invalidOfferingAnswer('Choose a time zone')
          const result = await createLocation(env, env.DB, organizationId, { title, timezone }, actorId, { idempotencyKey: `first-experience-venue:${product.id}` })
          if (result.status !== 201 || !('location' in result.data)) {
            const message = 'error' in result.data && typeof result.data.error === 'string' ? result.data.error : 'Could not save the venue'
            throw new HTTPError({ statusCode: result.status, statusMessage: message, data: result.data })
          }
          id = (result.data.location as LocationRecord).id
        }
        if (!id) throw invalidOfferingAnswer('Choose a venue')
        const earlier = product.locations.filter(placement => placement.active && placement.location_id !== id)
        if (earlier.some(placement => placement.published)) throw new HTTPError({ statusCode: 409, statusMessage: 'Manage published locations in the Catalog editor' })
        if (state.savedLocation?.id !== id) await setProductLocation(db, { ...target, locationId: id, active: true, published: false, actor })
        for (const placement of earlier) await removeProductLocation(db, { ...target, locationId: placement.location_id })
        await purgePublicResourceCacheNow(env, organizationId)
        break
      }
      case 'host':
      case 'duration':
      case 'capacity': {
        if (step === 'duration' && !state.savedLocation && location) {
          await setProductLocation(db, { ...target, actor, locationId: location.id, active: true, published: false })
        }
        const patch = step === 'host' ? { assigned_member_id: value }
          : step === 'duration' ? { duration_minutes: positiveInteger(value, 'duration'), ...(!booking && host ? { assigned_member_id: host.id } : {}) }
            : { default_capacity: positiveInteger(value, 'places') }
        await setProductBookingConfig(db, { ...target, actorId, patch })
        await purgePublicResourceCacheNow(env, organizationId)
        break
      }
      case 'session': {
        const date = submittedValue(answer, 'date')
        const time = submittedValue(answer, 'time')
        const duration = booking?.duration_minutes
        const capacity = booking?.default_capacity
        if (!location || !isValidTimezone(location.timezone) || !duration || !capacity) throw new Error('The first session is missing its saved venue, duration or capacity')
        if (!isValidCalendarDate(date) || !MINUTE_TIME_PATTERN.test(time)) throw invalidOfferingAnswer('Choose a date and start time.')
        let start: Date
        try { start = localDateTimeToInstant(date, time, location.timezone) }
        catch (cause) { throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a start time that occurs once in the venue’s time zone', cause }) }
        if (start.getTime() <= Date.now()) throw invalidOfferingAnswer('Choose a future start time')
        const end = new Date(start.getTime() + duration * 60_000)
        if (!Number.isFinite(end.getTime())) throw invalidOfferingAnswer('Choose a shorter duration.')
        await createSession(db, { ...target, locationId: location.id, actorId, startsAt: start.toISOString(), endsAt: end.toISOString(), capacity, idempotencyKey: sessionKey(product.id) })
        return exit ? { to: today } : offeringDestination(orgSlug, product.id)
      }
    }
  }
  if (exit) return { to: today }
  return { to: index < resumeIndex ? stepPath(steps[index + 1]) : stepPath(), guide: true }
}
