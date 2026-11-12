import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam, readBody } from 'nitro/h3'
import { z } from 'zod'
import { execute, queryFirst } from '~/server/db'
import { parseOnboardingDraftPayload } from '~/server/utils/onboarding-drafts'
import { memberSchedulingList, writeMemberScheduling } from '~/server/domain/member-scheduling'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { isCurrencyCode } from '~/shared/currencies'
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { getDashboardMemberContext, listDashboardLocations } from '~/server/utils/dashboard-context'
import { assertOrganizationWideAccess, assertRoleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { firstPracticeAreaPath } from '~/server/utils/dashboard-links'
import { bookingScheduleScopes, listAvailabilityRules, replaceWeeklySchedule, setProductBookingConfig } from '~/server/utils/availability'
import { getPublicConsultationSettings, setPublicConsultationMode } from '~/server/utils/professional-services'
import { getProduct, resolveVariantPrice, setProductLocation, setProductPublication, updateProduct } from '~/server/utils/product-management'
import { organizationPublicUrl } from '~/server/utils/domains'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'

type Option = { value: string; label: string }
type Schedule = { weekday?: number; start?: string; end?: string; timezone?: string }
type Step = {
  id: string
  title: string
  detail?: string
  complete: boolean
  value?: string
  options?: Option[]
  max_length?: number
  schedule?: Schedule
  currency?: string
  currency_symbol?: string
}

const scheduleAnswer = z.object({
  weekday: z.number().int().min(0).max(6).optional(),
  start: z.string(),
  end: z.string(),
  timezone: z.string().nullable(),
}).strict()
const submission = z.object({ step: z.string(), value: z.string().optional(), schedule: scheduleAnswer.optional(), exit: z.boolean() }).strict()

const handler = defineHandler(async (event) => {
  const { db, env, organization, userId } = await getDashboardMemberContext(event, {})
  const productId = getRouterParam(event, 'product_id')
  if (!productId || organization.vertical !== 'service' || organization.status !== 'inactive') {
    throw new HTTPError({ statusCode: 404, message: 'Private practice area setup is unavailable' })
  }
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  await assertRoleAllows({ ...organization, permissions: { products: ['update'] } })
  const organizationId = organization.id
  const currency = organization.default_currency
  if (!isCurrencyCode(currency)) throw new HTTPError({ statusCode: 409, message: 'Set the firm currency before adding a consultation' })
  const actor = { actorId: userId }
  const memberActor = { env, userId, organizationId }
  const target = { db, env, organizationId, productId, actor }
  const [product, { members }, offices, settings, scopes, draft] = await Promise.all([
    getProduct(db, organizationId, productId),
    memberSchedulingList(memberActor),
    listDashboardLocations(db, organizationId),
    getPublicConsultationSettings(db, organizationId),
    bookingScheduleScopes(db, organizationId, [productId]),
    queryFirst<{ id: string; payload_json: string }>(db, "SELECT id, payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed' AND vertical = 'service' AND source_type = 'manual'", [organizationId]),
  ])
  if (product.kind !== 'service' || !product.page?.path || product.order_url) throw new HTTPError({ statusCode: 404, message: 'Practice area setup is unavailable' })
  const home = `/dashboard/${encodeURIComponent(organization.slug)}`
  const guide = `${firstPracticeAreaPath(organization.slug)}/${encodeURIComponent(productId)}`
  const stepPath = (id: string) => `${guide}?step=${id}`
  const booking = product.booking
  const attorney = members.find(member => member.id === booking?.assigned_member_id)
  const hasHours = (member: typeof members[number]) => Boolean(member.scheduling?.timezone && member.scheduling.weekly?.length)
  const pendingChoice = draft ? parseOnboardingDraftPayload(draft.payload_json).first_practice_area_attorney : undefined
  const pendingId = pendingChoice?.product_id === productId && !(attorney && pendingChoice.member_id === attorney.id && hasHours(attorney))
    ? pendingChoice.member_id : undefined
  const selectedAttorney = members.find(member => member.id === pendingId)
  const profileReady = Boolean(attorney?.scheduling?.public_name?.trim() && attorney.scheduling.public_approved === 1)
  const activeOffices = offices.filter(office => office.status === 'active')
  const offeredOffices = activeOffices.filter(candidate => product.locations.some(location => location.location_id === candidate.id && location.active))
  if (offeredOffices.length > 1) throw new HTTPError({ statusCode: 409, message: 'Use the practice area editor to manage consultations at multiple offices' })
  const office = offeredOffices[0]
  const officeRules = office ? await listAvailabilityRules(db, organizationId, productId, office.id) : []
  const existingOfficeTime = officeRules.length === 1 ? officeRules[0] : undefined
  const attorneyDay = attorney?.scheduling?.timezone === office?.timezone && attorney?.scheduling?.weekly?.length === 1
    ? attorney.scheduling.weekly[0]?.weekday : undefined
  const format = booking?.held_online ? 'online' : office?.id
  const variant = product.variants.find(candidate => candidate.active)
  if (!variant) throw new HTTPError({ statusCode: 409, message: 'The practice area needs an active consultation option' })
  const scope = format === 'online' ? null : office?.id
  const officePlacement = product.locations.find(location => location.location_id === scope && location.active)
  const price = scope === undefined ? null : resolveVariantPrice(variant, { currency, location_id: scope })
  const published = product.publications.some(publication => publication.organization_id === organizationId && publication.published)
  const steps: Step[] = [
    { id: 'name', title: 'Name your first practice area', detail: 'For example, Family Law.', complete: true, value: product.name, max_length: PRODUCT_LIMITS.name },
    { id: 'description', title: 'Describe this practice area', detail: 'Tell clients what your firm can help with.', complete: Boolean(product.description?.trim()), value: product.description ?? '', max_length: PRODUCT_LIMITS.description },
    { id: 'attorney', title: 'Who will meet with clients?', complete: Boolean(attorney && hasHours(attorney) && !pendingId), value: selectedAttorney?.id ?? attorney?.id,
      options: members.map(member => ({ value: member.id, label: member.name })) },
    { id: 'profile', title: 'What name should clients see?', detail: 'This name appears on the consultation page.', complete: profileReady, value: attorney?.scheduling?.public_name ?? '', max_length: 100 },
    { id: 'meeting', title: 'Where will consultations take place?', complete: Boolean(format), value: format, options: [
      { value: 'online', label: 'Online' }, ...activeOffices.map(candidate => ({ value: candidate.id, label: candidate.title })),
    ] },
    { id: 'duration', title: 'How long is each consultation?', detail: 'Enter the duration in minutes.', complete: Boolean(booking?.duration_minutes), value: booking?.duration_minutes?.toString() },
    ...(format && format !== 'online' && office ? [{
      id: 'office-times', title: 'When can clients visit this office?', detail: `Add a weekly start time at ${office.title}.`,
      complete: Boolean(scopes.get(productId)?.has(office.id)),
      schedule: { weekday: existingOfficeTime?.weekday ?? attorneyDay, start: existingOfficeTime?.start_time, timezone: office.timezone ?? undefined },
    }] : []),
    { id: 'fee', title: 'What is the consultation fee?', detail: 'Enter 0 for a free consultation.', complete: price?.type === 'one_time',
      currency, currency_symbol: new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(part => part.type === 'currency')!.value,
      value: price ? minorAmountToMajor(price.unit_amount, currency) : undefined },
    { id: 'requests', title: 'Review requests before confirming?', detail: 'Clients request a time. Your firm confirms it after review.', complete: booking?.confirmation_mode === 'review' && !booking.online_payment_required && booking.default_capacity === 1 && booking.party_size_max === 1 },
    { id: 'preview', title: 'Preview your consultation', detail: 'Make this practice area available in your private website preview.', complete: published && product.active && settings.mode === 'native' && (scope === null || Boolean(officePlacement?.published)) },
  ]

  const method = event.req.method
  if (method !== 'GET' && method !== 'POST') throw new HTTPError({ statusCode: 405, message: 'Method not allowed' })
  const submitted = method === 'POST' ? submission.safeParse(await readBody(event)) : null
  if (submitted && !submitted.success) throw new HTTPError({ statusCode: 400, message: 'Invalid consultation setup answer' })
  const resume = steps.findIndex(step => !step.complete)
  if (resume < 0) {
    if (submitted?.success) return { next_url: submitted.data.exit ? home : guide }
    const url = await organizationPublicUrl(env, db, organizationId)
    const secret = previewSecretOf(env)
    if (!url || !secret) throw new HTTPError({ statusCode: 409, message: 'Private website preview is unavailable' })
    const preview = new URL(product.page.path, url)
    preview.searchParams.set(PREVIEW_TOKEN_QUERY, await createPreviewToken(secret, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS))
    return { done: { title: 'Your consultation is ready to preview', detail: 'Your website is private.', preview_url: preview.toString(), preview_label: 'Open private preview', today_url: home, today_label: 'Back to Today' } }
  }
  const query = getQuery(event)
  const requested = steps.findIndex(step => step.id === query.step)
  const attorneyIndex = steps.findIndex(step => step.id === 'attorney')
  const pendingAttorney = (query.step === 'hours' || !query.step && resume === attorneyIndex) && attorneyIndex <= resume
    ? selectedAttorney : undefined
  if (query.step === 'hours' && !pendingAttorney) throw new HTTPError({ statusCode: 409, message: 'Reload the guide to continue consultation setup' })
  const index = pendingAttorney ? attorneyIndex : requested >= 0 && requested <= resume ? requested : resume
  const currentHours = pendingAttorney?.scheduling?.weekly?.[0]
  const step: Step = pendingAttorney ? {
    id: 'hours', title: `When does ${pendingAttorney.name} work?`, detail: 'Set a weekly window for consultations.',
    complete: hasHours(pendingAttorney), value: pendingAttorney.id,
    schedule: { ...currentHours, timezone: pendingAttorney.scheduling?.timezone ?? (activeOffices.length === 1 ? activeOffices[0]?.timezone ?? undefined : undefined) },
  } : steps[index]!
  const backUrl = pendingAttorney ? stepPath('attorney') : index > 0 ? stepPath(steps[index - 1]!.id) : home
  const response = { step, today_url: home, back_url: backUrl, back_label: 'Back', next_label: step.id === 'preview' ? 'Prepare preview' : step.id === 'requests' ? 'Require review' : 'Next', exit_label: 'Save & exit' }
  if (!submitted) return response
  if (!submitted.success || submitted.data.step !== step.id) throw new HTTPError({ statusCode: 409, message: 'Setup has changed. Reload before continuing.' })
  const { value, schedule, exit } = submitted.data
  if (pendingAttorney && value !== pendingAttorney.id) throw new HTTPError({ statusCode: 409, message: 'The selected attorney changed. Reload before continuing.' })
  const scheduleEntered = schedule?.weekday !== undefined && Boolean(schedule.start)
  if (exit && pendingAttorney && (!scheduleEntered || !schedule?.end || !schedule.timezone)) return { next_url: home }
  if (exit && (!value?.trim() && !scheduleEntered || ['preview', 'requests'].includes(step.id))) return { next_url: home }
  const name = value?.trim() ?? ''
  const refuse = (message: string): never => { throw new HTTPError({ statusCode: 400, message }) }
  const update = (patch: Parameters<typeof updateProduct>[1]['patch']) => updateProduct(db, { ...target, patch: { ...patch, updated_at: product.updated_at } })
  const configure = (patch: Parameters<typeof setProductBookingConfig>[1]['patch']) => setProductBookingConfig(db, { ...target, actorId: userId, patch })
  const place = (locationId: string, active: boolean, published: boolean) => setProductLocation(db, { ...target, locationId, active, published })

  async function clearPendingAttorney() {
    if (!draft || !pendingChoice || pendingChoice.product_id !== productId) return
    await execute(db, `UPDATE onboarding_drafts SET payload_json = json_remove(payload_json, '$.first_practice_area_attorney')
      WHERE id = ? AND organization_id = ? AND status = 'committed'
        AND json_extract(payload_json, '$.first_practice_area_attorney.product_id') = ?
        AND json_extract(payload_json, '$.first_practice_area_attorney.member_id') = ?`,
    [draft.id, organizationId, productId, pendingChoice.member_id])
  }

  switch (step.id) {
    case 'name':
      if (!name || name.length > PRODUCT_LIMITS.name) refuse('Enter the practice area name')
      if (name !== product.name) await update({ name })
      break
    case 'description':
      if (!name || name.length > PRODUCT_LIMITS.description) refuse('Enter a short description of the practice area')
      if (name !== product.description) await update({ description: name })
      break
    case 'attorney': {
      const selected = members.find(member => member.id === value)
      if (!selected) throw new HTTPError({ statusCode: 400, message: 'Choose an attorney' })
      if (!hasHours(selected)) {
        if (!draft) throw new HTTPError({ statusCode: 409, message: 'The firm’s onboarding draft is unavailable' })
        const result = await execute(db, `UPDATE onboarding_drafts
          SET payload_json = json_set(payload_json, '$.first_practice_area_attorney', json_object('product_id', ?, 'member_id', ?))
          WHERE id = ? AND organization_id = ? AND status = 'committed'`, [productId, selected.id, draft.id, organizationId])
        if (result.meta.changes !== 1) throw new HTTPError({ statusCode: 409, message: 'The firm’s onboarding draft changed. Reload before continuing.' })
        return { next_url: exit ? home : stepPath('hours') }
      }
      if (selected.id !== attorney?.id) await configure({ scheduling_mode: 'provider', assigned_member_id: selected.id })
      await clearPendingAttorney()
      break
    }
    case 'hours': {
      if (!pendingAttorney || !schedule || schedule.weekday === undefined || !schedule.timezone) {
        throw new HTTPError({ statusCode: 400, message: 'Choose a day, start time, end time, and time zone' })
      }
      const saved = pendingAttorney.scheduling
      if (!hasHours(pendingAttorney)) {
        await writeMemberScheduling(memberActor, pendingAttorney.id, {
          timezone: schedule.timezone, weekly: [{ weekday: schedule.weekday, start: schedule.start, end: schedule.end }],
          time_off: saved?.time_off ?? [], updated_at: saved?.updated_at ?? null,
        })
      }
      if (pendingAttorney.id !== attorney?.id) await configure({ scheduling_mode: 'provider', assigned_member_id: pendingAttorney.id })
      await clearPendingAttorney()
      break
    }
    case 'profile':
      if (!attorney || !name || name.length > 100) throw new HTTPError({ statusCode: 400, message: 'Enter the attorney’s public name' })
      if (!profileReady || name !== attorney.scheduling?.public_name) {
        await writeMemberScheduling(memberActor, attorney.id, { public_name: name, public_approved: true, updated_at: attorney.scheduling?.updated_at ?? null })
      }
      break
    case 'meeting':
      if (value !== 'online' && !activeOffices.some(candidate => candidate.id === value)) refuse('Choose online consultations or an active office')
      if (value !== format && product.locations.some(location => location.published)) {
        refuse('Use the practice area editor to change a published office')
      }
      if (value !== format) {
        if (value && value !== 'online') await place(value, true, false)
        await configure({ held_online: value === 'online' })
      }
      for (const previous of product.locations.filter(location => location.active && location.location_id !== value)) {
        await place(previous.location_id, false, false)
      }
      break
    case 'duration': {
      const minutes = Number(value)
      if (!Number.isSafeInteger(minutes) || minutes < 1) refuse('Enter the duration in whole minutes')
      if (minutes !== booking?.duration_minutes) await configure({ duration_minutes: minutes })
      break
    }
    case 'office-times': {
      if (!office || !schedule || schedule.weekday === undefined || !schedule.start) {
        throw new HTTPError({ statusCode: 400, message: 'Choose a day and consultation start time' })
      }
      const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
      if (attorney?.scheduling?.timezone === office.timezone && !attorney?.scheduling?.weekly?.some(window =>
        window.weekday === schedule.weekday && window.start <= schedule.start
        && minutes(schedule.start) + (booking?.duration_minutes ?? 0) <= minutes(window.end),
      )) refuse('Choose a time that fits the attorney’s working hours')
      const retained = existingOfficeTime ? [] : officeRules.map(rule => ({ weekday: rule.weekday, start_time: rule.start_time }))
      const alreadyScheduled = officeRules.some(rule => rule.weekday === schedule.weekday && rule.start_time === schedule.start)
      if (!alreadyScheduled) await replaceWeeklySchedule(db, {
        ...target, locationId: office.id, actorId: userId,
        slots: [...retained, { weekday: schedule.weekday, start_time: schedule.start }],
      })
      break
    }
    case 'fee': {
      if (scope === undefined || !name || !/^\d+(?:\.\d+)?$/.test(name)) throw new HTTPError({ statusCode: 400, message: 'Enter the consultation fee' })
      let amount: number
      try { amount = majorAmountToMinor(name, currency) } catch (error) {
        throw new HTTPError({ statusCode: 400, message: 'Enter a valid consultation fee', cause: error })
      }
      if (amount !== price?.unit_amount) await update({ variants: [{ id: variant.id, prices: [{
        ...(price && price.location_id === scope ? { id: price.id } : { currency, location_id: scope }),
        unit_amount: amount,
      }] }] })
      break
    }
    case 'requests':
      await configure({ confirmation_mode: 'review', online_payment_required: false, default_capacity: 1, party_size_max: 1 })
      break
    case 'preview':
      if (!product.active) await update({ active: true })
      if (scope && !officePlacement?.published) await place(scope, true, true)
      if (!published) await setProductPublication(db, { ...target, published: true })
      if (settings.mode !== 'native') await setPublicConsultationMode(db, organizationId, 'native')
      break
  }

  await purgePublicResourceCacheNow(env, organizationId)
  // Recompute applicability on the next request. Choosing a meeting format can
  // add or remove the office-time step, and completing a prerequisite can
  // make existing persisted answers sufficient for a later step.
  const next = index < resume && step.id !== 'meeting' ? steps[index + 1]?.id : undefined
  return { next_url: exit ? home : next ? stepPath(next) : guide }
})

export type PracticeAreaGuide = Extract<Awaited<ReturnType<typeof handler>>, { step: Step } | { done: object }>
export default handler
