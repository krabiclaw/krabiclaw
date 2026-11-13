import { HTTPError } from 'nitro'
import { execute, queryFirst } from '~/server/db'
import { parseOnboardingDraftPayload, type OnboardingDraftPayload } from '~/server/utils/onboarding-drafts'
import { memberSchedulingList, writeMemberScheduling } from '~/server/domain/member-scheduling'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import type { OfferingSetupAnswer, OfferingSetupField, OfferingSetupResponse } from '~/shared/offering-setup'
import { listDashboardLocations } from '~/server/utils/dashboard-context'
import { catalogPath, firstPracticeAreaPath } from '~/server/utils/dashboard-links'
import { bookingScheduleScopes, hasDraftBookableTime, listAvailabilityRules, replaceWeeklySchedule, setProductBookingConfig } from '~/server/utils/availability'
import { createProduct, getProduct, listOrganizationProducts, organizationDefaultCurrency, resolveVariantPrice, setProductLocation, updateProduct } from '~/server/utils/product-management'
import { requireTrimmedProductString } from '~/server/utils/product-validation'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { isValidTimezone, MINUTE_TIME_PATTERN } from '~/utils/timezone'
import { getLocation } from '~/server/utils/location-management'
import { creationRequestHash } from '~/server/utils/organization-events'
import { offeringAddressFields, offeringHasStreetAddress, saveOfferingAddress } from '~/server/utils/offering-address'
import {
  currencySymbol, invalidOfferingAnswer, offeringDestination, offeringField, offeringScreen, offeringSetupChanged,
  offeringProductCreation, offeringTimezone, offeringToday, submittedValue, type OfferingSetupContext,
} from '~/server/utils/offering-setup'

const productKey = 'first-practice-area-setup'
const steps = ['name', 'description', 'meeting', 'office-address', 'attorney', 'profile', 'hours', 'duration', 'office-times', 'fee'] as const
type StepId = typeof steps[number]
type GuideProgress = NonNullable<OnboardingDraftPayload['first_practice_area_progress']>
const requestPolicy = { confirmation_mode: 'review', online_payment_required: false, default_capacity: 1, party_size_max: 1 } as const
const weekdayChoices = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .map((label, index) => ({ value: String(index), label }))

async function readPracticeArea(context: OfferingSetupContext, productId: string) {
  const { db, env, organizationId, actorId } = context
  const [product, { members }, offices, draft, currency, scopes] = await Promise.all([
    getProduct(db, organizationId, productId),
    memberSchedulingList({ env, organizationId, userId: actorId }),
    listDashboardLocations(db, organizationId),
    queryFirst<{ id: string; payload_json: string }>(db, "SELECT id, payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed' AND vertical = 'service'", [organizationId]),
    organizationDefaultCurrency(db, organizationId),
    bookingScheduleScopes(db, organizationId, [productId]),
  ])
  if (product.kind !== 'service' || !product.page?.path || product.order_url || product.publications.some(row => row.published)) return null
  const booking = product.booking
  const payload = draft ? parseOnboardingDraftPayload(draft.payload_json) : null
  const progress = payload?.first_practice_area_progress?.product_id === productId ? payload.first_practice_area_progress : { product_id: productId }
  const pendingAttorney = payload?.first_practice_area_attorney
  const attorney = members.find(member => member.id === (pendingAttorney?.product_id === productId ? pendingAttorney.member_id : booking?.assigned_member_id))
  const schedule = attorney?.scheduling
  const hasHours = Boolean(schedule?.timezone && schedule.weekly?.length)
  const profileReady = Boolean(schedule?.public_name?.trim() && schedule.public_approved === 1)
  const activeOffices = offices.filter(office => office.status === 'active')
  const offeredOffices = activeOffices.filter(candidate => product.locations.some(location => location.location_id === candidate.id && location.active))
  if (offeredOffices.length > 1) return null
  const office = offeredOffices[0]
  const officeRules = office ? await listAvailabilityRules(db, organizationId, productId, office.id) : []
  const officeTime = officeRules.length === 1 ? officeRules[0] : undefined
  const pendingMeeting = payload?.first_practice_area_meeting
  const format = (pendingMeeting?.product_id === productId ? pendingMeeting.format : undefined)
    ?? (booking?.held_online ? 'online' : office?.id)
  const scope = format === 'online' ? null : office?.id
  const officeReady = scope == null || offeringHasStreetAddress(office?.address ?? null)
  const providerConfigured = booking?.scheduling_mode === 'provider'
    && Boolean(attorney && booking.assigned_member_id === attorney.id) && booking.held_online === (scope === null)
  const variant = product.variants.find(candidate => candidate.active)
  if (!variant) throw new HTTPError({ statusCode: 409, statusMessage: 'The practice area needs an active consultation option' })
  const price = scope === undefined ? null : resolveVariantPrice(variant, { currency, location_id: scope })
  const complete: Record<StepId, boolean> = {
    name: true,
    description: Boolean(product.description.trim()),
    meeting: Boolean(format),
    'office-address': officeReady,
    attorney: Boolean(attorney),
    profile: profileReady,
    hours: hasHours,
    duration: Boolean(booking?.duration_minutes),
    'office-times': !office || format === 'online' || Boolean(scopes.get(productId)?.has(office.id)),
    fee: price?.type === 'one_time' && providerConfigured && booking?.assigned_member_id === attorney?.id
      && booking?.confirmation_mode === 'review' && !booking.online_payment_required
      && booking.default_capacity === 1 && booking.party_size_max === 1 && booking.held_online === (format === 'online'),
  }
  const partialScopes = { 'office-address': scope === null ? undefined : office?.id, hours: attorney?.id, 'office-times': scope === null ? undefined : office?.id }
  for (const step of ['office-address', 'hours', 'office-times'] as const) {
    if (progress.partial?.[step] && progress.partial[step].scope_id === partialScopes[step]) complete[step] = false
  }
  return { product, booking, members, attorney, schedule, activeOffices, office, officeRules, officeTime, scope, format, variant, price, currency, draft, intake: payload?.source.details, progress, complete }
}

export async function firstPracticeAreaSetupIncomplete(context: OfferingSetupContext, productId: string) {
  const state = await readPracticeArea(context, productId)
  return state !== null && steps.some(step => !state.complete[step])
}

export async function firstPracticeAreaSetup(context: OfferingSetupContext, productId: string | undefined, requested: string | undefined, answer: OfferingSetupAnswer | null): Promise<OfferingSetupResponse> {
  const { db, env, organizationId, orgSlug, actorId } = context
  const actor = { actorId }
  const exitTo = context.exitTo ?? offeringToday(orgSlug)
  const start = firstPracticeAreaPath(orgSlug)
  if (!productId) {
    const areas = await listOrganizationProducts(db, { organizationId, kind: 'service', window: { limit: 2, offset: 0 } })
    if (areas.length === 1 && areas[0]!.page?.path && !areas[0]!.order_url) {
      return answer?.action === 'exit' ? { to: exitTo } : { to: `${start}/${encodeURIComponent(areas[0]!.id)}`, guide: true }
    }
    if (areas.length) return { to: answer?.action === 'exit' ? exitTo : catalogPath(orgSlug) }
    if (!answer) return offeringScreen({
      id: 'name', title: 'What’s your first practice area?',
      fields: [offeringField('name', 'Practice area name', 'text', '', { placeholder: 'Family law', max_length: PRODUCT_LIMITS.name })],
      index: 0, total: steps.length - 1, backTo: exitTo, exitTo,
    })
    if (answer.step !== 'name') throw offeringSetupChanged()
    const value = submittedValue(answer, 'name')
    if (!value && answer.action === 'exit') return { to: exitTo }
    const name = requireTrimmedProductString(value, 'practice area name', PRODUCT_LIMITS.name)
    const creation = await offeringProductCreation(db, organizationId, productKey)
    if (creation.productId) return answer.action === 'exit' ? { to: exitTo } : { to: `${start}/${encodeURIComponent(creation.productId)}`, guide: true }
    const product = await createProduct(db, { organizationId, env, actor, product: { kind: 'service', name, active: false }, publication: { published: false }, idempotencyKey: creation.key })
    return answer.action === 'exit' ? { to: exitTo } : { to: `${start}/${encodeURIComponent(product.id)}`, guide: true }
  }

  const guide = `${start}/${encodeURIComponent(productId)}`
  const stepPath = (id: StepId) => `${guide}?step=${id}`
  const state = await readPracticeArea(context, productId)
  if (!state) return answer?.action === 'exit' ? { to: exitTo } : offeringDestination(orgSlug, 'service', productId)
  const { product, booking, attorney, members, schedule, office, activeOffices, officeRules, officeTime, scope, format, variant, currency, price, draft, intake, progress, complete } = state
  const resume = steps.find(step => !complete[step])
  if (!resume) return answer?.action === 'exit' ? { to: exitTo } : offeringDestination(orgSlug, 'service', productId)
  const applicable = steps.filter(step => {
    if (step === 'office-times') return Boolean(office) && format !== 'online'
    if (step === 'office-address') return Boolean(office) && format !== 'online'
      && (!complete[step] || progress.office_address_location_id === office?.id || requested === step)
    if (step === 'profile') return !complete[step] || progress.profile_member_id === attorney?.id || requested === step
    if (step === 'hours') return !complete[step] || progress.hours_member_id === attorney?.id || requested === step
    return true
  })
  const resumeIndex = applicable.indexOf(resume)
  const requestedIndex = applicable.findIndex(step => step === requested)
  const index = requestedIndex >= 0 && requestedIndex <= resumeIndex ? requestedIndex : resumeIndex
  const step = applicable[index]!
  const backTo = step === 'duration' && !applicable.includes('hours')
    ? stepPath('hours') : index > 0 ? stepPath(applicable[index - 1]!) : exitTo
  const weekday = (value: number | undefined) => offeringField('weekday', 'Day of the week', 'select', value?.toString(), { choices: weekdayChoices })
  const workingWindow = schedule?.weekly?.[0]
  const officeWeekday = officeTime?.weekday ?? (schedule?.timezone === office?.timezone && schedule?.weekly?.length === 1 ? workingWindow?.weekday : undefined)
  const officeIntake = office?.slug === 'main' ? intake : undefined
  const questions: Record<StepId, { title: string; detail?: string; fields: OfferingSetupField[] }> = {
    name: { title: 'What’s your first practice area?', fields: [
      offeringField('name', 'Practice area name', 'text', product.name, { placeholder: 'Family law', max_length: PRODUCT_LIMITS.name }),
    ] },
    description: { title: 'What can clients come to you for?', fields: [
      offeringField('description', 'Description', 'textarea', product.description, { max_length: PRODUCT_LIMITS.description }),
    ] },
    meeting: { title: 'Where will consultations take place?', fields: [
      offeringField('meeting', 'Meeting format', 'choice', format, { choices: [
        { value: 'online', label: 'Online' }, ...activeOffices.map(row => ({ value: row.id, label: row.title })),
      ] }),
    ] },
    'office-address': {
      title: 'What’s the office address?',
      fields: offeringAddressFields(office?.address ?? null, {
        country: officeIntake?.country, city: officeIntake?.city, region: officeIntake?.region, postalCode: officeIntake?.postal_code,
      }),
    },
    attorney: { title: 'Which attorney will meet with clients?', fields: [
      offeringField('attorney', 'Attorney', 'choice', attorney?.id, { choices: members.map(row => ({ value: row.id, label: row.name })) }),
    ] },
    profile: { title: 'What name should clients see?', fields: [
      offeringField('profile', 'Public name', 'text', schedule?.public_name ?? attorney?.name, { max_length: 100 }),
    ] },
    hours: { title: 'When is the attorney available?', fields: [
      weekday(workingWindow?.weekday),
      offeringField('start', 'Start time', 'time', workingWindow?.start),
      offeringField('end', 'End time', 'time', workingWindow?.end),
      offeringTimezone(schedule?.timezone ?? office?.timezone ?? intake?.timezone ?? ''),
    ] },
    duration: {
      title: 'How long is a consultation?',
      fields: [offeringField('duration', 'Duration in minutes', 'number', booking?.duration_minutes?.toString(), { min: 1 })],
    },
    'office-times': {
      title: 'When can clients book at this office?',
      detail: office?.title,
      fields: [weekday(officeWeekday), offeringField('start', 'Start time', 'time', officeTime?.start_time)],
    },
    fee: { title: 'What’s the consultation fee?', detail: 'Enter 0 for a free consultation.', fields: [
      offeringField('fee', 'Consultation fee', 'money', price ? minorAmountToMajor(price.unit_amount, currency) : '', { min: 0, symbol: currencySymbol(currency) }),
    ] },
  }
  const partialScope = step === 'hours' ? attorney?.id : step === 'office-address' || step === 'office-times' ? office?.id : undefined
  const partialStep = step === 'office-address' || step === 'hours' || step === 'office-times' ? step : undefined
  const partial = partialStep && progress.partial?.[partialStep]
  const matchingPartial = partial && partial.scope_id === partialScope ? partial : undefined
  const question = questions[step]
  const fields = matchingPartial ? question.fields.map(field => ({
    ...field, value: matchingPartial.values[field.key] ?? field.value,
  })) : question.fields
  const location = (step === 'office-address' || step === 'office-times') && office
    ? await getLocation(env.DB, organizationId, office.id)
    : null
  const locationRevision = typeof location?.updated_at === 'string' ? location.updated_at : undefined
  const revision = await creationRequestHash({
    productId, step, productRevision: product.updated_at, booking, format, scope,
    attorneyId: attorney?.id, schedulingRevision: schedule?.updated_at, locationRevision, progress,
    officeRules: step === 'office-times' ? officeRules : undefined,
  })
  if (!answer) return offeringScreen({ id: step, ...question, fields, index, total: applicable.length, backTo, exitTo, revision })
  if (answer.step !== step || answer.revision !== revision) throw offeringSetupChanged()
  const exit = answer.action === 'exit'
  const value = submittedValue(answer, step)
  const target = { db, env, organizationId, productId, actor }
  const memberActor = { env, organizationId, userId: actorId }
  const update = (patch: Parameters<typeof updateProduct>[1]['patch']) => updateProduct(db, { ...target, patch: { ...patch, updated_at: product.updated_at } })
  const configure = (patch: Parameters<typeof setProductBookingConfig>[1]['patch']) => setProductBookingConfig(db, { ...target, actorId, patch })
  const place = (locationId: string, active: boolean) => setProductLocation(db, { ...target, locationId, active, published: false })

  async function saveDraft(field: 'first_practice_area_meeting' | 'first_practice_area_attorney', data: Record<string, string> | null) {
    if (!draft) throw new HTTPError({ statusCode: 409, statusMessage: 'The firm’s onboarding draft is unavailable' })
    const changed = data
      ? await execute(db, "UPDATE onboarding_drafts SET payload_json = json_set(payload_json, ?, json(?)) WHERE id = ? AND organization_id = ? AND status = 'committed'", [`$.${field}`, JSON.stringify({ product_id: productId, ...data }), draft.id, organizationId])
      : await execute(db, "UPDATE onboarding_drafts SET payload_json = json_remove(payload_json, ?) WHERE id = ? AND organization_id = ? AND status = 'committed'", [`$.${field}`, draft.id, organizationId])
    if (changed.meta.changes !== 1) throw offeringSetupChanged()
  }
  async function saveProgress(patch: Partial<GuideProgress>) {
    if (!draft) throw new HTTPError({ statusCode: 409, statusMessage: 'The firm’s onboarding draft is unavailable' })
    const current = parseOnboardingDraftPayload(draft.payload_json).first_practice_area_progress
    const changed = await execute(db, `UPDATE onboarding_drafts
      SET payload_json = json_set(payload_json, '$.first_practice_area_progress', json(?))
      WHERE id = ? AND organization_id = ? AND status = 'committed'
        AND json_extract(payload_json, '$.first_practice_area_progress') IS ?`,
    [JSON.stringify({ ...progress, ...patch }), draft.id, organizationId, current ? JSON.stringify(current) : null])
    if (changed.meta.changes !== 1) throw offeringSetupChanged()
  }

  if (exit && fields.some(field => !field.optional && !submittedValue(answer, field.key))) {
    if (partialStep && partialScope) {
      const values = Object.fromEntries(fields.map(field => [field.key, submittedValue(answer, field.key)]))
      if (fields.some(field => values[field.key] !== field.value)) {
        await saveProgress({ partial: { ...progress.partial, [partialStep]: { scope_id: partialScope, values } } })
      }
    }
    return { to: exitTo }
  }

  const dayAnswer = () => {
    const selected = submittedValue(answer, 'weekday')
    if (!weekdayChoices.some(choice => choice.value === selected)) throw invalidOfferingAnswer('Choose a day of the week')
    return Number(selected)
  }
  const timeAnswer = (key: 'start' | 'end') => {
    const time = submittedValue(answer, key)
    if (!MINUTE_TIME_PATTERN.test(time)) throw invalidOfferingAnswer('Choose a time')
    return time
  }
  const assign = (memberId: string) => configure({ scheduling_mode: 'provider', assigned_member_id: memberId, held_online: format === 'online', ...requestPolicy })

  const saved = (patch: Partial<GuideProgress> = {}) => saveProgress({
    ...patch,
    ...(matchingPartial && partialStep ? { partial: { ...progress.partial, [partialStep]: undefined } } : {}),
  })

  switch (step) {
    case 'name':
    case 'description': {
      const name = requireTrimmedProductString(value, step, PRODUCT_LIMITS[step])
      if (name !== product[step]) await update({ [step]: name })
      break
    }
    case 'meeting':
      if (value !== 'online' && !activeOffices.some(row => row.id === value)) throw invalidOfferingAnswer('Choose online consultations or an office')
      if (value !== format && product.locations.some(row => row.published)) {
        throw new HTTPError({ statusCode: 409, statusMessage: 'Change published offices in the practice area editor' })
      }
      if (value !== format) {
        if (value !== 'online') await place(value, true)
        for (const previous of product.locations.filter(row => row.active && row.location_id !== value)) await place(previous.location_id, false)
        if (booking) await configure({ held_online: value === 'online' })
        await saveDraft('first_practice_area_meeting', !booking && value === 'online' ? { format: value } : null)
      }
      break
    case 'office-address':
      if (!office) throw offeringSetupChanged()
      await saveOfferingAddress(context, office.id, { ...answer, revision: locationRevision })
      await saved({ office_address_location_id: office.id })
      break
    case 'attorney': {
      const selected = members.find(member => member.id === value)
      if (!selected) throw invalidOfferingAnswer('Choose an attorney')
      if (selected.scheduling?.timezone && selected.scheduling.weekly?.length) {
        await assign(selected.id)
        await saveDraft('first_practice_area_attorney', null)
        await saveDraft('first_practice_area_meeting', null)
      } else {
        await saveDraft('first_practice_area_attorney', { member_id: selected.id })
      }
      break
    }
    case 'profile': {
      if (!attorney) throw offeringSetupChanged()
      const name = requireTrimmedProductString(value, 'public name', 100)
      if (!complete.profile || name !== schedule?.public_name) {
        await writeMemberScheduling(memberActor, attorney.id, { public_name: name, public_approved: true, updated_at: schedule?.updated_at ?? null })
      }
      if (progress.profile_member_id !== attorney.id) await saved({ profile_member_id: attorney.id })
      break
    }
    case 'hours': {
      if (!attorney) throw offeringSetupChanged()
      const timezone = submittedValue(answer, 'timezone')
      if (!isValidTimezone(timezone)) throw invalidOfferingAnswer('Choose a time zone')
      const window = { weekday: dayAnswer(), start: timeAnswer('start'), end: timeAnswer('end') }
      const weekly = schedule?.weekly?.length ? [window, ...schedule.weekly.slice(1)] : [window]
      await writeMemberScheduling(memberActor, attorney.id, { timezone, weekly, time_off: schedule?.time_off ?? [], updated_at: schedule?.updated_at ?? null })
      await assign(attorney.id)
      await saveDraft('first_practice_area_attorney', null)
      await saveDraft('first_practice_area_meeting', null)
      await saved({ hours_member_id: attorney.id })
      break
    }
    case 'duration': {
      if (!attorney || !complete.hours) throw offeringSetupChanged()
      const minutes = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(minutes) || minutes < 1) throw invalidOfferingAnswer('Enter the duration in whole minutes')
      const minuteOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
      if (!schedule?.weekly?.some(window => minuteOfDay(window.end) - minuteOfDay(window.start) >= minutes)) {
        throw invalidOfferingAnswer('Choose a duration that fits the attorney’s working hours, or go back to change the hours')
      }
      if (scope === null) {
        if (!booking || booking.assigned_member_id !== attorney.id || !booking.held_online) await assign(attorney.id)
        if (!await hasDraftBookableTime(db, { env, organizationId, productId, locationId: null, durationMinutes: minutes })) {
          throw invalidOfferingAnswer('Choose a duration that fits the attorney’s available hours, or go back to change the hours')
        }
      }
      await configure({ duration_minutes: minutes, scheduling_mode: 'provider', assigned_member_id: attorney.id, held_online: format === 'online', ...requestPolicy })
      await saveDraft('first_practice_area_attorney', null)
      await saveDraft('first_practice_area_meeting', null)
      break
    }
    case 'office-times': {
      if (!office || !booking?.duration_minutes) throw offeringSetupChanged()
      const weekday = dayAnswer()
      const start = timeAnswer('start')
      const slot = { weekday, start_time: start }
      const retained = officeRules.filter(rule => !officeTime || rule.id !== officeTime.id)
        .filter(rule => rule.weekday !== weekday || rule.start_time !== start)
        .map(rule => ({ weekday: rule.weekday, start_time: rule.start_time }))
      await replaceWeeklySchedule(db, {
        ...target, locationId: office.id, actorId, slots: [...retained, slot], requireBookableTime: { env, slot },
      })
      if (matchingPartial) await saved()
      break
    }
    case 'fee': {
      if (scope === undefined || !attorney || !booking?.duration_minutes) throw offeringSetupChanged()
      if (!await hasDraftBookableTime(db, { env, organizationId, productId, locationId: scope })) {
        throw invalidOfferingAnswer(scope === null
          ? 'Go back to adjust the duration or attorney’s hours to make a time available.'
          : 'Go back to choose a time that fits the office and attorney’s availability.')
      }
      let unitAmount: number
      try { unitAmount = majorAmountToMinor(value, currency) }
      catch (cause) { throw new HTTPError({ statusCode: 400, statusMessage: 'Enter a valid consultation fee', cause }) }
      await configure({ scheduling_mode: 'provider', assigned_member_id: attorney.id, held_online: format === 'online', ...requestPolicy })
      const scoped = price?.location_id === scope ? price : null
      if (scoped?.unit_amount !== unitAmount) await update({ variants: [{ id: variant.id, prices: [{
        ...(scoped ? { id: scoped.id } : { currency, location_id: scope }), unit_amount: unitAmount,
      }] }] })
      break
    }
  }
  await purgePublicResourceCacheNow(env, organizationId)
  if (exit) return { to: exitTo }
  if (step === 'fee') return offeringDestination(orgSlug, 'service', productId)
  return { to: index < resumeIndex ? stepPath(applicable[index + 1]!) : guide, guide: true }
}
