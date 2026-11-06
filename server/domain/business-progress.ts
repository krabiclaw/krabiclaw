import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import { assertOrganizationWideAccess, assertRoleAllows, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { creationDedupeKey, creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { listBusinessOutcomes, readArticleDistribution, readBusinessProgressReference } from '~/server/utils/business-outcomes'
import type { BusinessProgressOperation, BusinessProgressReference } from '~/shared/business-outcomes'
import { businessGoalStrategySchema, createBusinessGoalSchema, updateBusinessGoalSchema, type BusinessGoal, type BusinessGoalStrategy } from '~/shared/business-progress'
import { publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { queryOrganizationAnalytics } from '~/server/utils/analytics-query'
import { addLocalDays, formatTimestamp, localDateAt } from '~/utils/timezone'
import { articleSocialPostPath, blogCreatePath, blogEditorPath, postEditorPath, productEditorPath } from '~/server/utils/dashboard-links'
import { listSessions } from '~/server/utils/availability'
import { listReservationSlots } from '~/server/utils/reservations'
import { readStayGapCandidates, stayAccessFor } from '~/server/domain/stays'
import { readStripeCheckoutSetup } from '~/server/utils/stripe-connect'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { readIntegration } from '~/server/utils/organization-integrations'
import { linkedAccountAccessToken } from '~/server/utils/auth'
import { getGoogleAdsReport } from '~/server/utils/google-ads'
import { querySearchAnalytics } from '~/server/utils/google-search-console'
import { getSocialConnections } from '~/server/utils/social-publication'
import { isPublicationPreparationResumable } from '~/shared/posts'
import { getProduct, resolveVariantPrice } from '~/server/utils/product-management'
import type { CurrencyCode } from '~/shared/currencies'

interface GoalRow {
  id: string; intent: string; constraints: string | null; target_at: string | null; status: BusinessGoal['status']; strategy_json: string | null
  created_by_user_id: string | null; updated_by_user_id: string | null; created_at: string; updated_at: string
}
const goalOf = (row: GoalRow): BusinessGoal => ({
  id: row.id, intent: row.intent, constraints: row.constraints, targetAt: row.target_at, status: row.status,
  strategy: row.strategy_json === null ? null : businessGoalStrategySchema.parse(JSON.parse(row.strategy_json)),
  createdBy: row.created_by_user_id, updatedBy: row.updated_by_user_id, createdAt: row.created_at, revision: row.updated_at,
})
const conflict = (message: string) => new HTTPError({ statusCode: 409, message, data: { code: 'PROGRESS_REVISION_CONFLICT' } })

async function authorize(db: DbClient, principal: MemberAccessPrincipal) {
  await assertOrganizationWideAccess(db, principal)
  await assertRoleAllows({ ...principal, permissions: { organization: ['update'] } })
}

async function readGoal(db: DbClient, organizationId: string, id: string): Promise<BusinessGoal> {
  const row = await queryFirst<GoalRow>(db, 'SELECT * FROM organization_goals WHERE organization_id = ? AND id = ?', [organizationId, id])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Goal not found', data: { code: 'GOAL_NOT_FOUND' } })
  return goalOf(row)
}

export async function createBusinessGoal(db: DbClient, principal: MemberAccessPrincipal, body: unknown): Promise<BusinessGoal> {
  await authorize(db, principal)
  const parsed = createBusinessGoalSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Invalid goal', data: parsed.error.flatten() })
  const { idempotencyKey, intent } = parsed.data
  const constraints = parsed.data.constraints ?? null, targetAt = parsed.data.targetAt ?? null
  const strategy = parsed.data.strategy ?? null
  const key = creationDedupeKey('organization_goal', principal.organizationId, idempotencyKey)
  const requestHash = await creationRequestHash({ actorId: principal.userId, intent, constraints, targetAt, strategy: strategy ?? undefined })
  const replay = async () => {
    const record = await readCreationRecord(db, key)
    if (!record) return null
    if (record.requestHash !== requestHash) throw conflict('This idempotency key already names a different goal request')
    return readGoal(db, principal.organizationId, record.entityId)
  }
  const previous = await replay()
  if (previous) {
    await publishBusinessInvalidation(principal.env, principal.organizationId)
    return previous
  }
  const id = crypto.randomUUID(), now = new Date().toISOString()
  try {
    await executeBatch(db, [
      { query: `INSERT INTO organization_goals(id, organization_id, intent, constraints, target_at, strategy_json, status, created_by_user_id, updated_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`, params: [id, principal.organizationId, intent, constraints, targetAt, strategy === null ? null : JSON.stringify(strategy), principal.userId, principal.userId, now, now] },
      organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId, eventType: 'goal.created', entityType: 'organization_goal', entityId: id,
        dedupeKey: key, afterState: { intent, constraints, targetAt, strategy, status: 'active' }, metadata: { request_hash: requestHash } }),
    ])
  } catch (error) {
    if (!isUniqueDedupeConflict(error)) throw error
    const concurrent = await replay()
    if (!concurrent) throw error
    await publishBusinessInvalidation(principal.env, principal.organizationId)
    return concurrent
  }
  await publishBusinessInvalidation(principal.env, principal.organizationId)
  return readGoal(db, principal.organizationId, id)
}

export async function updateBusinessGoal(db: DbClient, principal: MemberAccessPrincipal, id: string, body: unknown): Promise<BusinessGoal> {
  await authorize(db, principal)
  const parsed = updateBusinessGoalSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Invalid goal update', data: parsed.error.flatten() })
  const current = await readGoal(db, principal.organizationId, id)
  const { revision, ...patch } = parsed.data
  if (current.revision !== revision) throw conflict('The goal changed; read its current revision before editing')
  const next = { intent: current.intent, constraints: current.constraints, targetAt: current.targetAt, strategy: current.strategy, status: current.status, ...patch }
  if (next.intent === current.intent && next.constraints === current.constraints && next.targetAt === current.targetAt && next.status === current.status && JSON.stringify(next.strategy) === JSON.stringify(current.strategy)) {
    await publishBusinessInvalidation(principal.env, principal.organizationId)
    return current
  }
  const now = new Date(Math.max(Date.now(), Date.parse(current.revision) + 1)).toISOString()
  const result = await executeBatch(db, [
    { query: `UPDATE organization_goals SET intent = ?, constraints = ?, target_at = ?, strategy_json = ?, status = ?, updated_by_user_id = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND updated_at = ?`, params: [next.intent, next.constraints, next.targetAt, next.strategy === null ? null : JSON.stringify(next.strategy), next.status, principal.userId, now, id, principal.organizationId, revision] },
    organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId, eventType: 'goal.updated', entityType: 'organization_goal', entityId: id,
      beforeState: current, afterState: { ...next, revision: now }, onlyIfPreviousChangedOneRow: true }),
  ])
  if (result[0]?.meta.changes !== 1) throw conflict('The goal changed while this edit was being saved')
  await publishBusinessInvalidation(principal.env, principal.organizationId)
  return readGoal(db, principal.organizationId, id)
}

async function referenceOrNull(db: DbClient, principal: MemberAccessPrincipal, subject: { operation: BusinessProgressOperation; subjectId: string }) {
  try {
    return await readBusinessProgressReference(db, principal, subject)
  } catch (error) {
    if (!(error instanceof HTTPError) || error.statusCode !== 404) throw error
    return null
  }
}

/** Authored intent and canonical evidence; the work it led to is in tasks and opportunities. */
export async function readBusinessProgress(db: DbClient, principal: MemberAccessPrincipal, page: { limit?: number; offset?: number } = {}) {
  await authorize(db, principal)
  const [outcomes, goalRows] = await Promise.all([
    listBusinessOutcomes(db, principal, page),
    queryAllPages<GoalRow>(db, 'SELECT * FROM organization_goals WHERE organization_id = ? ORDER BY updated_at DESC, id DESC', [principal.organizationId]),
  ])
  return { goals: goalRows.map(goalOf), ...outcomes }
}

export interface BusinessRecommendation {
  operation: BusinessProgressOperation
  subjectId: string
  headline: string
  reason: string
  to: string
  icon: string
  locationId: string | null
  productId: string | null
  goal: BusinessGoal | null
  reference: BusinessProgressReference
}

interface MarketingPage { path: string; count: number; source: string }
interface RecommendationDocument {
  id: string; kind: string; title: string | null; slug: string | null; status: string | null
  location_id: string | null; updated_at: string; published_at: string | null
}
interface RecommendationProduct { id: string; name: string; slug: string; kind: string; online_payment_required: number | null }

/** Live provider reports have no persisted counterpart. Cache only this performance window;
 * source completion, authorization and eligibility are read again on every request. */
async function marketingPages(db: DbClient, principal: MemberAccessPrincipal, organization: { timezone: string; analytics_data_start_at: string | null }, now: Date, useAds: boolean) {
  const issues: string[] = [], pages: MarketingPage[] = []
  const endDate = localDateAt(now, organization.timezone), startDate = addLocalDays(endDate, -27)
  let nativeSessions: number | null = null
  let nativeUnavailable = false
  if (organization.analytics_data_start_at) {
    try {
      const report = await queryOrganizationAnalytics(db, { organizationId: principal.organizationId, mode: 'breakdown', startDate, endDate,
        dimensions: ['page_path'], metrics: ['sessions'], filters: { kind: 'pageview' }, sort: { metric: 'sessions', direction: 'desc' },
        limit: 30, now, cursorSecret: principal.env.BETTER_AUTH_SECRET })
      nativeSessions = Number((report.totals.sessions as { value: number }).value)
      for (const row of report.rows) {
        const dimensions = row.dimensions as Record<string, unknown>, metrics = row.metrics as Record<string, unknown>
        if (typeof dimensions.page_path === 'string') pages.push({ path: dimensions.page_path, count: Number(metrics.sessions), source: 'recorded website sessions' })
      }
    } catch (error) {
      nativeUnavailable = true
      nativeSessions = null
      pages.length = 0
      issues.push(`Website performance could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const provider of ['google_ads', 'google_search_console'] as const) {
    if (provider === 'google_ads' && !useAds) continue
    const integration = await readIntegration(db, principal.organizationId, provider)
    if (!integration) continue
    const kv = principal.env.ORGANIZATION_CACHE
    if (!kv) throw new Error('ORGANIZATION_CACHE is required for marketing performance reports')
    const providerEnd = addLocalDays(endDate, provider === 'google_search_console' ? -3 : -1)
    const key = `business-performance:${principal.organizationId}:${provider}:${integration.revision}:${startDate}:${providerEnd}`
    try {
      const cached = await kv.get(key, 'json') as { pages: MarketingPage[] } | null
      if (cached) {
        if (!Array.isArray(cached.pages) || cached.pages.some(page => typeof page.path !== 'string' || typeof page.count !== 'number' || typeof page.source !== 'string')) throw new Error('Stored marketing performance is invalid')
        pages.push(...cached.pages)
        continue
      }
      const { accessToken } = await linkedAccountAccessToken(principal.env, integration.account_id)
      let observed: MarketingPage[]
      if (provider === 'google_ads') {
        const report = await getGoogleAdsReport(accessToken, principal.env.GOOGLE_ADS_DEVELOPER_TOKEN, integration.target_id,
          { report: 'landing_pages', startDate, endDate: providerEnd, limit: 30 })
        observed = report.map(row => ({ path: new URL(row.text).pathname, count: row.clicks, source: 'Google Ads clicks' }))
      } else {
        const report = await querySearchAnalytics(accessToken, integration.target_id, { startDate, endDate: providerEnd,
          dimensions: ['page'], dataState: 'final', searchType: 'web', aggregationType: 'byPage', rowLimit: 30, startRow: 0, filters: [] })
        observed = report.rows.flatMap(row => row.keys.page ? [{ path: new URL(row.keys.page).pathname, count: row.clicks, source: 'organic Google clicks' }] : [])
      }
      await kv.put(key, JSON.stringify({ pages: observed }), { expirationTtl: 900 })
      pages.push(...observed)
    } catch (error) {
      issues.push(`${provider === 'google_ads' ? 'Google Ads' : 'Search Console'} performance could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { pages, nativeSessions, nativeUnavailable, issues }
}

/** Current source facts select the next useful step. There is no daily reset, task ledger,
 * completion checkbox, generated tenant data or model invocation in this read. */
export async function readBusinessRecommendations(db: DbClient, principal: MemberAccessPrincipal, input: { now?: Date; locationId?: string } = {}) {
  await authorize(db, principal)
  const now = input.now ?? new Date(), organizationId = principal.organizationId
  const organization = await queryFirst<{ slug: string; name: string; vertical: string; timezone: string; default_currency: CurrencyCode; analytics_data_start_at: string | null }>(db,
    'SELECT slug,name,vertical,timezone,default_currency,analytics_data_start_at FROM organization WHERE id=?', [organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  if (input.locationId && !await queryFirst(db, 'SELECT id FROM business_locations WHERE id=? AND organization_id=?', [input.locationId, organizationId])) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
  const goals = (await queryAllPages<GoalRow>(db, "SELECT * FROM organization_goals WHERE organization_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC", [organizationId])).map(goalOf)
  const structured = goals.filter(goal => goal.strategy !== null)
  // Explicit strategies prioritize their channels. They do not turn a payments goal
  // into a marketing dead end or require a goal before a business can grow.
  const enabled = (channel: BusinessGoalStrategy['channels'][number]) => channel !== 'google_ads' || structured.some(goal => goal.strategy!.channels.includes(channel))
  const goalFor = (channel: BusinessGoalStrategy['channels'][number] | 'payments' | 'availability') => structured.find(goal =>
    channel === 'payments' || channel === 'availability' ? goal.strategy![channel] === true : goal.strategy!.channels.includes(channel)) ?? null
  const [documents, products, canWrite, canPublish, canOperate] = await Promise.all([
    queryAll<RecommendationDocument>(db, `SELECT id,kind,title,slug,status,location_id,updated_at,published_at FROM content_documents
      WHERE organization_id=? AND row_role='root' AND (kind='social_post' OR (kind='article' AND metadata_json->>'$.collection'='blog'))
        ${input.locationId ? 'AND location_id=?' : ''} ORDER BY created_at,id`, [organizationId, ...(input.locationId ? [input.locationId] : [])]),
    queryAll<RecommendationProduct>(db, `SELECT p.id,p.name,p.slug,p.kind,c.online_payment_required FROM products p
      LEFT JOIN product_booking_configs c ON c.organization_id=p.organization_id AND c.product_id=p.id
      WHERE p.organization_id=? AND p.active=1 ${input.locationId ? 'AND EXISTS(SELECT 1 FROM product_locations l WHERE l.organization_id=p.organization_id AND l.product_id=p.id AND l.location_id=?)' : ''}
      ORDER BY p.created_at,p.id`, [organizationId, ...(input.locationId ? [input.locationId] : [])]),
    roleAllows({ ...principal, permissions: { content: ['update'] } }), roleAllows({ ...principal, permissions: { content: ['publish'] } }),
    roleAllows({ ...principal, permissions: { operations: ['update'] } }),
  ])
  const marketing = await marketingPages(db, principal, organization, now, enabled('google_ads') || Boolean(await readIntegration(db, organizationId, 'google_ads')))
  const issues = marketing.issues
  const base = `/dashboard/${encodeURIComponent(organization.slug)}`
  const context = marketing.nativeSessions === null ? marketing.nativeUnavailable ? 'Website traffic measurement is currently unavailable.' : 'Website traffic measurement has not started.'
    : `${marketing.nativeSessions} recorded website sessions in the current 28-day window; this does not include off-platform customers.`
  const articles = documents.filter(document => document.kind === 'article'), drafts = articles.filter(document => document.status === 'draft')
  const posts = documents.filter(document => document.kind === 'social_post')
  type Candidate = Omit<BusinessRecommendation, 'reference'> & { rank: number; recency: string }
  const candidates: Candidate[] = []
  const offer = (operation: BusinessProgressOperation, subjectId: string, headline: string, reason: string, to: string, rank: number,
    options: Partial<Pick<Candidate, 'locationId' | 'productId' | 'goal' | 'icon' | 'recency'>> = {}) => {
    candidates.push({ operation, subjectId, headline, reason, to, rank, icon: 'i-lucide-sprout', locationId: input.locationId ?? null,
      productId: null, goal: null, recency: '', ...options })
  }
  const pageEvidence = (slug: string | null) => slug ? marketing.pages.filter(page => page.path.split('/').filter(Boolean).at(-1) === slug) : []
  const sourceOrder = enabled('google_ads') ? ['Google Ads clicks', 'recorded website sessions', 'organic Google clicks'] : ['recorded website sessions', 'organic Google clicks', 'Google Ads clicks']
  const compareInterest = (left: string | null, right: string | null) => {
    for (const source of sourceOrder) {
      const a = pageEvidence(left).find(page => page.source === source)?.count ?? 0
      const b = pageEvidence(right).find(page => page.source === source)?.count ?? 0
      if (a !== b) return b - a
    }
    return 0
  }
  const published = articles.filter(document => document.status === 'published').sort((a, b) => compareInterest(a.slug, b.slug) || (b.published_at ?? '').localeCompare(a.published_at ?? ''))
  const leading = [...products].filter(product => !published.some(article => article.title?.toLocaleLowerCase().includes(product.name.toLocaleLowerCase())))
    .sort((a, b) => compareInterest(a.slug, b.slug))[0]
  const topic = leading ? `“${leading.name}”` : organization.vertical === 'service' ? 'a question prospective clients ask'
    : organization.vertical === 'lodging' ? 'a useful local stay or travel topic' : organization.vertical === 'experience' ? 'what guests can expect from a class' : 'your food, drinks or next event'
  if (canWrite && enabled('blog')) {
    for (const draft of drafts) offer('article.publish', draft.id, draft.title ? `Finish “${draft.title}”` : 'Finish your blog draft',
      `An existing blog draft can become the next useful article.${organization.vertical === 'service' ? ' Complete legal review before publishing.' : ''} ${context}`,
      blogEditorPath(organization.slug, draft.id), 70, { goal: goalFor('blog') ?? goalFor('google_ads'), locationId: draft.location_id, recency: draft.updated_at, icon: 'i-lucide-file-pen-line' })
    if (!drafts.length) offer('article.create', organizationId, `Start a blog about ${topic}`,
      `Build useful content for ${organization.name}.${leading && pageEvidence(leading.slug).length ? ` This offering already has recorded website interest.` : ' This is a new content opportunity, not a measured winning topic.'} ${context}`,
      blogCreatePath(organization.slug), 40, { goal: goalFor('blog') ?? goalFor('google_ads'), productId: leading?.id ?? null, icon: 'i-lucide-file-plus' })
  }
  const adsGoal = goalFor('google_ads')
  if (adsGoal && canOperate && !await readIntegration(db, organizationId, 'google_ads')) offer('google_ads.connect', organizationId,
    'Connect Google Ads to your marketing goal', 'Connect the existing Google Ads integration to measure which articles your ads bring customers to.',
    `${base}/integrations`, 100, { goal: adsGoal, icon: 'i-logos-google-ads' })
  let canPreparePost = false
  if (canWrite && enabled('social')) {
    let connections: Awaited<ReturnType<typeof getSocialConnections>> | null = null
    try {
      connections = await getSocialConnections(principal.env, organizationId, { dashboardBase: base })
    } catch (error) {
      issues.push(`Social connection status could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    const connectedChannel = (['instagram', 'facebook', 'discord'] as const).find(channel => connections?.channels.some(connection => connection.channel === channel && connection.connected && connection.problems.length === 0)) ?? null
    const entitled = await hasOrganizationEntitlement(principal.env, organizationId, 'managed_service')
    const receipts = await queryAll<{ post_id: string; state: string; attempt_id: string | null; updated_at: string }>(db,
      'SELECT post_id,state,attempt_id,updated_at FROM post_publications WHERE organization_id=?', [organizationId])
    const draftPosts = posts.filter(post => (post.status === 'draft' || connectedChannel && entitled)
      && !receipts.some(receipt => receipt.post_id === post.id && !isPublicationPreparationResumable(receipt, now.getTime())))
    for (const post of draftPosts) offer('post.publish', post.id, post.title ? `Finish sharing “${post.title}”` : 'Finish your photo or social post',
      `${post.status === 'published' ? 'The website post is published; no completed social publication is recorded.' : 'Continue the post already in progress.'}${!connectedChannel ? ' Connect a social account to publish it there.' : ''}`,
      postEditorPath(organization.slug, post.id), 80, { goal: goalFor('social'), locationId: post.location_id, recency: post.updated_at, icon: 'i-lucide-image-plus' })
    if (connections && (!connectedChannel || !entitled)) offer('social.connect', organizationId, !entitled ? 'Enable social publishing' : connections.channels.some(channel => channel.connected) ? 'Reconnect your social account' : 'Connect your social account',
      !entitled ? 'Your social marketing strategy can use connected publishing when its plan requirement is met. You can prepare content now.' : 'Connect the account where customers follow you, so posts can be published and their outcomes tracked here.',
      !entitled ? `${base}/billing` : `${base}/integrations`, 55, { goal: goalFor('social'), icon: 'i-lucide-link' })
    if (connectedChannel && entitled && canPublish) {
      for (const article of published.slice(0, 10)) {
        const distribution = await readArticleDistribution(db, principal, article.id)
        if (!distribution.url) {
          issues.push(`“${article.title ?? 'Your article'}” has no public website URL. Set up its website domain before sharing it.`)
          continue
        }
        if (distribution.posts.some(post => post.publications.some(receipt => receipt.state === 'published'
          || receipt.state === 'removed' && receipt.updatedAt >= article.updated_at))) continue
        if (distribution.posts.length) continue
        const evidence = pageEvidence(article.slug)
        offer('article.distribute', article.id, `Share “${article.title ?? 'your article'}”`,
          `Turn the published article into a social post with a link back to it.${evidence.length ? ` It has ${evidence.map(page => `${page.count} ${page.source}`).join(', ')} in the measured window; these are separate audiences.` : ' Its publication is recorded; customer results are not yet established.'}`,
          articleSocialPostPath(organization.slug, article.id, connectedChannel, article.location_id), 90,
          { goal: goalFor('social'), locationId: article.location_id, recency: article.published_at ?? article.updated_at, icon: 'i-lucide-share-2' })
      }
    }
    const unusedPhoto = await queryFirst<{ id: string }>(db, `SELECT a.id FROM media_assets a WHERE a.organization_id=? AND a.kind='image' AND a.status='active' AND a.source<>'generated'
      AND NOT EXISTS(SELECT 1 FROM media_placements branding WHERE branding.asset_id=a.id AND branding.organization_id=a.organization_id AND branding.slot IN ('logo','favicon','social_card'))
      AND NOT EXISTS(SELECT 1 FROM media_placements m JOIN content_documents d ON d.id=m.owner_id AND d.organization_id=m.organization_id
        WHERE m.asset_id=a.id AND m.organization_id=a.organization_id AND d.kind='social_post') ORDER BY a.created_at DESC,a.id LIMIT 1`, [organizationId])
    canPreparePost = !draftPosts.length && Boolean(unusedPhoto || !posts.length)
    if (canPreparePost) offer('post.create', organizationId,
      unusedPhoto ? 'Turn a business photo into a social post' : `Prepare a photo post about ${topic}`,
      `${unusedPhoto ? 'A saved image has not been used in a recorded social post. Choose a suitable photo and caption.' : 'Capture a current photo and give customers a useful reason to visit or book.'} ${context}`,
      postEditorPath(organization.slug, 'new', input.locationId), 60, { goal: goalFor('social'), productId: leading?.id ?? null, icon: 'i-lucide-camera' })
    else if (!draftPosts.length) offer('post.create', organizationId, 'Capture a new business photo for your next post',
      'The previous post is recorded. Capture a fresh photo of your business before preparing another post.',
      postEditorPath(organization.slug, 'new', input.locationId), 30, { goal: goalFor('social'), icon: 'i-lucide-camera' })
  }
  const paymentGoal = goalFor('payments')
  if (canOperate && (paymentGoal || organization.vertical === 'experience' && await hasOrganizationEntitlement(principal.env, organizationId, 'payments'))) {
    const unpaid: RecommendationProduct[] = []
    for (const product of products.filter(product => product.online_payment_required === 0)) {
      const offering = await getProduct(db, organizationId, product.id)
      const locations = input.locationId ? [input.locationId] : [null, ...offering.locations.map(location => location.location_id)]
      if (offering.variants.some(variant => variant.active && locations.some(locationId => {
        const price = resolveVariantPrice(variant, { currency: organization.default_currency, location_id: locationId, at: now.toISOString(), billing: { type: 'one_time' } })
        return price !== null && price.unit_amount > 0
      }))) unpaid.push(product)
    }
    if (unpaid.length) {
      const setup = await readStripeCheckoutSetup(db, organizationId, principal.env)
      if (setup.missing.includes('payments.configuration')) issues.push('Payment setup is unavailable because the payment configuration is incomplete.')
      const waiting = setup.connected?.status === 'pending_review'
      if (setup.missing.length && !waiting) offer('payments.connect', organizationId, setup.connected ? 'Finish your payment setup' : organization.vertical === 'service' ? 'Set up payments for your consultations' : 'Set up payments for your experiences',
        'Complete the existing Stripe setup before requiring payment at booking. A subscription alone does not activate payment acceptance.',
        `${base}/payments/payout-method`, 100, { goal: paymentGoal, icon: 'i-lucide-credit-card' })
      if (!setup.missing.length) for (const product of unpaid) offer('product.payment', product.id, `Take payment when ${organization.vertical === 'service' ? 'clients' : 'guests'} book “${product.name}”`,
        `Payments are ready, but this offering does not require advance payment. Enable it for a priced offering to collect before ${organization.vertical === 'service' ? 'confirming a consultation' : 'reserving places'}.`,
        `${productEditorPath(organization.slug, product.id)}/booking/payment`, 100, { productId: product.id, goal: paymentGoal, icon: 'i-lucide-credit-card' })
    }
  }
  if (canOperate && organization.vertical === 'lodging') {
    const today = localDateAt(now, organization.timezone)
    const gaps = await readStayGapCandidates(db, await stayAccessFor(principal), { from: addLocalDays(today, -1), to: addLocalDays(today, 31) })
    for (const gap of gaps.filter(gap => !input.locationId || gap.locationId === input.locationId)) offer('stay.gap', JSON.stringify([gap.productId, gap.from, gap.to]),
      gap.bookable ? `Fill the ${gap.nights}-night gap at ${gap.name}` : `Review the ${gap.nights}-night gap at ${gap.name}`,
      `${gap.from} to ${gap.to}.${gap.bookable ? ' The saved rules allow this length; promote it if it fits your business.' : ` ${gap.restriction}`}`,
      `${base}/calendar?${new URLSearchParams({ product_id: gap.productId, date: gap.from, month: gap.from.slice(0, 7) })}`, 95,
      { goal: goalFor('availability'), locationId: gap.locationId, productId: gap.productId, recency: gap.from, icon: 'i-lucide-calendar-range' })
  } else if (canOperate && (organization.vertical === 'experience' || organization.vertical === 'service')) {
    const sessions = await listSessions(db, { organizationId, locationId: input.locationId, fromInstant: now.toISOString(), toInstant: new Date(now.getTime() + 7 * 86_400_000).toISOString() })
    const open = sessions.find(session => session.remaining !== null && session.remaining > 0 && !session.is_full)
    const product = open && products.find(product => product.id === open.product_id)
    if (open && product && canWrite && enabled('social') && canPreparePost) offer('post.create', JSON.stringify(['session', product.id, open.id]),
      `Promote the next ${organization.vertical === 'service' ? 'consultation availability' : `“${product.name}” session`}`,
      `${formatTimestamp(open.starts_at, 'en', open.timezone, { dateStyle: 'medium', timeStyle: 'short' })}: ${open.remaining} recorded ${organization.vertical === 'service' ? 'consultation openings remain' : 'places remain in this session'}. External bookings are not established by this count.`,
      postEditorPath(organization.slug, 'new', input.locationId), 85, { productId: product.id, goal: goalFor('social'), locationId: open.location_id, recency: open.starts_at, icon: 'i-lucide-ticket' })
  } else if (canOperate && organization.vertical === 'restaurant') {
    const locations = await queryAll<{ id: string; timezone: string }>(db, `SELECT l.id,l.timezone FROM business_locations l JOIN location_reservation_configs c
      ON c.organization_id=l.organization_id AND c.location_id=l.id WHERE l.organization_id=? AND l.status='active' ${input.locationId ? 'AND l.id=?' : ''}`, [organizationId, ...(input.locationId ? [input.locationId] : [])])
    for (const location of locations) {
      const available = await listReservationSlots(db, { organizationId, locationId: location.id, date: localDateAt(now, location.timezone) })
      const slot = available.slots.find(slot => slot.starts_at > now.toISOString() && !slot.is_closed && !slot.is_full && slot.remaining !== null && slot.remaining > 0)
      if (slot && canWrite && enabled('social') && canPreparePost) offer('post.create', JSON.stringify(['reservation', location.id, slot.starts_at]), 'Give customers a reason to book a table',
        `A recorded reservation slot still has capacity at ${formatTimestamp(slot.starts_at, 'en', location.timezone, { hour: 'numeric', minute: '2-digit' })}. Feature a current dish, special or event with the reservation link. Walk-ins and physical table occupancy are not measured by this slot.`,
        postEditorPath(organization.slug, 'new', location.id), 85, { goal: goalFor('social'), locationId: location.id, icon: 'i-lucide-camera' })
    }
  }
  const unique = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const key = candidate.operation === 'post.create' ? 'post.create' : candidate.operation === 'stay.gap' ? `stay.gap:${candidate.productId}` : `${candidate.operation}:${candidate.subjectId}`, previous = unique.get(key)
    if (!previous || candidate.rank > previous.rank) unique.set(key, candidate)
  }
  const ranked = [...unique.values()].sort((a, b) => Number(Boolean(b.goal)) - Number(Boolean(a.goal)) || b.rank - a.rank || b.recency.localeCompare(a.recency) || a.subjectId.localeCompare(b.subjectId))
  // The evidence revision of each candidate is what an opportunity is recorded against.
  const references = await Promise.all(ranked.map(candidate => referenceOrNull(db, principal, candidate)))
  const recommendations: BusinessRecommendation[] = ranked.flatMap((candidate, index) => {
    const reference = references[index]
    if (!reference) return []
    return [{ operation: candidate.operation, subjectId: candidate.subjectId, headline: candidate.headline, to: candidate.to, icon: candidate.icon,
      reason: [candidate.reason, candidate.goal ? `Your strategy: ${candidate.goal.intent}` : null].filter(Boolean).join(' '), locationId: candidate.locationId, productId: candidate.productId,
      goal: candidate.goal, reference }]
  })
  return { recommendations, goals, issues }
}
