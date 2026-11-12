import { HTTPError } from 'nitro'
import type { z } from 'zod'
import { experienceSetupStep, type experienceSetupScreen } from '~/shared/experience-setup'
import { majorAmountToMinor, minorAmountToMajor, selectPrice } from '~/shared/prices'
import { type DbClient, queryFirst } from '~/server/db'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createSession, getSessionAvailability, setProductBookingConfig } from '~/server/utils/availability'
import { listDashboardLocations } from '~/server/utils/dashboard-context'
import { firstExperienceSetupPath, productEditorPath } from '~/server/utils/dashboard-links'
import { creationDedupeKey, readCreationRecord } from '~/server/utils/organization-events'
import {
  createProduct, getProduct, listOrganizationProducts, organizationDefaultCurrency, removeProductLocation,
  setProductLocation, updateProduct,
} from '~/server/utils/product-management'
import { PRODUCT_LIMITS, requireTrimmedProductString } from '~/server/utils/product-validation'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import {
  formatTimestamp, isValidCalendarDate, isValidTimezone, localDateAt, localDateTimeToInstant, MINUTE_TIME_PATTERN,
} from '~/utils/timezone'

type Step = z.infer<typeof experienceSetupStep>
type Screen = z.infer<typeof experienceSetupScreen>
const questions = {
  title: ['Give your experience a title', 'Use a short, memorable title.', 'Experience title'],
  description: ['What will guests do?', 'Tell guests what to expect.', 'What guests will do'],
  price: ['What does one place cost?', 'Enter 0 if it’s free.', 'Price per guest'],
  location: ['Where will you host it?', 'The session uses this location’s time zone.', 'Location'],
  host: ['Who will host it?', 'This person handles bookings for the experience.', 'Host'],
  duration: ['How long does it last?', '', 'Duration in minutes'],
  capacity: ['How many guests can join?', '', 'Places per session'],
  session: ['When is the first session?', '', 'First session'],
  complete: ['Your first session is scheduled', '', ''],
} satisfies Record<Step, [string, string, string]>

const productKey = 'first-experience-setup'
const sessionKey = (productId: string) => `first-experience-setup:${productId}`
const invalid = (message: string) => new HTTPError({ statusCode: 400, statusMessage: message })

export interface ExperienceSetupContext {
  db: DbClient
  env: CloudflareEnv
  organizationId: string
  orgSlug: string
  actorId: string
}

export async function firstExperienceSetupProgress(db: DbClient, organizationId: string) {
  const created = await readCreationRecord(db, creationDedupeKey('product', organizationId, productKey))
  if (!created) return null
  const product = await queryFirst<{ id: string; kind: string }>(db, 'SELECT id, kind FROM products WHERE organization_id = ? AND id = ?', [organizationId, created.entityId])
  if (!product || product.kind !== 'experience') return null
  const session = await readCreationRecord(db, `session:${organizationId}:${sessionKey(product.id)}`)
  return { productId: product.id, sessionId: session?.entityId ?? null }
}

async function loadSetup(context: ExperienceSetupContext) {
  const { db, organizationId } = context
  const progress = await firstExperienceSetupProgress(db, organizationId)
  const product = progress ? await getProduct(db, organizationId, progress.productId) : null
  if (!product && (await listOrganizationProducts(db, { organizationId, kind: 'experience', window: { limit: 1, offset: 0 } })).length) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Open your saved experience from Catalog' })
  }
  const [currency, workspaceLocations, { members }] = await Promise.all([
    organizationDefaultCurrency(db, organizationId),
    listDashboardLocations(db, organizationId),
    memberSchedulingList({ env: context.env, organizationId, userId: context.actorId }),
  ])
  const locations = workspaceLocations.filter(location => isValidTimezone(location.timezone))
  const variant = product?.variants[0]
  const price = variant ? selectPrice(variant.prices, { currency, location_id: null }) : null
  const placements = product?.locations.filter(placement => placement.active && locations.some(location => location.id === placement.location_id)) ?? []
  const savedLocation = placements.length === 1 ? locations.find(entry => entry.id === placements[0]!.location_id) : undefined
  const location = savedLocation ?? (locations.length === 1 ? locations[0] : undefined)
  const booking = product?.booking
  const hostId = booking?.assigned_member_id ?? (members.length === 1 ? members[0]?.id : undefined)
  const steps = experienceSetupStep.options.filter(step => (step !== 'location' || locations.length !== 1)
    && (step !== 'host' || members.length !== 1))
  const resume: Step = progress?.sessionId ? 'complete'
    : !product ? 'title'
      : !product.description.trim() ? 'description'
        : !location ? 'location'
          : !hostId ? 'host'
            : !booking?.duration_minutes ? 'duration'
              : !booking.default_capacity ? 'capacity'
                : price?.type !== 'one_time' ? 'price'
                  : 'session'
  return { product, sessionId: progress?.sessionId, currency, price, variant, locations, location, savedLocation, members, hostId, booking, steps, resume }
}

export async function readExperienceSetup(context: ExperienceSetupContext, requested?: Step): Promise<Screen> {
  const { db, env, organizationId, orgSlug } = context
  const state = await loadSetup(context)
  const { steps } = state
  const step = !requested || !steps.includes(requested) || state.resume === 'complete' || steps.indexOf(requested) > steps.indexOf(state.resume) ? state.resume : requested
  const index = steps.indexOf(step)
  const todayPath = `/dashboard/${encodeURIComponent(orgSlug)}`
  const [title, detail, label] = questions[step]
  const screen: Screen = {
    step, title, detail, label, value: '', choices: [], position: Math.min(index + 1, steps.length - 1), total: steps.length - 1,
    back_to: index === 0 ? todayPath : firstExperienceSetupPath(orgSlug, steps[index - 1]),
    exit_to: todayPath, next_label: step === 'session' ? 'Add to Calendar' : 'Next', back_label: 'Back', exit_label: 'Save & exit',
  }
  const product = state.product
  switch (step) {
    case 'title':
      return { ...screen, value: product?.name ?? '', max_length: PRODUCT_LIMITS.name }
    case 'description':
      return { ...screen, value: product?.description ?? '', max_length: PRODUCT_LIMITS.description }
    case 'price':
      return { ...screen, value: state.price ? minorAmountToMajor(state.price.unit_amount, state.currency) : '', currency: state.currency }
    case 'location': {
      const choices = state.locations.map(location => ({ value: location.id, label: location.title, detail: location.timezone! }))
      return { ...screen, choices, value: state.location?.id ?? '' }
    }
    case 'host': {
      const choices = state.members.map(member => ({ value: member.id, label: member.name }))
      return { ...screen, choices, value: state.hostId ?? '' }
    }
    case 'duration':
      return { ...screen, value: state.booking?.duration_minutes?.toString() ?? '' }
    case 'capacity':
      return { ...screen, value: state.booking?.default_capacity?.toString() ?? '' }
    case 'session': {
      const timezone = state.location?.timezone
      if (!isValidTimezone(timezone)) throw new Error('The saved session location has no time zone')
      const host = state.members.find(member => member.id === state.hostId)
      if (!host || !state.location) throw new Error('The first session has no saved host or location')
      return { ...screen, detail: `${state.location.title} · ${host.name} · ${timezone}`, today: localDateAt(new Date(), timezone) }
    }
    case 'complete': {
      if (!product || !state.sessionId) throw new Error('The completed experience has no saved session')
      const session = await getSessionAvailability(db, env, organizationId, product.id, state.sessionId)
      if (!session.location_id) throw new Error('The first session has no saved location')
      const date = localDateAt(new Date(session.starts_at), session.timezone)
      const calendarQuery = new URLSearchParams({ product_id: product.id, location_id: session.location_id, month: date.slice(0, 7), date })
      const editor = productEditorPath(orgSlug, product.id, session.location_id)
      const when = formatTimestamp(session.starts_at, 'en', session.timezone, { dateStyle: 'full', timeStyle: 'short' })
      return {
        ...screen,
        title: session.status === 'cancelled' ? 'Your first session was cancelled' : screen.title,
        detail: `${product.name} · ${when} · ${session.timezone}`,
        value: session.capacity === null ? '' : `${session.capacity} places`,
        calendar_to: `${todayPath}/calendar/sessions/${encodeURIComponent(session.id)}?${calendarQuery}`,
        preview_to: `${editor}&editMode=preview`,
      }
    }
  }
}

function positiveInteger(value: string, label: string) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw invalid(`Enter a positive whole number for ${label}.`)
  return number
}

export async function saveExperienceSetup(context: ExperienceSetupContext, input: { action: 'next' | 'exit'; step: Step; value?: string }) {
  const { db, env, organizationId, orgSlug, actorId } = context
  const state = await loadSetup(context)
  const today = `/dashboard/${encodeURIComponent(orgSlug)}`
  if (state.resume === 'complete') return input.action === 'exit' ? today : firstExperienceSetupPath(orgSlug, 'complete')
  const { steps } = state
  const index = steps.indexOf(input.step)
  if (index < 0 || index > steps.indexOf(state.resume)) throw new HTTPError({ statusCode: 409, statusMessage: 'Finish the earlier experience questions first' })
  const value = input.value?.trim()
  if (!value) {
    if (input.action === 'exit') return today
    throw invalid('Answer this question to continue.')
  }

  const actor = { actorId }
  const { product } = state
  if (!product) {
    const name = requireTrimmedProductString(value, 'name', PRODUCT_LIMITS.name)
    await createProduct(db, { env, organizationId, actor, product: { kind: 'experience', name }, publication: { published: false }, idempotencyKey: productKey })
  } else {
    const target = { env, organizationId, productId: product.id }
    switch (input.step) {
      case 'title':
        await updateProduct(db, { ...target, actor, patch: { name: requireTrimmedProductString(value, 'name', PRODUCT_LIMITS.name), updated_at: product.updated_at } })
        break
      case 'description':
        await updateProduct(db, { ...target, actor, patch: { description: requireTrimmedProductString(value, 'description', PRODUCT_LIMITS.description), updated_at: product.updated_at } })
        break
      case 'price': {
        let amount: number
        try { amount = majorAmountToMinor(value, state.currency) }
        catch (error) { throw new HTTPError({ statusCode: 400, statusMessage: 'Enter a valid price in the workspace currency', cause: error }) }
        if (!state.variant) throw new Error('The saved experience has no ticket variant')
        await updateProduct(db, { ...target, actor, patch: { updated_at: product.updated_at, variants: [{
          id: state.variant.id, prices: [{ ...(state.price ? { id: state.price.id } : {}), unit_amount: amount, currency: state.currency, location_id: null }],
        }] } })
        break
      }
      case 'location': {
        const location = state.locations.find(entry => entry.id === value)
        if (!location || !isValidTimezone(location.timezone)) throw invalid('Choose an active location with a time zone.')
        const earlier = product.locations.filter(placement => placement.active && placement.location_id !== value)
        if (earlier.some(placement => placement.published)) throw new HTTPError({ statusCode: 409, statusMessage: 'Manage published locations in the Catalog editor' })
        await setProductLocation(db, { ...target, locationId: value, active: true, published: false, actor })
        for (const placement of earlier) await removeProductLocation(db, { ...target, locationId: placement.location_id })
        await purgePublicResourceCacheNow(env, organizationId)
        break
      }
      case 'host':
      case 'duration':
      case 'capacity': {
        if (input.step === 'duration' && !state.savedLocation && state.location) {
          await setProductLocation(db, { ...target, actor, locationId: state.location.id, active: true, published: false })
        }
        const patch = input.step === 'host' ? { assigned_member_id: value }
          : input.step === 'duration' ? { duration_minutes: positiveInteger(value, 'duration'), ...(!state.booking && state.hostId ? { assigned_member_id: state.hostId } : {}) }
            : { default_capacity: positiveInteger(value, 'places') }
        await setProductBookingConfig(db, { ...target, actorId, patch })
        await purgePublicResourceCacheNow(env, organizationId)
        break
      }
      case 'session': {
        const [date, time] = value.split('T')
        const location = state.location
        const duration = state.booking?.duration_minutes
        const capacity = state.booking?.default_capacity
        if (!location || !isValidTimezone(location.timezone) || !duration || !capacity) throw new Error('The first session is missing its saved location, duration or capacity')
        if (!isValidCalendarDate(date) || !time || !MINUTE_TIME_PATTERN.test(time)) throw invalid('Choose a date and start time.')
        let start: Date
        try { start = localDateTimeToInstant(date, time, location.timezone) }
        catch (error) { throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a start time that occurs once in the location’s time zone', cause: error }) }
        const end = new Date(start.getTime() + duration * 60_000)
        if (!Number.isFinite(end.getTime())) throw invalid('Choose a shorter duration.')
        await createSession(db, { ...target, locationId: location.id, actorId, startsAt: start.toISOString(), endsAt: end.toISOString(), capacity, idempotencyKey: sessionKey(product.id) })
        break
      }
    }
  }
  return input.action === 'exit' ? today : firstExperienceSetupPath(orgSlug, steps[index + 1])
}
