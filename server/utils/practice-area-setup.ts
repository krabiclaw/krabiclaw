import { HTTPError } from 'nitro'
import { execute, queryFirst } from '~/server/db'
import { parseOnboardingDraftPayload } from '~/server/utils/onboarding-drafts'
import { memberSchedulingList, writeMemberScheduling } from '~/server/domain/member-scheduling'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import type { OfferingSetupAnswer, OfferingSetupField, OfferingSetupResponse } from '~/shared/offering-setup'
import { listDashboardLocations } from '~/server/utils/dashboard-context'
import { catalogPath, firstPracticeAreaPath } from '~/server/utils/dashboard-links'
import { bookingScheduleScopes, listAvailabilityRules, replaceWeeklySchedule, setProductBookingConfig } from '~/server/utils/availability'
import { createProduct, getProduct, listOrganizationProducts, organizationDefaultCurrency, resolveVariantPrice, setProductLocation, updateProduct } from '~/server/utils/product-management'
import { requireTrimmedProductString } from '~/server/utils/product-validation'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { isValidTimezone, MINUTE_TIME_PATTERN } from '~/utils/timezone'
import {
  currencySymbol, invalidOfferingAnswer, offeringDestination, offeringField, offeringScreen, offeringSetupChanged,
  offeringTimezone, offeringToday, submittedValue, type OfferingSetupContext,
} from '~/server/utils/offering-setup'

const productKey = 'first-practice-area-setup'
const steps = ['name', 'description', 'meeting', 'attorney', 'profile', 'hours', 'duration', 'office-times', 'fee'] as const
type StepId = typeof steps[number]
const requestPolicy = { confirmation_mode: 'review', online_payment_required: false, default_capacity: 1, party_size_max: 1 } as const
const weekdayChoices = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .map((label, index) => ({ value: String(index), label }))

async function readPracticeArea(context: OfferingSetupContext, productId: string) {
  const { db, env, organizationId, actorId } = context
  const [product, { members }, offices, scopes, draft, currency] = await Promise.all([
    getProduct(db, organizationId, productId),
    memberSchedulingList({ env, organizationId, userId: actorId }),
    listDashboardLocations(db, organizationId),
    bookingScheduleScopes(db, organizationId, [productId]),
    queryFirst<{ id: string; payload_json: string }>(db, "SELECT id, payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed' AND vertical = 'service'", [organizationId]),
    organizationDefaultCurrency(db, organizationId),
  ])
  if (product.kind !== 'service' || !product.page?.path || product.order_url || product.publications.some(row => row.published)) return null
  const booking = product.booking
  const payload = draft ? parseOnboardingDraftPayload(draft.payload_json) : null
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
  const variant = product.variants.find(candidate => candidate.active)
  if (!variant) throw new HTTPError({ statusCode: 409, statusMessage: 'The practice area needs an active consultation option' })
  const price = scope === undefined ? null : resolveVariantPrice(variant, { currency, location_id: scope })
  const complete: Record<StepId, boolean> = {
    name: true,
    description: Boolean(product.description.trim()),
    meeting: Boolean(format),
    attorney: Boolean(attorney),
    profile: profileReady,
    hours: hasHours,
    duration: Boolean(booking?.duration_minutes),
    'office-times': !office || format === 'online' || Boolean(scopes.get(productId)?.has(office.id)),
    fee: price?.type === 'one_time' && booking?.assigned_member_id === attorney?.id
      && booking?.confirmation_mode === 'review' && !booking.online_payment_required
      && booking.default_capacity === 1 && booking.party_size_max === 1 && booking.held_online === (format === 'online'),
  }
  return { product, booking, members, attorney, schedule, activeOffices, office, officeRules, officeTime, scope, format, variant, price, currency, draft, complete }
}

export async function firstPracticeAreaSetupIncomplete(context: OfferingSetupContext, productId: string) {
  const state = await readPracticeArea(context, productId)
  return state !== null && steps.some(step => !state.complete[step])
}

export async function firstPracticeAreaSetup(context: OfferingSetupContext, productId: string | undefined, requested: string | undefined, answer: OfferingSetupAnswer | null): Promise<OfferingSetupResponse> {
  const { db, env, organizationId, orgSlug, actorId } = context
  const actor = { actorId }
  const home = offeringToday(orgSlug)
  const start = firstPracticeAreaPath(orgSlug)
  if (!productId) {
    const areas = await listOrganizationProducts(db, { organizationId, kind: 'service', window: { limit: 2, offset: 0 } })
    if (areas.length === 1 && areas[0]!.page?.path && !areas[0]!.order_url) return { to: `${start}/${encodeURIComponent(areas[0]!.id)}`, guide: true }
    if (areas.length) return { to: catalogPath(orgSlug) }
    if (!answer) return offeringScreen({
      id: 'name', title: 'What’s your first practice area?',
      fields: [offeringField('name', 'Practice area name', 'text', '', { placeholder: 'Family law', max_length: PRODUCT_LIMITS.name })],
      index: 0, total: steps.length - 1, backTo: home, exitTo: home,
    })
    if (answer.step !== 'name') throw offeringSetupChanged()
    const value = submittedValue(answer, 'name')
    if (!value && answer.action === 'exit') return { to: home }
    const name = requireTrimmedProductString(value, 'practice area name', PRODUCT_LIMITS.name)
    const product = await createProduct(db, { organizationId, env, actor, product: { kind: 'service', name, active: false }, publication: { published: false }, idempotencyKey: productKey })
    return answer.action === 'exit' ? { to: home } : { to: `${start}/${encodeURIComponent(product.id)}`, guide: true }
  }

  const guide = `${start}/${encodeURIComponent(productId)}`
  const stepPath = (id: StepId) => `${guide}?step=${id}`
  const state = await readPracticeArea(context, productId)
  if (!state) return offeringDestination(orgSlug, productId)
  const { product, booking, attorney, members, schedule, office, activeOffices, officeRules, officeTime, scope, format, variant, currency, price, draft, complete } = state
  const draftTimezone = draft ? parseOnboardingDraftPayload(draft.payload_json).source.details.timezone : null
  const resume = steps.find(step => !complete[step])
  if (!resume) return answer?.action === 'exit' ? { to: home } : offeringDestination(orgSlug, productId)
  const applicable = steps.filter(step => (step !== 'office-times' || format !== 'online' && Boolean(office))
    && (step !== 'profile' && step !== 'hours' || !complete[step] || requested === step))
  const resumeIndex = applicable.indexOf(resume)
  const requestedIndex = applicable.findIndex(step => step === requested)
  const index = requestedIndex >= 0 && requestedIndex <= resumeIndex ? requestedIndex : resumeIndex
  const step = applicable[index]!
  const backTo = index > 0 ? stepPath(applicable[index - 1]!) : home
  const weekday = (value: number | undefined) => offeringField('weekday', 'Day of the week', 'choice', value?.toString(), { choices: weekdayChoices })
  const workingWindow = schedule?.weekly?.[0]
  const officeWeekday = officeTime?.weekday ?? (schedule?.timezone === office?.timezone && schedule?.weekly?.length === 1 ? workingWindow?.weekday : undefined)
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
      offeringTimezone(schedule?.timezone ?? office?.timezone ?? draftTimezone ?? ''),
    ] },
    duration: { title: 'How long is a consultation?', fields: [
      offeringField('duration', 'Duration in minutes', 'number', booking?.duration_minutes?.toString(), { min: 1 }),
    ] },
    'office-times': { title: 'When can clients book at this office?', detail: office?.title, fields: [
      weekday(officeWeekday),
      offeringField('start', 'Start time', 'time', officeTime?.start_time),
    ] },
    fee: { title: 'What’s the consultation fee?', detail: 'Enter 0 for a free consultation.', fields: [
      offeringField('fee', 'Consultation fee', 'money', price ? minorAmountToMajor(price.unit_amount, currency) : '', { min: 0, symbol: currencySymbol(currency) }),
    ] },
  }
  if (!answer) return offeringScreen({ id: step, ...questions[step], index, total: applicable.length, backTo, exitTo: home })
  if (answer.step !== step) throw offeringSetupChanged()
  const exit = answer.action === 'exit'
  if (exit && questions[step].fields.some(field => !submittedValue(answer, field.key))) return { to: home }
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
      if (!complete.profile || name !== schedule?.public_name) await writeMemberScheduling(memberActor, attorney.id, { public_name: name, public_approved: true, updated_at: schedule?.updated_at ?? null })
      break
    }
    case 'hours': {
      if (!attorney) throw offeringSetupChanged()
      const timezone = submittedValue(answer, 'timezone')
      if (!isValidTimezone(timezone)) throw invalidOfferingAnswer('Choose a time zone')
      const weekly = [{ weekday: dayAnswer(), start: timeAnswer('start'), end: timeAnswer('end') }]
      await writeMemberScheduling(memberActor, attorney.id, { timezone, weekly, time_off: schedule?.time_off ?? [], updated_at: schedule?.updated_at ?? null })
      await assign(attorney.id)
      await saveDraft('first_practice_area_attorney', null)
      await saveDraft('first_practice_area_meeting', null)
      break
    }
    case 'duration': {
      if (!attorney || !complete.hours) throw offeringSetupChanged()
      const minutes = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(minutes) || minutes < 1) throw invalidOfferingAnswer('Enter the duration in whole minutes')
      await configure({ duration_minutes: minutes, scheduling_mode: 'provider', assigned_member_id: attorney.id, held_online: format === 'online', ...requestPolicy })
      await saveDraft('first_practice_area_attorney', null)
      await saveDraft('first_practice_area_meeting', null)
      break
    }
    case 'office-times': {
      if (!office || !booking?.duration_minutes) throw offeringSetupChanged()
      const weekday = dayAnswer()
      const start = timeAnswer('start')
      const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
      if (schedule?.timezone === office.timezone && !schedule?.weekly?.some(window =>
        window.weekday === weekday && window.start <= start && minutes(start) + booking.duration_minutes! <= minutes(window.end),
      )) throw invalidOfferingAnswer('Choose a time within the attorney’s working hours')
      if (!officeRules.some(rule => rule.weekday === weekday && rule.start_time === start)) {
        const retained = officeTime ? [] : officeRules.map(rule => ({ weekday: rule.weekday, start_time: rule.start_time }))
        await replaceWeeklySchedule(db, { ...target, locationId: office.id, actorId, slots: [...retained, { weekday, start_time: start }] })
      }
      break
    }
    case 'fee': {
      if (scope === undefined || !attorney || !booking?.duration_minutes) throw offeringSetupChanged()
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
  if (exit) return { to: home }
  if (step === 'fee') return offeringDestination(orgSlug, productId)
  return { to: index < resumeIndex ? stepPath(applicable[index + 1]!) : guide, guide: true }
}
