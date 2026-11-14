import { HTTPError } from 'nitro'
import type { OfferingSetupAnswer, OfferingSetupResponse } from '~/shared/offering-setup'
import { majorAmountToMinor, minorAmountToMajor, selectPrice } from '~/shared/prices'
import { type DbClient, execute, queryFirst } from '~/server/db'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
import { createSession, setProductBookingConfig } from '~/server/utils/availability'
import { listDashboardLocations } from '~/server/utils/dashboard-context'
import { firstExperienceSetupPath } from '~/server/utils/dashboard-links'
import { createLocation, getLocation, type LocationRecord } from '~/server/utils/location-management'
import { getMediaPlacements, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { parseOnboardingDraftPayload, type OnboardingDraftPayload } from '~/server/utils/onboarding-drafts'
import { creationRequestHash } from '~/server/utils/organization-events'
import { offeringAddressFields, offeringHasStreetAddress, saveOfferingAddress } from '~/server/utils/offering-address'
import {
  createProduct, getProduct, listOrganizationProducts, organizationDefaultCurrency,
  setProductLocation, updateProduct,
} from '~/server/utils/product-management'
import { PRODUCT_LIMITS, requireTrimmedProductString } from '~/server/utils/product-validation'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import {
  currencySymbol, invalidOfferingAnswer, offeringDestination, offeringField, offeringProductCreation, offeringScreen, offeringSetupChanged,
  offeringTimezone, offeringToday, submittedValue, type OfferingSetupContext,
} from '~/server/utils/offering-setup'
import { formatPostalAddress } from '~/utils/postal-address'
import { isValidCalendarDate, isValidTimezone, localDateAt, localDateTimeToInstant, MINUTE_TIME_PATTERN } from '~/utils/timezone'

const stages = ['title', 'location', 'venue', 'venue-address', 'venue-street', 'venue-directions', 'host', 'duration', 'capacity', 'photo', 'description', 'price', 'session'] as const
type Step = typeof stages[number]
type ExperienceProgressField = 'first_experience_venue_address' | 'first_experience_partial'
const productKey = 'first-experience-setup'
const sessionKey = (productId: string) => `first-experience-setup:${productId}`
const addVenue = 'new'
const editVenuePrefix = 'edit:'

async function experienceCompletion(db: DbClient, organizationId: string, productId: string) {
  const [published, session] = await Promise.all([
    queryFirst(db, 'SELECT 1 FROM product_publications WHERE organization_id = ? AND product_id = ? AND published = 1', [organizationId, productId]),
    queryFirst(db, 'SELECT 1 FROM product_sessions WHERE organization_id = ? AND product_id = ? LIMIT 1', [organizationId, productId]),
  ])
  return Boolean(published || session)
}

export async function firstExperienceSetupProgress(db: DbClient, organizationId: string) {
  const creation = await offeringProductCreation(db, organizationId, productKey)
  return creation.productId ? { complete: await experienceCompletion(db, organizationId, creation.productId) } : null
}

async function loadSetup(context: OfferingSetupContext) {
  const { db, organizationId, env, actorId } = context
  const creation = await offeringProductCreation(db, organizationId, productKey)
  const existing = creation.productId ? [] : await listOrganizationProducts(db, { organizationId, kind: 'experience', window: { limit: 1, offset: 0 } })
  const product = creation.productId ? await getProduct(db, organizationId, creation.productId) : null
  const [currency, workspaceLocations, { members }, draft, placements, complete] = await Promise.all([
    organizationDefaultCurrency(db, organizationId),
    listDashboardLocations(db, organizationId),
    memberSchedulingList({ env, organizationId, userId: actorId }),
    queryFirst<{ id: string; payload_json: string }>(db, "SELECT id, payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed' AND vertical = 'experience'", [organizationId]),
    product ? getMediaPlacements(db, { organizationId, ownerType: 'product', ownerIds: [product.id], slot: 'image' }) : null,
    product ? experienceCompletion(db, organizationId, product.id) : false,
  ])
  const payload = draft ? parseOnboardingDraftPayload(draft.payload_json) : null
  const photo = product ? placements?.get(product.id)?.[0] : undefined
  const locations = workspaceLocations.filter(location => isValidTimezone(location.timezone))
  const variant = product?.variants[0]
  const price = variant ? selectPrice(variant.prices, { currency, location_id: null }) : null
  const placedAt = product?.locations.filter(placement => placement.active && locations.some(location => location.id === placement.location_id)) ?? []
  const location = placedAt.length === 1 ? locations.find(entry => entry.id === placedAt[0]!.location_id) : undefined
  const booking = product?.booking
  const assignedHost = members.find(member => member.id === booking?.assigned_member_id)
  const host = assignedHost ?? (members.length === 1 ? members[0] : undefined)
  const meetingPoint = typeof product?.details.meeting_point === 'string' ? product.details.meeting_point : ''
  const hasStreet = offeringHasStreetAddress(location?.address ?? null)
  const storedAddress = payload?.first_experience_venue_address
  const venueAddress = storedAddress?.product_id === product?.id && storedAddress?.location_id === location?.id ? storedAddress : undefined
  const savedAddress = venueAddress?.partial && location
    ? await getLocation(env.DB, organizationId, location.id) : null
  const partialAddress = savedAddress && savedAddress.updated_at === venueAddress?.partial?.location_revision ? venueAddress?.partial : undefined
  const pendingMeetingStep = venueAddress?.pending_method === 'street' ? 'venue-street'
    : venueAddress?.pending_method === 'directions' ? 'venue-directions' : undefined
  const completedStreet = hasStreet && venueAddress && !venueAddress.partial
  const meetingStep = pendingMeetingStep ?? (partialAddress || completedStreet ? 'venue-street' : meetingPoint ? 'venue-directions' : undefined)
  const storedPartial = payload?.first_experience_partial
  const partial = storedPartial?.product_id === product?.id ? storedPartial : undefined
  const partialVenue = partial?.venue?.previous_location_id === (location?.id ?? null) ? partial.venue : undefined
  const partialSession = partial?.session?.location_id === location?.id ? partial?.session : undefined
  const needsHost = !host || Boolean(booking && !assignedHost)
  const resume: Step = !product ? 'title'
    : partialVenue ? 'venue'
      : !location ? locations.length ? 'location' : 'venue'
        : pendingMeetingStep ?? (partialAddress ? 'venue-street'
          : !hasStreet && !meetingPoint ? 'venue-address'
            : needsHost ? 'host'
              : !booking?.duration_minutes ? 'duration'
                : !booking.default_capacity ? 'capacity'
                  : !photo && payload?.first_experience_photo_skipped !== product.id ? 'photo'
                    : !product.description.trim() ? 'description'
                      : price?.type !== 'one_time' ? 'price' : 'session')
  return { product, existing, complete, creationKey: creation.key, currency, price, variant, locations, location, members, host, booking, resume, draft, payload, photo, meetingPoint, hasStreet, needsHost, storedAddress, savedAddress, partialAddress, meetingStep, partial, partialVenue, partialSession }
}

function positiveInteger(value: string, label: string) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw invalidOfferingAnswer(`Enter a positive whole number for ${label}.`)
  return number
}

export async function firstExperienceSetup(context: OfferingSetupContext, requested: string | undefined, answer: OfferingSetupAnswer | null): Promise<OfferingSetupResponse> {
  const { db, env, organizationId, orgSlug, actorId, principal } = context
  const state = await loadSetup(context)
  const { product, resume, booking, location, host, locations, members, photo, currency, price, variant, meetingPoint, hasStreet, needsHost, storedAddress, savedAddress, partialAddress, meetingStep, partial, partialVenue, partialSession } = state
  const exitTo = context.exitTo ?? offeringToday(orgSlug)
  if (product && state.complete) return answer?.action === 'exit' ? { to: exitTo } : offeringDestination(orgSlug, 'experience', product.id)
  if (state.existing[0]) return answer?.action === 'exit' ? { to: exitTo } : offeringDestination(orgSlug, 'experience', state.existing[0].id)

  const venueStep = requested === 'venue-street' || requested === 'venue-directions' ? requested : meetingStep
  const steps = stages.filter(step => {
    if (step === 'location') return locations.length > 0
    if (step === 'venue') return locations.length === 0 || resume === 'venue' || requested === 'venue'
    if (step === 'venue-address') return !hasStreet || Boolean(venueStep) || requested === step
    if (step === 'venue-street' || step === 'venue-directions') return venueStep === step
    if (step === 'host') return members.length !== 1 || needsHost
    return true
  })
  const addressStep = resume === 'venue-street' || resume === 'venue-directions'
  const resumeIndex = steps.indexOf(addressStep && venueStep !== resume ? 'venue-address' : resume)
  const requestedIndex = steps.findIndex(step => step === requested)
  const withinVenueChoice = (requested === 'venue-street' || requested === 'venue-directions') && (resume === 'venue-address' || addressStep)
  const index = requestedIndex >= 0 && (requestedIndex <= resumeIndex || requested === 'venue' && resume === 'location' || withinVenueChoice)
    ? requestedIndex : resumeIndex
  const step = steps[index]!
  const stepPath = (next?: Step) => firstExperienceSetupPath(orgSlug, next)
  const addressLocation = step === 'venue-street' && location ? savedAddress ?? await getLocation(env.DB, organizationId, location.id) : null
  const addressRevision = addressLocation?.updated_at
  const revision = JSON.stringify([
    product?.id, product?.updated_at, location?.id, addressRevision, booking?.assigned_member_id,
    booking?.duration_minutes, booking?.default_capacity, photo?.asset_id,
    ...(step === 'location' ? [locations.map(row => row.id)] : []),
    ...(step === 'host' ? [members.map(row => row.id)] : []),
    ...(step === 'venue-address' || step === 'venue-street' || step === 'venue-directions' ? [storedAddress] : []),
    ...(step === 'location' || step === 'venue' ? [partialVenue] : []),
    ...(step === 'session' ? [partialSession] : []),
  ])
  const scheduleDate = location && isValidTimezone(location.timezone) ? localDateAt(new Date(), location.timezone) : undefined
  const details = state.payload?.source.details
  const questions = {
    title: { title: 'What’s your experience called?', fields: [
      offeringField('title', 'Experience title', 'text', product?.name, { max_length: PRODUCT_LIMITS.name }),
    ] },
    location: { title: 'Where will guests meet?', fields: [
      offeringField('location', 'Venue', 'choice', location?.id ?? (locations.length === 1 ? locations[0]?.id : ''), { choices: [
        ...locations.flatMap(row => {
          const address = offeringHasStreetAddress(row.address) ? formatPostalAddress(row.address) : ''
          return [
            { value: row.id, label: row.title, ...(address ? { detail: address } : {}) },
            ...(address && row.id === (location?.id ?? (locations.length === 1 ? locations[0]?.id : undefined))
              ? [{ value: `${editVenuePrefix}${row.id}`, label: `Edit address for ${row.title}` }]
              : []),
          ]
        }),
        { value: addVenue, label: 'Add a venue' },
      ] }),
    ] },
    venue: { title: 'Where will guests meet?', fields: [
      offeringField('title', 'Venue name', 'text', partialVenue?.title, { max_length: PRODUCT_LIMITS.name }),
      offeringTimezone(partialVenue?.timezone ?? details?.timezone ?? ''),
    ] },
    'venue-address': { title: 'How should guests find the venue?', fields: [
      offeringField('venue-address', 'Meeting details', 'choice', meetingStep === 'venue-directions' ? 'directions' : meetingStep === 'venue-street' || hasStreet ? 'street' : '', { choices: [
        { value: 'street', label: 'Enter a street address' },
        { value: 'directions', label: 'Give meeting directions' },
      ] }),
    ] },
    'venue-street': { title: 'What’s the venue address?', fields: offeringAddressFields(addressLocation?.address ?? null, {
      country: addressLocation?.slug === 'main' ? details?.country : undefined,
    }) },
    'venue-directions': { title: 'Where should guests meet?', fields: [
      offeringField('meeting_point', 'Meeting directions', 'textarea', meetingPoint, { max_length: PRODUCT_LIMITS.description }),
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
      offeringField('date', 'Date', 'date', partialSession?.date, { min_date: scheduleDate }),
      offeringField('time', 'Start time', 'time', partialSession?.time),
    ] },
  }
  const question = questions[step]
  const fields = step === 'venue-street' && partialAddress
    ? question.fields.map(field => ({ ...field, value: partialAddress.values[field.key] ?? field.value }))
    : question.fields
  if (!answer) return offeringScreen({
    id: step, ...question, fields, index, total: steps.length, backTo: index ? stepPath(steps[index - 1]) : exitTo, exitTo, revision,
  })
  if (answer.step !== step || answer.revision !== revision) throw offeringSetupChanged()
  const exit = answer.action === 'exit'
  async function saveProgress<Field extends ExperienceProgressField>(field: Field, value: OnboardingDraftPayload[Field] | null) {
    if (!state.draft) throw offeringSetupChanged()
    const path = `$.${field}`
    const serialized = value ? JSON.stringify(value) : null
    const previous = state.payload?.[field]
    const result = await execute(db, `UPDATE onboarding_drafts
      SET payload_json = CASE WHEN ? IS NULL THEN json_remove(payload_json, ?)
        ELSE json_set(payload_json, ?, json(?)) END
      WHERE id = ? AND organization_id = ? AND status = 'committed'
        AND json_extract(payload_json, ?) IS ?`,
    [serialized, path, path, serialized, state.draft.id, organizationId, path, previous ? JSON.stringify(previous) : null])
    if (result.meta.changes !== 1) throw offeringSetupChanged()
  }
  if (exit && fields.some(field => !field.optional && !submittedValue(answer, field.key))) {
    const values = Object.fromEntries(fields.map(field => [field.key, submittedValue(answer, field.key)]))
    if (product) {
      const changed = fields.some(field => values[field.key] !== field.value)
      if (step === 'venue-street' && location && addressRevision && (changed || !partialAddress)) {
        await saveProgress('first_experience_venue_address', { product_id: product.id, location_id: location.id, partial: { location_revision: addressRevision, values } })
      } else if (step === 'venue-directions' && location && meetingStep !== 'venue-directions') {
        await saveProgress('first_experience_venue_address', { product_id: product.id, location_id: location.id, pending_method: 'directions' })
      } else if (step === 'venue' && (changed || !partialVenue)) {
        await saveProgress('first_experience_partial', { ...partial, product_id: product.id,
          venue: { previous_location_id: location?.id ?? null, title: values.title!, timezone: values.timezone! } })
      } else if (step === 'session' && location && changed) {
        await saveProgress('first_experience_partial', { ...partial, product_id: product.id,
          session: { location_id: location.id, date: values.date!, time: values.time! } })
      }
    }
    return { to: exitTo }
  }

  const actor = { actorId }
  const value = submittedValue(answer, step)
  if (!product) {
    const name = requireTrimmedProductString(value, 'title', PRODUCT_LIMITS.name)
    await createProduct(db, { env, organizationId, actor, product: { kind: 'experience', name }, publication: { published: false }, idempotencyKey: state.creationKey })
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
        if (exit && !value && !photo) return { to: exitTo }
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
      case 'location':
      case 'venue': {
        if (step === 'location' && value === addVenue) {
          if (exit && !partialVenue) await saveProgress('first_experience_partial', { ...partial, product_id: product.id,
            venue: { previous_location_id: location?.id ?? null, title: '', timezone: details?.timezone ?? '' } })
          return exit ? { to: exitTo } : { to: stepPath('venue'), guide: true }
        }
        const editAddress = step === 'location' && value.startsWith(editVenuePrefix)
        let id = locations.find(row => row.id === (editAddress ? value.slice(editVenuePrefix.length) : value))?.id
        if (step === 'venue') {
          const title = requireTrimmedProductString(submittedValue(answer, 'title'), 'venue name', PRODUCT_LIMITS.name)
          const timezone = submittedValue(answer, 'timezone')
          if (!isValidTimezone(timezone)) throw invalidOfferingAnswer('Choose a time zone')
          const key = await creationRequestHash({ title, timezone })
          const result = await createLocation(env, env.DB, organizationId, { title, timezone }, actorId, { idempotencyKey: `first-experience-venue:${product.id}:${key}` })
          if (result.status !== 201 || !('location' in result.data)) {
            const message = 'error' in result.data && typeof result.data.error === 'string' ? result.data.error : 'Could not save the venue'
            throw new HTTPError({ statusCode: result.status, statusMessage: message, data: result.data })
          }
          id = (result.data.location as LocationRecord).id
        }
        if (!id) throw invalidOfferingAnswer('Choose a venue')
        if (location?.id !== id) {
          await setProductLocation(db, {
            ...target, locationId: id, active: true, published: false, actor,
            replaceDraftLocations: { updatedAt: product.updated_at, activeLocationIds: product.locations.filter(row => row.active).map(row => row.location_id) },
          })
        }
        if (editAddress && exit) await saveProgress('first_experience_venue_address', { product_id: product.id, location_id: id, pending_method: 'street' })
        else if (location?.id !== id && storedAddress) await saveProgress('first_experience_venue_address', null)
        if (partial && (partial.venue || location?.id !== id && partial.session)) {
          const session = location?.id === id ? partial.session : undefined
          await saveProgress('first_experience_partial', session ? { product_id: product.id, session } : null)
        }
        await purgePublicResourceCacheNow(env, organizationId)
        return exit ? { to: exitTo } : { to: stepPath(editAddress ? 'venue-street' : undefined), guide: true }
      }
      case 'venue-address': {
        if (value !== 'street' && value !== 'directions') throw invalidOfferingAnswer('Choose how guests should find the venue')
        if (!location) throw offeringSetupChanged()
        if (exit && value !== questions['venue-address'].fields[0]?.value) {
          await saveProgress('first_experience_venue_address', { product_id: product.id, location_id: location.id, pending_method: value })
        }
        return exit ? { to: exitTo } : { to: stepPath(value === 'street' ? 'venue-street' : 'venue-directions'), guide: true }
      }
      case 'venue-street': {
        if (!location || !addressLocation) throw offeringSetupChanged()
        if (!offeringHasStreetAddress(addressLocation.address)
          || questions['venue-street'].fields.some(field => submittedValue(answer, field.key) !== field.value)) {
          await saveOfferingAddress(context, location.id, { ...answer, revision: addressRevision })
        }
        if (meetingStep !== 'venue-street' || partialAddress || storedAddress?.pending_method) {
          await saveProgress('first_experience_venue_address', { product_id: product.id, location_id: location.id })
        }
        return exit ? { to: exitTo } : { to: stepPath(), guide: true }
      }
      case 'venue-directions': {
        if (!location) throw offeringSetupChanged()
        const directions = requireTrimmedProductString(submittedValue(answer, 'meeting_point'), 'meeting directions', PRODUCT_LIMITS.description)
        if (directions !== meetingPoint) await updateProduct(db, { ...target, actor, patch: { details_mode: 'merge', details: { meeting_point: directions }, updated_at: product.updated_at } })
        if (storedAddress) await saveProgress('first_experience_venue_address', null)
        return exit ? { to: exitTo } : { to: stepPath(), guide: true }
      }
      case 'host':
      case 'duration':
      case 'capacity': {
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
        return exit ? { to: exitTo } : offeringDestination(orgSlug, 'experience', product.id)
      }
    }
  }
  if (exit) return { to: exitTo }
  return { to: index < resumeIndex ? stepPath(steps[index + 1]) : stepPath(), guide: true }
}
