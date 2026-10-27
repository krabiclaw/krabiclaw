import { HTTPError, type H3Event } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { listAgenda, listTodayAgenda, parseAgendaQuery, type AgendaQuery } from '~/server/utils/dashboard-agenda'
import { getDashboardMemberContext, type DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { listOrganizationGuestThreads } from '~/server/domain/guest-threads/repository'
import type { GuestThreadListItemViewModel } from '~/server/domain/guest-threads/types'
import { agendaToTodayCard, todayFeedSchema, type TodayCard, type TodayFeedPayload } from '~/shared/dashboard-today'
import { addLocalDays, localDateAt } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { articleFacebookPostPath, blogEditorPath, bookingEditorPath, guestConversationPath, insightsPath, postEditorPath, productEditorPath } from '~/server/utils/dashboard-links'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { getAnalyticsReport, resolveOrganizationAnalyticsContext } from '~/server/utils/analytics-report'
import { readIntegration } from '~/server/utils/organization-integrations'
import { linkedAccountAccessToken, type CloudflareEnv } from '~/server/utils/auth'
import { getGoogleAdsCustomer, getGoogleAdsPerformanceSummary } from '~/server/utils/google-ads'
import { getBlogPost } from '~/server/utils/content/publishing'
import { planOffers } from '~/shared/offers'
import { getOrganizationEntitlements } from '~/server/utils/billing-access'

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
    locationId: null, assignedMemberId: null, bookingKind: null, stayId: null, productId: null, stayChannel: null, occurrenceAt: null, timeZone: null, ...input }
}

function attentionCard(thread: GuestThreadListItemViewModel, organization: DashboardOrganizationRow): TodayCard {
  if (thread.guestName !== null && (typeof thread.guestName !== 'string' || !thread.guestName.trim())) throw new Error(`Guest name is missing for request ${thread.id}`)
  const conversation = thread.guestName === null
  const bookingKind = thread.submissionType === 'contact' || conversation && thread.operationalStatus === null ? null : thread.submissionType
  const pending = bookingKind === 'booking' && thread.operationalStatus === 'pending'
  const cancelled = (bookingKind === 'booking' || bookingKind === 'reservation') && thread.operationalStatus === 'cancelled'
  const reply = conversation || thread.submissionType === 'contact' || thread.latestMessageFromGuest || cancelled
  const noun = bookingKind === 'stay' ? 'stay' : bookingKind ? resolveBookingPresentation(bookingKind, organization.vertical).noun : null
  return card({
    id: `attention:${thread.id}`, priority: 'attention',
    to: bookingKind !== null && bookingKind !== 'stay' && (pending || !reply) ? bookingEditorPath(organization.slug, bookingKind, thread.id) : guestConversationPath(organization.slug, thread.id),
    eyebrow: pending ? 'Awaiting your decision' : 'Needs attention',
    headline: conversation && !cancelled ? `Review conversation: ${thread.participantLabel}` : pending ? `Review ${thread.guestName}’s ${noun}` : reply
      ? `Reply to ${thread.guestName ?? thread.participantLabel}` : `Review ${thread.guestName}’s ${noun}`,
    description: [thread.locationLabel, thread.whenLabel, reply ? thread.preview?.text : null].filter(Boolean).join(' · '),
    imageUrl: thread.imageUrl, imageFit: thread.imageFit, imageIcon: bookingKind ? 'i-lucide-calendar-clock' : 'i-lucide-message-circle',
    locationId: thread.locationId, productId: thread.productId, stayChannel: thread.stayChannel, assignedMemberId: thread.assignedMemberId, bookingKind,
    occurrenceAt: thread.occurrenceAt, timeZone: thread.timeZone,
  })
}

async function attentionThreads(db: DbClient, organization: DashboardOrganizationRow, principal: ReturnType<typeof memberAccessPrincipal>, input: TodayFeedQuery) {
  const threads: GuestThreadListItemViewModel[] = []
  for (let offset = 0; ; offset += 200) {
    const page = await listOrganizationGuestThreads(db, {
      organizationId: organization.id, principal, userId: organization.userId, conversationState: 'needs_attention',
      locationId: input.locationId, assignedMemberId: input.assignedMemberId, limit: 200, offset,
    })
    threads.push(...page.filter(thread => !thread.manuallyArchived && (thread.mailbox === 'current' || thread.latestMessageFromGuest || thread.submissionType !== 'stay' && thread.operationalStatus === 'cancelled')
      && (!input.kinds?.length || thread.submissionType !== 'contact' && input.kinds.includes(thread.submissionType))))
    if (page.length < 200) return threads
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

async function performanceCard(db: DbClient, organization: DashboardOrganizationRow, now: Date): Promise<TodayCard | null> {
  const context = await resolveOrganizationAnalyticsContext(db, organization.id)
  const endDate = addLocalDays(localDateAt(now, context.timezone), -1)
  const startDate = addLocalDays(endDate, -6)
  const report = await getAnalyticsReport(db, { organizationId: organization.id, startDate, endDate, now })
  if (report.metrics.changePercent === null || report.metrics.changePercent === 0) return null
  const change = report.metrics.changePercent
  return card({ id: `performance:${startDate}:${endDate}`, to: insightsPath(organization.slug, { startDate, endDate }), priority: 'opportunity',
    eyebrow: 'Your last 7 complete days', headline: `${report.metrics.pageViews.toLocaleString('en')} page views`,
    description: `${Math.abs(change)}% ${change > 0 ? 'more' : 'fewer'} than the previous 7 days. View your website performance.`, imageIcon: 'i-lucide-chart-no-axes-combined' })
}

// Airbnb's suggestion card: the first thing the plan lacks, offered to someone who can take it, with the same picture Menu offers it with.
async function offerCard(env: CloudflareEnv, organization: DashboardOrganizationRow): Promise<TodayCard | null> {
  const [offer] = planOffers(await getOrganizationEntitlements(env, organization.id))
  if (!offer || !('plan' in offer.unlock)) return null
  const plan = offer.unlock.plan
  return card({ id: `offer:${offer.id}`, to: `/dashboard/${encodeURIComponent(organization.slug)}/${offer.path}`, priority: 'opportunity',
    eyebrow: `Included with ${plan.charAt(0).toUpperCase() + plan.slice(1)}`, headline: offer.headline, description: offer.line,
    imageUrl: offer.illustration, imageFit: 'cover', imageIcon: 'i-lucide-sparkles' })
}

// What the connected Google Ads account did in the last 7 complete days, in its own currency as Google reports it.
async function googleAdsCard(db: DbClient, env: CloudflareEnv, organization: DashboardOrganizationRow, now: Date): Promise<TodayCard | null> {
  const connection = await readIntegration(db, organization.id, 'google_ads')
  if (!connection) return null
  const { accessToken } = await linkedAccountAccessToken(env, connection.account_id)
  // Google reports a day in the account's own time zone, so a complete day is one that has closed there.
  const customer = await getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, connection.target_id)
  // A manager account has no results of its own; the business chooses the account it advertises from.
  if (customer.isManager) {
    return card({ id: `google-ads-manager:${connection.target_id}`, to: `/dashboard/${encodeURIComponent(organization.slug)}/integrations/google-ads`, priority: 'attention',
      eyebrow: 'Google Ads', headline: 'Choose the Google Ads account you advertise from',
      description: `${connection.target_name} is a manager account, which has no campaigns or results of its own. Disconnect it and choose one of the accounts it manages.`, imageIcon: 'i-lucide-megaphone' })
  }
  const endDate = addLocalDays(localDateAt(now, customer.timeZone), -1)
  const startDate = addLocalDays(endDate, -6)
  const summary = await getGoogleAdsPerformanceSummary(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, connection.target_id, startDate, endDate)
  if (summary.costMicros === 0) return null
  const spend = new Intl.NumberFormat('en', { style: 'currency', currency: summary.currencyCode, maximumFractionDigits: 2 }).format(summary.costMicros / 1_000_000)
  // Conversions can be fractional, as Google attributes them.
  const conversions = summary.conversions.toLocaleString('en', { maximumFractionDigits: 1 })
  return card({ id: `google-ads:${startDate}:${endDate}`, to: insightsPath(organization.slug, { startDate, endDate, tab: 'ads' }), priority: 'opportunity',
    eyebrow: 'Google Ads, your last 7 complete days', headline: summary.conversions === 0 ? `${spend} on ads, no conversions` : `${spend} on ads, ${conversions} ${summary.conversions === 1 ? 'conversion' : 'conversions'}`,
    description: `${summary.clicks.toLocaleString('en')} ${summary.clicks === 1 ? 'click' : 'clicks'} from ${connection.target_name}. See your campaigns in Insights.`, imageIcon: 'i-lucide-megaphone' })
}

async function contentOpportunities(db: DbClient, organization: DashboardOrganizationRow, env: Parameters<typeof getBlogPost>[3], locationId?: string): Promise<TodayCard[]> {
  const [draft, missingPhoto, article, facebook] = await Promise.all([
    queryFirst<{ id: string; kind: string; title: string | null; location_id: string | null }>(db, `SELECT id,kind,title,location_id FROM content_documents
      WHERE organization_id=? AND row_role='root' AND status='draft' AND (kind='social_post' OR (kind='article' AND (metadata_json ->> '$.collection')='blog'))
      ${locationId ? 'AND location_id=?' : ''} ORDER BY updated_at DESC,id LIMIT 1`, [organization.id, ...(locationId ? [locationId] : [])]),
    queryFirst<{ id: string; name: string }>(db, `SELECT p.id,p.name FROM products p JOIN product_publications pub ON pub.product_id=p.id AND pub.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.active=1 AND pub.published=1 AND p.kind <> 'service'
      ${locationId ? 'AND EXISTS (SELECT 1 FROM product_locations pl WHERE pl.product_id=p.id AND pl.organization_id=p.organization_id AND pl.location_id=? AND pl.published=1)' : ''}
      AND NOT EXISTS (SELECT 1 FROM media_placements mp JOIN media_assets ma ON ma.id=mp.asset_id AND ma.status='active' WHERE mp.owner_type='product' AND mp.owner_id=p.id AND mp.organization_id=p.organization_id AND mp.status='active' AND mp.slot IN ('image','gallery') AND ma.kind='image')
      ORDER BY p.name,p.id LIMIT 1`, [organization.id, ...(locationId ? [locationId] : [])]),
    locationId || !organization.public_url ? Promise.resolve(null) : queryFirst<{ id: string; title: string }>(db, `SELECT id,title FROM content_documents WHERE organization_id=? AND kind='article' AND row_role='root' AND status='published' AND (metadata_json ->> '$.collection')='blog' ORDER BY published_at DESC,id LIMIT 1`, [organization.id]),
    readIntegration(db, organization.id, 'facebook'),
  ])
  const cards: TodayCard[] = []
  if (draft) {
    const picture = await loadOwnerPictures(db, organization.id, 'content_document', [draft.id])
    cards.push(card({ id: `draft:${draft.id}`, to: draft.kind === 'article' ? blogEditorPath(organization.slug, draft.id) : postEditorPath(organization.slug, draft.id), priority: 'opportunity',
      eyebrow: 'Continue your draft', headline: draft.title ? `Finish “${draft.title}”` : 'Finish your draft post',
      description: draft.kind === 'article' ? 'Your blog article is saved as a draft.' : 'Your post is saved as a draft.', imageUrl: picture.get(draft.id)?.imageUrl ?? null, imageIcon: 'i-lucide-file-pen-line', locationId: draft.location_id }))
  }
  if (missingPhoto) cards.push(card({ id: `photo:${missingPhoto.id}`, to: `${productEditorPath(organization.slug, missingPhoto.id)}/photo${locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''}`,
    priority: 'opportunity', eyebrow: 'Missing a photo', headline: `Add a photo of ${missingPhoto.name}`, description: 'This published item has no photo.', imageIcon: 'i-lucide-image-plus', locationId: locationId ?? null, productId: missingPhoto.id }))
  if (article && facebook?.status === 'active' && organization.public_url) {
    const source = await getBlogPost(db, article.id, organization.id, env)
    if (typeof source.public_path !== 'string') throw new Error('Published article has no public path')
    const url = new URL(source.public_path, organization.public_url).toString()
    const shared = await queryFirst<{ id: string }>(db, `SELECT id FROM content_documents WHERE organization_id=? AND kind='social_post' AND row_role='root' AND (metadata_json ->> '$.call_to_action.url')=? LIMIT 1`, [organization.id, url])
    if (!shared) {
      const picture = await loadOwnerPictures(db, organization.id, 'content_document', [article.id])
      cards.push(card({ id: `share:${article.id}`, to: articleFacebookPostPath(organization.slug, article.id), priority: 'opportunity', eyebrow: 'Share your article',
        headline: `Share “${article.title}” on Facebook`, description: `Your published article has no saved post linking to it. Prepare a draft for ${facebook.target_name}.`,
        imageUrl: picture.get(article.id)?.imageUrl ?? null, imageIcon: 'i-lucide-share-2' }))
    }
  }
  return cards
}

export async function loadDashboardToday(event: H3Event, input: TodayFeedQuery, now = new Date()): Promise<TodayFeedPayload> {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const organizationWide = await roleAllows({ ...organization, permissions: { operations: ['read'] } })
  const resolvedAt = now.toISOString()
  const query: AgendaQuery = { from: input.from!, to: input.to!, kinds: input.kinds ?? ['reservation','booking','stay'], locationId: input.locationId,
    assignedMemberId: input.assignedMemberId, organizationSlug: organization.slug, principal: { env, membership: organization } }
  const agenda = input.range === 'today'
    ? await listTodayAgenda(db, { organizationId: organization.id }, { organizationSlug: organization.slug, principal: query.principal }, now)
    : await listAgenda(db, { organizationId: organization.id }, query)
  if (input.locationId && !agenda.locations.some(location => location.id === input.locationId)) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
  const schedule = agenda.items.filter(item => (!input.locationId || item.locationId === input.locationId)
    && (!input.assignedMemberId || item.assignedMemberId === input.assignedMemberId)
    && (!input.kinds?.length || item.kind !== 'post' && input.kinds.includes(item.kind))
    && (input.range === 'today' || item.dayKey > localDateAt(now, item.timeZone)))
  const scheduleCards = schedule.map(item => agendaToTodayCard(item, { resolvedAt, vertical: organization.vertical, assigned: !organizationWide }))
  const availableKinds = agenda.availableKinds.filter((kind): kind is 'reservation' | 'booking' | 'stay' => kind === 'reservation' || kind === 'booking' || kind === 'stay')
  const locations = agenda.locations
  if (input.range === 'upcoming') {
    return todayFeedSchema.parse({ cards: scheduleCards.sort((a,b) => (a.occurrenceAt ?? '').localeCompare(b.occurrenceAt ?? '') || a.id.localeCompare(b.id)), availableKinds, locations, resolvedAt })
  }

  const ownerScope = organizationWide && !input.assignedMemberId && !input.kinds?.length
  const [threads, failures, performance, ads, opportunities, offer] = await Promise.all([
    organization.vertical !== 'lodging' || organizationWide ? attentionThreads(db, organization, principal, input) : [],
    ownerScope && await roleAllows({ ...organization, permissions: { content: ['publish'] } }) ? publicationCards(db, organization, input.locationId) : [],
    ownerScope && !input.locationId && await roleAllows({ ...organization, permissions: { analytics: ['read'] } }) ? performanceCard(db, organization, now) : null,
    ownerScope && !input.locationId && await roleAllows({ ...organization, permissions: { analytics: ['read'] } }) ? googleAdsCard(db, env, organization, now) : null,
    ownerScope && await roleAllows({ ...organization, permissions: { content: ['update'] } }) ? contentOpportunities(db, organization, env, input.locationId) : [],
    ownerScope && !input.locationId && await roleAllows({ ...organization, permissions: { billing: ['update'] } }) ? offerCard(env, organization) : null,
  ])
  const attention = threads.map(thread => attentionCard(thread, organization))
  const handledRequests = new Set(threads.map(thread => thread.id))
  const publicationIds = new Set(failures.map(item => item.id.slice('publication:'.length)))
  // Two things to do, then the one offer: it never crowds out the day's own work.
  const selectedOpportunities = [...[...(performance ? [performance] : []), ...(ads ? [ads] : []), ...opportunities.filter(item => !publicationIds.has(item.id.slice(item.id.indexOf(':') + 1)))].slice(0, 2), ...(offer ? [offer] : [])]
  const cards = [...attention, ...failures, ...scheduleCards.filter(item => !handledRequests.has(item.id.slice(item.id.indexOf(':') + 1))), ...selectedOpportunities]
  return todayFeedSchema.parse({ cards, availableKinds, locations, resolvedAt })
}
