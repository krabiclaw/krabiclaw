import { HTTPError, type H3Event } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { listAgenda, listTodayAgenda, parseAgendaQuery, type AgendaQuery } from '~/server/utils/dashboard-agenda'
import { getDashboardMemberContext, type DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { latestUnansweredGuestEntryTimes, listOrganizationGuestThreads } from '~/server/domain/guest-threads/repository'
import type { GuestThreadListItemViewModel } from '~/server/domain/guest-threads/types'
import { readRecommendationDecisionInputs, readRecommendationDecisions } from '~/server/domain/business-progress'
import { agendaToTodayCard, todayFeedSchema, type TodayCard, type TodayDecision, type TodayFeedPayload } from '~/shared/dashboard-today'
import type { BusinessGoal, RecommendationFeedback, RecommendationFeedbackView } from '~/shared/business-progress'
import type { BusinessProgressOperation } from '~/shared/business-outcomes'
import { formatTimestamp, localDateAt } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { blogEditorPath, bookingEditorPath, guestConversationPath, postEditorPath } from '~/server/utils/dashboard-links'
import { loadOwnerPictures } from '~/server/notifications/hero'

export interface TodayFeedQuery {
  range: 'today' | 'upcoming'
  from?: string
  to?: string
  locationId?: string
  assignedMemberId?: string
  kinds?: Array<'reservation' | 'booking' | 'stay'>
}

export function parseTodayFeedQuery(query: Record<string, unknown>): TodayFeedQuery {
  const read = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
  const range = read('range') ?? 'today'
  if (range !== 'today' && range !== 'upcoming') throw new HTTPError({ statusCode: 400, message: 'range must be today or upcoming' })
  const kindsValue = read('kinds')
  const kinds = kindsValue?.split(',').map(kind => kind.trim())
  if (kinds?.some(kind => kind !== 'reservation' && kind !== 'booking' && kind !== 'stay')) throw new HTTPError({ statusCode: 400, message: 'Today supports reservation, booking and stay types' })
  const dates = range === 'upcoming' ? parseAgendaQuery(query) : {}
  return { range, ...dates, kinds: kinds as TodayFeedQuery['kinds'], locationId: read('locationId'), assignedMemberId: read('assigned_member_id') }
}

function card(input: Pick<TodayCard, 'id' | 'to' | 'eyebrow' | 'headline' | 'priority'> & Partial<TodayCard>): TodayCard {
  return { description: null, imageUrl: null, imageFit: 'cover', imageIcon: 'i-lucide-circle-check', badgeImageUrl: null, badgeIcon: null,
    locationId: null, assignedMemberId: null, bookingKind: null, stayId: null, productId: null, stayChannel: null, occurrenceAt: null, timeZone: null,
    actionAt: null, reason: null, decision: null, ...input }
}

/**
 * A guest who wrote within this long and has had no reply is waiting on the
 * business now. An older unanswered message is history unless a live booking,
 * the owner's priority or the owner's own decision makes it current again.
 */
const RECENT_GUEST_ENTRY_MS = 7 * 86_400_000
/** Optional work is offered sparingly and only with a reason; a day with none shows none. */
const OPTIONAL_LIMIT = 3

/** One piece of work the records support, before the owner's priorities and decisions are applied. */
interface Work {
  card: TodayCard
  /** The canonical operation and subject a decision about this work names; null when it cannot be decided from Today. */
  subject: { operation: BusinessProgressOperation; subjectId: string } | null
  /** The recorded fact that makes this work due now; null for optional work. */
  obligation: string | null
  /** The recorded fact optional work stands on. */
  fact: string
  /** The words the owner's priority is compared with. */
  text: string
  recency: string
}

function threadWork(thread: GuestThreadListItemViewModel, unansweredAt: string | undefined, organization: DashboardOrganizationRow, zone: string, now: Date): Work | null {
  if (thread.manuallyArchived || thread.mailbox === 'blocked') return null
  if (thread.guestName !== null && (typeof thread.guestName !== 'string' || !thread.guestName.trim())) throw new Error(`Guest name is missing for request ${thread.id}`)
  const conversation = thread.guestName === null
  const bookingKind = thread.submissionType === 'contact' || conversation && thread.operationalStatus === null ? null : thread.submissionType
  const pending = bookingKind === 'booking' && thread.operationalStatus === 'pending' && thread.mailbox === 'current'
  if (!pending && !unansweredAt) return null
  const noun = bookingKind === 'stay' ? 'stay' : bookingKind ? resolveBookingPresentation(bookingKind, organization.vertical).noun : null
  // A conversation without a recorded guest identity is described without inventing one.
  const name = thread.guestName ?? 'The guest'
  const live = noun !== null && thread.occurrenceAt !== null && thread.mailbox === 'current' && (thread.operationalStatus === 'pending' || thread.operationalStatus === 'confirmed')
  const waited = unansweredAt ? now.getTime() - Date.parse(unansweredAt) : null
  const obligation = pending ? `${name} is waiting for you to accept or decline their ${noun}${thread.whenLabel ? ` for ${thread.whenLabel}` : ''}.`
    : live ? `${name} has an unanswered message about their ${noun}${thread.whenLabel ? ` for ${thread.whenLabel}` : ''}.`
      : waited !== null && waited <= RECENT_GUEST_ENTRY_MS ? `${name} wrote ${formatTimestamp(unansweredAt!, 'en', zone, { weekday: 'long', hour: 'numeric', minute: '2-digit' })} and has no reply yet.`
        : null
  return {
    card: card({
      id: `${obligation ? 'attention' : 'reply'}:${thread.id}`, priority: obligation ? 'attention' : 'opportunity',
      to: pending ? bookingEditorPath(organization.slug, 'booking', thread.id) : guestConversationPath(organization.slug, thread.id),
      eyebrow: pending ? 'Awaiting your decision' : obligation ? 'Needs attention' : 'Unanswered message',
      headline: pending ? `Review ${name}’s ${noun}` : conversation && thread.operationalStatus !== 'cancelled' ? `Review conversation: ${thread.participantLabel}` : `Reply to ${thread.guestName ?? thread.participantLabel}`,
      description: [thread.locationLabel, thread.whenLabel, pending ? null : thread.preview?.text].filter(Boolean).join(' · '),
      imageUrl: thread.imageUrl, imageFit: thread.imageFit, imageIcon: bookingKind ? 'i-lucide-calendar-clock' : 'i-lucide-message-circle',
      locationId: thread.locationId, productId: thread.productId, stayChannel: thread.stayChannel, assignedMemberId: thread.assignedMemberId, bookingKind,
      occurrenceAt: thread.occurrenceAt, timeZone: thread.timeZone,
    }),
    subject: pending ? null : { operation: 'guest_thread.reply', subjectId: thread.id },
    obligation,
    fact: `${name} has had no reply since ${formatTimestamp(unansweredAt ?? thread.lastActivityAt, 'en', zone, { dateStyle: 'medium' })}.`,
    text: [thread.guestName, thread.participantLabel, thread.locationLabel, thread.preview?.text].filter(Boolean).join(' '),
    recency: unansweredAt ?? thread.lastActivityAt,
  }
}

async function publicationCards(db: DbClient, organization: DashboardOrganizationRow, locationId?: string): Promise<TodayCard[]> {
  const rows = await queryAll<{ id: string; title: string | null; location_id: string | null; channel: string; error_message: string | null }>(db, `
    SELECT p.id,p.title,p.location_id,publication.channel,publication.error_message
      FROM post_publications publication JOIN content_documents p ON p.id=publication.post_id AND p.organization_id=publication.organization_id
     WHERE publication.organization_id=? AND publication.state IN ('failed','unknown')
       ${locationId ? 'AND p.location_id=?' : ''} ORDER BY publication.updated_at,p.id,publication.channel`, [organization.id, ...(locationId ? [locationId] : [])])
  const pictures = await loadOwnerPictures(db, organization.id, 'content_document', rows.map(row => row.id))
  const grouped = new Map<string, typeof rows>()
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row])
  return [...grouped].map(([id, failures]) => card({
    id: `publication:${id}`, to: `${postEditorPath(organization.slug, id)}/publishing`, priority: 'attention', eyebrow: 'Publishing needs attention',
    headline: failures[0]!.title ? `Finish publishing “${failures[0]!.title}”` : 'Finish publishing your post',
    description: failures.map(row => `${row.channel === 'facebook' ? 'Facebook' : row.channel === 'instagram' ? 'Instagram' : 'Discord'}${row.error_message ? `: ${row.error_message}` : ''}`).join(' · '),
    imageUrl: pictures.get(id)?.imageUrl ?? null, imageIcon: 'i-lucide-send', locationId: failures[0]!.location_id,
  }))
}

async function threadWorks(db: DbClient, organization: DashboardOrganizationRow, principal: ReturnType<typeof memberAccessPrincipal>, input: TodayFeedQuery, zone: string, now: Date) {
  const threads: GuestThreadListItemViewModel[] = []
  for (let offset = 0; ; offset += 200) {
    const page = await listOrganizationGuestThreads(db, {
      organizationId: organization.id, principal, userId: organization.userId, conversationState: 'needs_attention',
      locationId: input.locationId, assignedMemberId: input.assignedMemberId, limit: 200, offset,
    })
    threads.push(...page.filter(thread => !input.kinds?.length || thread.submissionType !== 'contact' && input.kinds.includes(thread.submissionType)))
    if (page.length < 200) break
  }
  const unanswered = await latestUnansweredGuestEntryTimes(db, organization.id, threads.map(thread => thread.id))
  return threads.map(thread => threadWork(thread, unanswered.get(thread.id), organization, zone, now)).filter((work): work is Work => work !== null)
}

/** Blog drafts: finished when published, which the next read observes from the article itself. */
async function draftWorks(db: DbClient, organization: DashboardOrganizationRow, zone: string, locationId?: string): Promise<Work[]> {
  const rows = await queryAll<{ id: string; title: string | null; summary: string | null; location_id: string | null; updated_at: string }>(db, `
    SELECT id,title,summary,location_id,updated_at FROM content_documents
     WHERE organization_id=? AND row_role='root' AND kind='article' AND status='draft' AND (metadata_json ->> '$.collection')='blog'
       ${locationId ? 'AND location_id=?' : ''} ORDER BY updated_at DESC,id LIMIT 100`, [organization.id, ...(locationId ? [locationId] : [])])
  const pictures = await loadOwnerPictures(db, organization.id, 'content_document', rows.map(row => row.id))
  return rows.map(row => ({
    card: card({ id: `draft:${row.id}`, to: blogEditorPath(organization.slug, row.id), priority: 'opportunity', eyebrow: 'Draft article',
      headline: row.title ? `Finish and publish “${row.title}”` : 'Finish and publish your draft article', description: row.summary,
      imageUrl: pictures.get(row.id)?.imageUrl ?? null, imageIcon: 'i-lucide-file-pen-line', locationId: row.location_id }),
    subject: { operation: 'article.publish', subjectId: row.id },
    obligation: null,
    fact: `Saved as a draft, last edited ${formatTimestamp(row.updated_at, 'en', zone, { dateStyle: 'medium' })}.`,
    text: [row.title, row.summary].filter(Boolean).join(' '),
    recency: row.updated_at,
  }))
}

const STOP_WORDS = new Set(('the and for with our your you this that these those next last week weeks month today tomorrow more most less get make help '
  + 'finish keep start about from into have has had will want need all any new who what when where which there their them they are was were been '
  + 'being can could should would please also just only very than then some out off over its not but how why each every other such our ours us '
  + 'we me my mine him her his hers one two three day days time now soon still again done do does did').split(' '))

function stem(word: string) {
  const base = word.replace(/['’]s$/, '')
  if (base.length > 4 && base.endsWith('ies')) return `${base.slice(0, -3)}y`
  if (base.length > 4 && /(?:ss|x|ch|sh)es$/.test(base)) return base.slice(0, -2)
  if (base.length > 5 && base.endsWith('ing')) return base.slice(0, -3)
  if (base.length > 4 && base.endsWith('ed')) return base.slice(0, -2)
  if (base.length > 3 && base.endsWith('s') && !base.endsWith('ss')) return base.slice(0, -1)
  return base.length > 3 && base.endsWith('e') ? base.slice(0, -1) : base
}

function terms(text: string) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? []).filter(word => !STOP_WORDS.has(word)).map(stem).filter(word => word.length > 2 && !STOP_WORDS.has(word)))
}

/** The active priority whose own words this work shares most, if any. */
function priorityFor(goals: BusinessGoal[], text: string) {
  const words = terms(text)
  let best: { goal: BusinessGoal; score: number } | null = null
  for (const goal of goals) {
    const score = [...terms(`${goal.intent} ${goal.constraints ?? ''}`)].filter(word => words.has(word)).length
    if (score > 0 && (!best || score > best.score)) best = { goal, score }
  }
  return best
}

const DECIDED: Record<RecommendationFeedback['decision'], string> = { accept: 'chose to do', dismiss: 'dismissed', defer: 'set aside', correct: 'corrected' }

function resurfacedBecause(feedback: RecommendationFeedbackView, subject: Work['subject'], zone: string) {
  const when = formatTimestamp(feedback.revision, 'en', zone, { dateStyle: 'medium' })
  const reasons = feedback.applicability.reasons
  return [
    reasons.includes('defer_elapsed') ? `You set this aside until ${formatTimestamp(feedback.deferUntil!, 'en', zone, { dateStyle: 'medium', timeStyle: 'short' })}.` : null,
    reasons.includes('evidence_changed') ? `${subject?.operation === 'guest_thread.reply' ? 'There is new activity in this conversation' : 'This draft changed'} since you ${DECIDED[feedback.decision]} it on ${when}.` : null,
    reasons.includes('goal_changed') || reasons.includes('goal_archived') ? `The priority you ${DECIDED[feedback.decision]} this under has changed.` : null,
  ].filter(Boolean).join(' ')
}

export async function loadDashboardToday(event: H3Event, input: TodayFeedQuery, now = new Date()): Promise<TodayFeedPayload> {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const organizationWide = await roleAllows({ ...organization, permissions: { operations: ['read'] } })
  // Priorities and decisions belong to people who can direct the whole business.
  const canDecide = organizationWide && await roleAllows({ ...organization, permissions: { organization: ['update'] } })
  const ownerScope = organizationWide && !input.assignedMemberId && !input.kinds?.length
  const resolvedAt = now.toISOString()
  const query: AgendaQuery = { from: input.from!, to: input.to!, kinds: input.kinds ?? ['reservation','booking','stay'], locationId: input.locationId,
    assignedMemberId: input.assignedMemberId, organizationSlug: organization.slug, principal: { env, membership: organization } }
  const agenda = input.range === 'today'
    ? await listTodayAgenda(db, { organizationId: organization.id }, { organizationSlug: organization.slug, principal: query.principal }, now)
    : await listAgenda(db, { organizationId: organization.id }, query)
  if (input.locationId && !agenda.locations.some(location => location.id === input.locationId)) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
  const zone = (await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM organization WHERE id = ?', [organization.id]))?.timezone
  if (!zone) throw new Error(`Organization ${organization.id} has no timezone`)
  const today = localDateAt(now, zone)
  const schedule = agenda.items.filter(item => (!input.locationId || item.locationId === input.locationId)
    && (!input.assignedMemberId || item.assignedMemberId === input.assignedMemberId)
    && (!input.kinds?.length || item.kind !== 'post' && input.kinds.includes(item.kind))
    && (input.range === 'today' || item.dayKey > localDateAt(now, item.timeZone)))
  const scheduleCards = schedule.map(item => agendaToTodayCard(item, { resolvedAt, vertical: organization.vertical, assigned: !organizationWide }))
  const availableKinds = agenda.availableKinds.filter((kind): kind is 'reservation' | 'booking' | 'stay' => kind === 'reservation' || kind === 'booking' || kind === 'stay')
  const locations = agenda.locations

  const [threads, drafts, failures, inputs] = await Promise.all([
    (input.range === 'today' || canDecide) && (organization.vertical !== 'lodging' || organizationWide) ? threadWorks(db, organization, principal, input, zone, now) : [],
    ownerScope && canDecide && await roleAllows({ ...organization, permissions: { content: ['update'] } }) ? draftWorks(db, organization, zone, input.locationId) : [],
    input.range === 'today' && ownerScope && await roleAllows({ ...organization, permissions: { content: ['publish'] } }) ? publicationCards(db, organization, input.locationId) : [],
    canDecide ? readRecommendationDecisionInputs(db, principal) : null,
  ])
  const goals = inputs?.goals.filter(goal => goal.status === 'active') ?? []
  const works = [...threads, ...drafts].map(work => ({ ...work, match: priorityFor(goals, work.text) }))
  // Evidence is read only for work that could be shown: due work, work the
  // owner's priority names, and work the owner has already decided about.
  // Upcoming shows only work the owner planned for a later day.
  const considered = (work: typeof works[number]) => Boolean(inputs && work.subject
    && (inputs.decided(work.subject).length || input.range === 'today' && (work.obligation || work.match)))
  const decisions = inputs && await readRecommendationDecisions(db, principal, inputs, works.filter(considered).map(work => work.subject!), now)

  const due: TodayCard[] = [], planned: TodayCard[] = [], optional: Array<{ card: TodayCard; rank: number[] }> = []
  for (const work of works) {
    const entry = work.subject && decisions ? decisions.get(work.subject) : null
    // A subject whose evidence can no longer be read is not work anyone can decide about now.
    if (considered(work) && !entry) continue
    const feedback = entry?.feedback ?? null
    const current = feedback?.applicability.current ? feedback : null
    if (current && (current.decision === 'dismiss' || current.decision === 'correct')) continue
    const goal = work.match?.goal ?? null
    const decision: TodayDecision | null = entry && work.subject ? {
      operation: work.subject.operation, subjectId: work.subject.subjectId, evidenceRevision: entry.reference.evidenceRevision,
      goalId: goal?.id ?? null, goalRevision: goal?.revision ?? null,
      revision: entry.saved.find(saved => saved.evidenceRevision === entry.reference.evidenceRevision && saved.goalId === (goal?.id ?? null) && saved.goalRevision === (goal?.revision ?? null))?.revision ?? null,
      current: current && { decision: current.decision, note: current.note, deferUntil: current.deferUntil },
    } : null
    const reason = [
      feedback && !current ? resurfacedBecause(feedback, work.subject, zone) : null,
      current?.decision === 'accept' ? 'You chose to do this.' : null,
      current?.decision === 'defer' ? `You set this aside until ${formatTimestamp(current.deferUntil!, 'en', zone, { dateStyle: 'medium', timeStyle: 'short' })}.` : null,
      work.obligation ?? work.fact,
      goal ? `It supports your priority “${goal.intent}”${goal.targetAt ? `, due ${formatTimestamp(goal.targetAt, 'en', zone, { dateStyle: 'medium' })}` : ''}.` : null,
      feedback?.note ? `Your note: “${feedback.note}”` : null,
    ].filter(Boolean).join(' ')
    const shown = { ...work.card, reason, decision }
    if (current?.decision === 'defer') {
      const day = localDateAt(new Date(current.deferUntil!), zone)
      const inWindow = input.range === 'today' ? day <= today : day > today && day >= input.from! && day <= input.to!
      if (inWindow) planned.push({ ...shown, actionAt: current.deferUntil, eyebrow: `${day === today ? 'Later today' : 'Planned for'} ${formatTimestamp(current.deferUntil!, 'en', zone, day === today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` })
      continue
    }
    if (input.range !== 'today') continue
    if (work.obligation) { due.push(shown); continue }
    const elapsed = feedback?.applicability.reasons.includes('defer_elapsed') ?? false
    if (!ownerScope || !(current?.decision === 'accept' || goal || elapsed)) continue
    optional.push({ card: shown, rank: [current?.decision === 'accept' ? 1 : 0, elapsed ? 1 : 0, work.match?.score ?? 0, Date.parse(work.recency)] })
  }
  const priorities = inputs ? goals.map(goal => ({ id: goal.id, intent: goal.intent, constraints: goal.constraints, targetAt: goal.targetAt, revision: goal.revision })) : null
  if (input.range === 'upcoming') {
    const when = (item: TodayCard) => item.actionAt ?? item.occurrenceAt ?? ''
    return todayFeedSchema.parse({ cards: [...scheduleCards, ...planned].sort((a, b) => when(a).localeCompare(when(b)) || a.id.localeCompare(b.id)), availableKinds, locations, resolvedAt, priorities })
  }
  const handledRequests = new Set(due.map(item => item.id.slice(item.id.indexOf(':') + 1)))
  const byRank = (a: typeof optional[number], b: typeof optional[number]) => {
    const index = a.rank.findIndex((value, position) => value !== b.rank[position])
    return index === -1 ? a.card.id.localeCompare(b.card.id) : b.rank[index]! - a.rank[index]!
  }
  const chosen = optional.sort(byRank).slice(0, OPTIONAL_LIMIT).map(item => item.card)
  const cards = [...due, ...failures, ...scheduleCards.filter(item => !handledRequests.has(item.id.slice(item.id.indexOf(':') + 1))), ...planned.sort((a, b) => a.actionAt!.localeCompare(b.actionAt!)), ...chosen]
  return todayFeedSchema.parse({ cards, availableKinds, locations, resolvedAt, priorities })
}
