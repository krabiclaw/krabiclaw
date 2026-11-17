import { HTTPError } from 'nitro'
import { executeBatch, type DbClient } from '~/server/db'
import { assertRoleAllows, BATCH_VIEWER, membershipBySlugQuery, withViewer } from '~/server/utils/member-access'
import { bookedRecordsInRange, type BookedRecordInRange, type BookedRecordWithAmounts } from '~/server/domain/product-bookings'
import { openWorkQuery, taskAssignees, taskAssigneesQuery, type OpenWorkRow } from '~/server/domain/tasks'
import { bookingWelcomesQuery, bookingWelcomeViews, setupQueries, setupViews } from '~/server/domain/opportunities'
import { bookingDay } from '~/server/domain/requests'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { ownerPicture } from '~/server/notifications/hero'
import { bookingConversationOrRecordPath, guestConversationPath } from '~/shared/messages-contract'
import { guestGroup, UPCOMING_RESERVATION_DAYS, type BusinessToday, type TodayItem } from '~/shared/dashboard-today'
import { isChannelManagedStay, STAY_CHANNEL_LABELS } from '~/shared/bookings'
import { currencyFractionDigits } from '~/shared/currencies'
import { formatMinorAmount } from '~/shared/prices'
import { addLocalDays, formatCalendarRange, formatTimestamp, localDateAt } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'

/*
  Today and Upcoming for the person looking: the bookings they host in the
  range, the jobs they were put in charge of (or, for an owner or admin, that
  nobody is), a request waiting for their decision, a message that did not
  send and a change waiting on the business. One D1 round trip: the caller's
  membership by the route's slug, then every row, each statement scoped by
  that membership in SQL.
*/

type Range = 'today' | 'upcoming'

/** What a card counts as in the heading, singular and plural. */
const NOUNS = {
  reservation: ['reservation', 'reservations'], consultation: ['consultation', 'consultations'], class: ['class', 'classes'],
  clean: ['home to clean', 'homes to clean'], follow_up: ['follow-up', 'follow-ups'], request: ['request', 'requests'],
  change: ['change request', 'change requests'], message: ['message that didn’t send', 'messages that didn’t send'],
  task: ['task', 'tasks'],
  // Setup is listed but never counted in the heading.
  setup: ['', ''],
} as const

/** The tile a card shows when what it is about has no picture of its own. */
const ICONS: Record<string, string> = { stay: 'i-lucide-house', experience: 'i-lucide-ticket', service: 'i-lucide-scale', table: 'i-lucide-utensils', dish: 'i-lucide-utensils' }
const iconOf = (kind: string | null) => (kind && ICONS[kind]) ?? 'i-lucide-calendar-check'
type Noun = keyof typeof NOUNS

/** A card as it is built: what it counts as, where it sorts, the bookings it stands for and the local day it is on. */
interface Card extends TodayItem { noun: Noun; order: [number, string]; bookings: string[]; day: string }

export async function readToday(db: DbClient, input: { slug: string; userId: string; range: Range; now: Date }): Promise<BusinessToday> {
  const { range, now } = input
  const utcDay = now.toISOString().slice(0, 10)
  const from = utcDay, to = range === 'today' ? utcDay : addLocalDays(utcDay, UPCOMING_RESERVATION_DAYS + 1)
  const wideFrom = `${addLocalDays(from, -1)}T00:00:00.000Z`, wideTo = `${addLocalDays(to, 1)}T23:59:59.999Z`
  const membership = membershipBySlugQuery(input.slug, input.userId)
  const org = BATCH_VIEWER.organization
  const window = `(starts_at <= ? AND ends_at >= ?${range === 'today' ? " OR status = 'pending'" : ''})`
  // What only an owner or admin reads: a member's statements name no organization and read nothing.
  const managed = { sql: `CASE WHEN ${BATCH_VIEWER.organizationWide} = 1 THEN ${org} END` }
  const [viewerResult, recordResult, workResult, productResult, locationResult, welcomeResult, factResult, unpricedResult, assigneeResult] = await executeBatch(db, [
    membership,
    withViewer(membership, bookedRecordsInRange(BATCH_VIEWER, { from, to, pending: range === 'today', amounts: true })),
    withViewer(membership, openWorkQuery(BATCH_VIEWER, to)),
    withViewer(membership, mediaPlacementsQuery({ organizationId: { sql: org }, ownerType: 'product', owners: {
      sql: `SELECT product_id FROM bookings WHERE organization_id = ${org} AND status <> 'cancelled' AND ${window}
        UNION SELECT product_id FROM tasks WHERE organization_id = ${org} AND status = 'open' AND product_id IS NOT NULL`, params: [wideTo, wideFrom] } })),
    withViewer(membership, mediaPlacementsQuery({ organizationId: { sql: org }, ownerType: 'business_location', owners: {
      sql: `SELECT location_id FROM bookings WHERE organization_id = ${org} AND location_id IS NOT NULL AND status <> 'cancelled' AND ${window}`, params: [wideTo, wideFrom] } })),
    withViewer(membership, bookingWelcomesQuery(managed, { now })),
    // The setup the business has not finished is Today's, after the day's cards.
    ...setupQueries(range === 'today' ? managed : { sql: 'NULL' }, { now }).map(query => withViewer(membership, query)),
    withViewer(membership, taskAssigneesQuery(managed)),
  ], { operation: 'Read Today' })
  const viewer = viewerResult!.results[0] as { organization_id: string; slug: string; vertical: string | null; role: string; organization_wide: number } | undefined
  if (!viewer) throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  await assertRoleAllows({ organizationId: viewer.organization_id, role: viewer.role, permissions: { task: ['read'] } })
  const manage = viewer.organization_wide === 1
  const products = groupMediaPlacements(productResult!.results), locations = groupMediaPlacements(locationResult!.results)
  const picture = (ownerType: 'product' | 'business_location', id: string | null) => id === null ? null
    : ownerPicture(ownerType, (ownerType === 'product' ? products : locations).get(id) ?? [], [])?.imageUrl ?? null
  const welcomes = new Map(bookingWelcomeViews(welcomeResult!.results, { now, slug: viewer.slug, vertical: viewer.vertical })
    .map(welcome => [welcome.conversation_id!, welcome] as const))

  const today = (timezone: string) => localDateAt(now, timezone)
  const shows = (day: string, timezone: string) => range === 'today' ? day === today(timezone) : day > today(timezone) && day <= addLocalDays(today(timezone), UPCOMING_RESERVATION_DAYS)
  const time = (instant: string, timezone: string) => formatTimestamp(instant, 'en', timezone, { hour: 'numeric', minute: '2-digit' })
  const dayTime = (instant: string, timezone: string) => `${formatTimestamp(instant, 'en', timezone, { weekday: 'short', month: 'short', day: 'numeric' })} · ${time(instant, timezone)}`
  const nights = (record: Pick<BookedRecordInRange, 'starts_at' | 'ends_at' | 'timezone'>) => formatCalendarRange(bookingDay(record.starts_at, record.timezone), bookingDay(record.ends_at, record.timezone), 'en-US')
  const visitWhen = (instant: string, timezone: string) => range === 'today' ? time(instant, timezone) : dayTime(instant, timezone)
  const recordPath = (bookingId: string, conversationId: string | null, seated: number) => bookingConversationOrRecordPath(viewer.slug, bookingId, seated ? conversationId : null)
  const first = (name: string | null) => name?.trim().split(/\s+/)[0] || null
  // Who booked, in the business's word: a home's guests, a law firm's client or clients.
  const counterparty = (record: BookedRecordInRange) => {
    if (record.unit === 'nights') return 'guests'
    const noun = resolveBookingPresentation(record.product_kind, viewer.vertical).counterpartyNoun
    return record.party_size === 1 ? noun : `${noun}s`
  }

  const cards: Card[] = []
  const byBooking = new Map<string, Card>()
  const byClass = new Map<string, { card: Card; party: number }>()
  const add = (input: Omit<Card, 'done'> & { done?: Card['done'] }) => {
    const card: Card = { done: null, ...input }
    cards.push(card)
    for (const id of card.bookings) byBooking.set(id, card)
    return card
  }

  for (const record of (recordResult!.results as BookedRecordWithAmounts[])) {
    const zone = record.timezone
    const start = bookingDay(record.starts_at, zone), end = bookingDay(record.ends_at, zone)
    const guest = first(record.guest_name)
    const group = guestGroup(record.guest_name, record.party_size)
    const Group = group.charAt(0).toUpperCase() + group.slice(1)
    const image = record.product_kind === 'table' ? picture('business_location', record.location_id) : picture('product', record.product_id)
    // A visit with no location is held online, as its booking reads it.
    const place = record.unit === 'nights' ? record.product_name : [record.product_kind === 'table' ? null : record.product_name, record.location_id === null ? 'Online' : record.location_title].filter(Boolean).join(' · ') || null
    const line = [place, manage ? money(record) : null].filter(Boolean).join(' · ') || null
    const to = recordPath(record.id, record.conversation_id, record.viewer_seated)
    const welcome = record.conversation_id ? welcomes.get(record.conversation_id) : undefined
    const opens = record.conversation_id && record.viewer_seated
    const named = !guest
      ? { title: 'Open the reservation', detail: record.owner === 'channel' ? `No guest name came from ${STAY_CHANNEL_LABELS[record.channel]}` : 'No guest name was recorded' }
      : opens ? { title: `Say hello to your ${counterparty(record)}`, detail: 'See if they have any questions' } : { title: 'Open the reservation', detail: `See what ${guest} booked` }
    const action = welcome && opens ? { title: welcome.title, detail: welcome.detail } : named
    const base = { image_url: image, icon: iconOf(record.product_kind), line, to, draft: welcome && opens ? welcome.message : null, bookings: [record.id], day: start }
    if (record.status === 'pending') {
      // A request waits for a decision whenever it is for; Today shows it until it is answered.
      if (range === 'today') add({ ...base, id: `booking:${record.id}`, noun: 'request', order: [1, record.starts_at], draft: null,
        when: record.unit === 'nights' ? nights(record) : dayTime(record.starts_at, zone), headline: `${Group} wants to book`,
        action: { title: 'Review the request', detail: 'Accept or decline' } })
      continue
    }
    if (record.unit === 'nights') {
      const timed = (value: string) => value.length > 10 ? time(value, zone) : nights(record)
      // A stay unnamed by its channel is "a group of 2 from Airbnb"; one added by hand without a name, "a group of 2 you added".
      const who = guest ? group : `${group} ${record.owner === 'channel' ? `from ${STAY_CHANNEL_LABELS[record.channel]}` : 'you added'}`
      const Who = who.charAt(0).toUpperCase() + who.slice(1)
      if (range === 'upcoming') {
        if (shows(start, zone)) add({ ...base, id: `booking:${record.id}`, noun: 'reservation', order: [0, record.starts_at], when: nights(record), headline: Who, action })
        continue
      }
      if (start === today(zone)) add({ ...base, id: `arrival:${record.id}`, noun: 'reservation', order: [0, record.starts_at], when: timed(record.starts_at), headline: `${Who} checks in`, action })
      if (end === today(zone)) add({ ...base, day: end, id: `departure:${record.id}`, noun: 'reservation', order: [0, record.ends_at], when: timed(record.ends_at), headline: `${Who} checks out`, action: guest && opens ? { title: `Message ${guest}`, detail: 'See if they have any questions' } : named })
      continue
    }
    if (!shows(start, zone)) continue
    if (record.product_kind === 'experience' && record.product_session_id) {
      // A class is one card for everyone booked into it.
      const held = byClass.get(record.product_session_id)
      if (held) {
        held.party += record.party_size
        held.card.bookings.push(record.id); byBooking.set(record.id, held.card)
        continue
      }
      const card = add({ ...base, id: `class:${record.product_session_id}`, noun: 'class', order: [0, record.starts_at], draft: null, when: visitWhen(record.starts_at, zone), headline: '',
        to: `/dashboard/${encodeURIComponent(viewer.slug)}/calendar/sessions/${encodeURIComponent(record.product_session_id)}?${new URLSearchParams({ date: start, product_id: record.product_id })}`,
        action: { title: 'Message the class', detail: 'See who is coming' } })
      byClass.set(record.product_session_id, { card, party: record.party_size })
      continue
    }
    const service = record.product_kind === 'service'
    add({ ...base, id: `booking:${record.id}`, noun: service ? 'consultation' : 'reservation', order: [0, record.starts_at], when: visitWhen(record.starts_at, zone),
      headline: service ? guest && record.party_size > 1 ? `${Group}, consultation` : `${guest ? `${guest}’s` : 'A'} consultation` : guest && record.party_size === 1 ? `${guest}’s reservation` : Group,
      action })
  }
  for (const [, held] of byClass) {
    const record = (recordResult!.results as BookedRecordWithAmounts[]).find(row => row.id === held.card.bookings[0])!
    // A class is named by itself; its line is where and how many people are booked.
    held.card.headline = record.product_name
    held.card.line = [record.location_id === null ? 'Online' : record.location_title, `${held.party} ${held.party === 1 ? 'guest' : 'guests'}`].filter(Boolean).join(' · ')
  }

  for (const work of workResult!.results as OpenWorkRow[]) {
    const job = work.kind === 'turnover' || work.kind === 'consultation_follow_up' || work.kind === 'consultation_prep'
    const bookingZone = work.booking_timezone ?? work.timezone
    const at = work.starts_at ?? work.due_at
    // An untimed job is on its booking's day: a clean on the checkout.
    const untimed = work.booking_ends_at
    const day = at ? localDateAt(new Date(at), work.timezone) : untimed ? bookingDay(untimed, bookingZone) : null
    const guest = first(work.guest_name)
    const group = work.party_size === null ? 'a guest' : guestGroup(work.guest_name, work.party_size)
    const to = work.booking_id ? recordPath(work.booking_id, work.guest_conversation_id, work.viewer_seated) : null
    if (work.kind === 'custom') {
      // A task someone added: the viewer's, or nobody's for an owner or admin; closed in one tap from its card.
      if (!(work.assigned_to_viewer || (work.assigned_member_id === null && manage))) continue
      if (day === null ? range !== 'today' : range === 'today' ? day > today(work.timezone) : !shows(day, work.timezone)) continue
      if (!work.title) throw new Error(`Task ${work.id} has no title`)
      add({ id: `task:${work.id}`, noun: 'task', order: [1, at ?? ''], bookings: [], day: day ?? today(work.timezone),
        when: at ? visitWhen(at, work.timezone) : null, image_url: picture('product', work.product_id), icon: 'i-lucide-list-checks', headline: work.title,
        line: work.created_by_viewer ? 'Added by you' : work.creator_name ? `Added by ${first(work.creator_name)}` : null,
        action: { title: 'Mark as done', detail: 'One tap when it’s finished' }, to: null, draft: null,
        done: { path: `/api/organizations/${encodeURIComponent(viewer.organization_id)}/tasks/${encodeURIComponent(work.id)}/complete` } })
      continue
    }
    if (!job) {
      // A message that did not send and a change waiting on the business are today's work.
      if (range !== 'today' || !work.booking_id || !to || !work.booking_starts_at || !work.booking_ends_at) continue
      const bookedWhen = work.booking_unit === 'nights' ? nights({ starts_at: work.booking_starts_at, ends_at: work.booking_ends_at, timezone: bookingZone }) : dayTime(work.booking_starts_at, bookingZone)
      const place = [work.product_kind === 'table' ? null : work.product_name, work.booking_unit === 'nights' ? null : work.location_id === null ? 'Online' : work.location_title].filter(Boolean).join(' · ') || null
      const opens = Boolean(work.guest_conversation_id && work.viewer_seated)
      const image = work.product_kind === 'table' ? picture('business_location', work.location_id) : picture('product', work.product_id)
      if (work.kind === 'message_delivery') {
        if (!work.message_title) throw new Error(`Delivery task ${work.id} has no scheduled message`)
        add({ id: `task:${work.id}`, noun: 'message', order: [1, work.booking_starts_at], bookings: [], day: today(work.timezone), when: bookedWhen, image_url: image, icon: iconOf(work.product_kind), line: place, to, draft: null,
          headline: `${work.message_title} to ${guest ?? 'the guest'} didn’t send`, action: { title: 'Send it yourself', detail: opens ? `Open ${guest ?? 'the guest'}’s conversation` : 'Open the reservation' } })
      } else {
        const Group = group.charAt(0).toUpperCase() + group.slice(1)
        add({ id: `task:${work.id}`, noun: 'change', order: [1, work.booking_starts_at], bookings: [], day: today(work.timezone), when: bookedWhen, image_url: image, icon: iconOf(work.product_kind), line: place, to, draft: null,
          headline: `${Group} asked to change their ${work.booking_unit === 'nights' ? 'stay' : 'booking'}`, action: { title: 'Review the change', detail: 'Accept or decline' } })
      }
      continue
    }
    if (day === null || (range === 'today' ? day > today(work.timezone) : !shows(day, work.timezone))) continue
    // A follow-up is due the day after its visit: it is work on the day it is due, and Upcoming already shows the visit.
    if (work.kind === 'consultation_follow_up' && range === 'upcoming') continue
    // A job always has someone. Another person's clean is the action of its booking's card on that day ("Casey is cleaning");
    // the viewer's own job is its own card, which opens the job's conversation, where its Done is.
    if (!work.assigned_to_viewer) {
      const held = work.kind === 'turnover' && work.booking_id ? byBooking.get(work.booking_id) : undefined
      if (held?.day === day) held.action = { title: `${first(work.assignee_name) ?? 'A teammate'} is cleaning`, detail: guest && work.viewer_seated ? `Message ${guest}` : held.action.detail }
      continue
    }
    // Prep is the host's own preparation for a visit already on their list.
    if (work.kind === 'consultation_prep') continue
    const headline = work.kind === 'turnover' ? `Clean up after ${group}` : `Follow up with ${group}`
    const team = work.team_conversation_id
    add({
      id: `task:${work.id}`, noun: work.kind === 'consultation_follow_up' ? 'follow_up' : 'clean', order: [0, at ?? untimed ?? ''], bookings: [], day,
      when: at ? visitWhen(at, work.timezone) : range === 'today' ? 'Today' : formatTimestamp(`${day}T12:00:00.000Z`, 'en', 'UTC', { weekday: 'short', month: 'short', day: 'numeric' }),
      image_url: picture('product', work.product_id), icon: iconOf(work.product_kind), headline: headline.charAt(0).toUpperCase() + headline.slice(1),
      line: work.booking_unit === 'nights' ? work.product_name : work.location_id === null ? 'Online' : work.location_title,
      // The host's own job has nobody to message: it opens the job, where its Done is.
      action: manage ? { title: 'Open the job', detail: 'Tap Done when it’s finished' }
        : { title: 'Message the host', detail: range === 'today' ? 'Send photos when you’re done' : 'Ask anything before the day' },
      // The job's conversation is written with the job; a job read before it exists is not linked anywhere else.
      to: team ? guestConversationPath(viewer.slug, team) : null, draft: null,
    })
  }

  // The business's unfinished setup, after the day's cards: each opens the editor or settings that finishes it.
  for (const [index, step] of (setupViews(factResult!.results, unpricedResult!.results)?.opportunities ?? []).entries()) {
    add({ id: step.id, noun: 'setup', order: [2, String(index).padStart(4, '0')], bookings: [], day: '', when: null, image_url: null, icon: step.icon,
      headline: step.title, line: null, action: { title: step.detail.replace(/\.$/, ''), detail: step.status_line }, to: step.path, draft: null })
  }

  cards.sort((a, b) => a.order[0] - b.order[0] || a.order[1].localeCompare(b.order[1]) || a.id.localeCompare(b.id))
  return {
    title: heading(cards, range), cards: cards.map(({ noun: _noun, order: _order, bookings: _bookings, day: _day, ...card }) => card),
    assignees: taskAssignees(assigneeResult!.results, input.userId), resolved_at: now.toISOString(),
  }
}

/**
 * "You have 2 reservations and 1 task", "You have 2 upcoming reservations",
 * "Nothing needs you today". Setup is not counted: a business with only setup
 * left reads "Finish setting up to take bookings".
 */
function heading(cards: Card[], range: Range): string {
  const counted = cards.filter(card => card.noun !== 'setup')
  if (!counted.length) return cards.length ? 'Finish setting up to take bookings' : range === 'today' ? 'Nothing needs you today' : 'Nothing needs you in the coming days'
  const parts = (Object.keys(NOUNS) as Noun[]).filter(noun => noun !== 'setup').flatMap((noun) => {
    const count = cards.filter(card => card.noun === noun).length
    return count ? [`${count} ${range === 'upcoming' ? 'upcoming ' : ''}${NOUNS[noun][count === 1 ? 0 : 1]}`] : []
  })
  return `You have ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`
}

/** What an owner or admin reads of a booking's money, only when there is some: "$1,240 paid", "$200 of $380 paid", "free", a request's price. */
function money(record: Pick<BookedRecordWithAmounts, 'status' | 'unit' | 'owner' | 'channel' | 'total_minor' | 'currency' | 'paid_minor' | 'id'>): string | null {
  if (record.unit === 'nights' && isChannelManagedStay(record)) return record.channel === 'direct' ? null : `Paid through ${STAY_CHANNEL_LABELS[record.channel]}`
  if (record.total_minor === 0) return 'free'
  const format = (amount: number) => {
    if (!record.currency) throw new Error(`Booking ${record.id} has an amount and no currency`)
    const whole = amount % (10 ** currencyFractionDigits(record.currency)) === 0
    return formatMinorAmount(amount, record.currency, 'en-US', whole ? 0 : undefined)
  }
  if (record.status === 'pending') return record.total_minor === null ? null : format(record.total_minor)
  if (record.paid_minor > 0) return record.total_minor !== null && record.paid_minor < record.total_minor ? `${format(record.paid_minor)} of ${format(record.total_minor)} paid` : `${format(record.paid_minor)} paid`
  return null
}

