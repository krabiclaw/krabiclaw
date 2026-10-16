import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { renderNotificationEmail } from '~/server/emails/render'
import { articleAnnouncementMessage } from '~/server/notifications/guest-events'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import { getPlatformDomain } from '~/server/utils/dashboard-notification-links'
import { emailSender, logOnlyEmailProviderId, shouldSendRealEmail } from '~/server/utils/email-delivery'
import { getResendClient, resendData } from '~/server/utils/resend'
import { reconcileProductNewsContacts, type ProductNewsEnv, type ProductNewsReconciliation } from '~/server/domain/product-news-contacts'
import { collectionArticlePath } from '~/utils/article-collections'
import { coverJoinSql } from '~/server/utils/content/cover'
import { renderContentBlocksToMarkdown, type ContentBlockRow } from '~/server/utils/content/documents'
import { stripLeadingTitleHeading } from '~/utils/markdown'

export interface BroadcastEnv extends ProductNewsEnv {
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
  EMAIL_FROM?: string
}

/**
 * How recently an article must have first gone public to be worth announcing.
 *
 * The task derives its own work from `first_published_at` rather than being
 * called from the publish endpoint, so a repeated publish, which changes
 * nothing, cannot announce twice. The window is what stops the whole existing
 * back catalogue mailing out the first time this ships.
 */
const ANNOUNCEABLE_WINDOW_MS = 24 * 60 * 60 * 1000

const BROADCAST_CATEGORY = 'product_news' as const

/**
 * Resend caps a Broadcast's `name` at 70 characters and refuses the draft
 * past that, which is how the first real announcement never left D1: its
 * title alone was 67. The name is the label in Resend's dashboard, nothing a
 * reader sees, so it is cut; the subject carries the whole title.
 */
const RESEND_BROADCAST_NAME_MAX = 70

export function broadcastName(title: string): string {
  return `Article: ${title}`.slice(0, RESEND_BROADCAST_NAME_MAX)
}

export interface AnnounceableArticle {
  id: string
  title: string
  slug: string
  summary: string | null
  category: string | null
  cover_public_url: string | null
}

/**
 * The next platform article that has gone public and has no broadcast yet.
 *
 * Only the `blog` collection: `docs` is reference material that is edited
 * continuously, and announcing every documentation edit is not what a reader
 * signed up for.
 */
export async function findAnnounceableArticle(db: DbClient, now = new Date()): Promise<AnnounceableArticle | null> {
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  const since = new Date(now.getTime() - ANNOUNCEABLE_WINDOW_MS).toISOString()
  // The leading image is joined through the shared helper rather than a second
  // hand-written join: the cover lives on a media_placement, and writing that
  // out again here is how this query first asked for a column that does not exist.
  return queryFirst<AnnounceableArticle>(db, `
    SELECT p.id, p.title, p.slug, p.summary, (p.metadata_json ->> '$.category') AS category,
           cover_asset.public_url AS cover_public_url
      FROM content_documents p
      ${coverJoinSql('p')}
     WHERE p.kind = 'article' AND p.row_role = 'root' AND p.organization_id = ?
       AND p.status = 'published' AND p.visibility = 'listed'
       AND (p.metadata_json ->> '$.collection') = 'blog'
       AND p.first_published_at IS NOT NULL AND p.first_published_at >= ?
       AND NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.content_document_id = p.id)
     ORDER BY p.first_published_at ASC
     LIMIT 1
  `, [platformOrganizationId, since])
}

interface BroadcastRow {
  id: string
  content_document_id: string
  provider_broadcast_id: string | null
}

/**
 * Claims the broadcast for an article. The unique content_document_id is what
 * makes a republish, or two ticks overlapping, not announce it twice: the
 * second insert changes nothing and the existing row is returned.
 */
export async function claimBroadcast(db: DbClient, contentDocumentId: string): Promise<BroadcastRow> {
  await execute(
    db,
    `INSERT INTO broadcasts (id, content_document_id, category, created_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (content_document_id) DO NOTHING`,
    [crypto.randomUUID(), contentDocumentId, BROADCAST_CATEGORY],
  )
  const row = await queryFirst<BroadcastRow>(db, 'SELECT id, content_document_id, provider_broadcast_id FROM broadcasts WHERE content_document_id = ?', [contentDocumentId])
  if (!row) throw new Error(`Broadcast for ${contentDocumentId} was not claimed`)
  return row
}

/** The article a claimed broadcast refers to. */
export async function loadBroadcastArticle(db: DbClient, contentDocumentId: string): Promise<AnnounceableArticle | null> {
  return queryFirst<AnnounceableArticle>(db, `
    SELECT p.id, p.title, p.slug, p.summary, (p.metadata_json ->> '$.category') AS category,
           cover_asset.public_url AS cover_public_url
      FROM content_documents p
      ${coverJoinSql('p')}
     WHERE p.id = ?
  `, [contentDocumentId])
}

/**
 * The article's text, as the email reads it. Headings, prose and dividers are
 * the parts mail can carry; the leading image is already the email's hero, and
 * interactive blocks (FAQ, CTA, video) belong to the page the button opens.
 */
async function loadBroadcastBody(db: DbClient, article: AnnounceableArticle, siteOrigin: string): Promise<string> {
  const blocks = await queryAll<Pick<ContentBlockRow, 'id' | 'type' | 'position' | 'level' | 'data_json'>>(db, `
    SELECT id, type, position, level, data_json
      FROM content_blocks
     WHERE document_id = ? AND parent_block_id IS NULL AND type IN ('heading', 'markdown', 'divider')
     ORDER BY position
  `, [article.id])
  // A site-relative link resolves against the page on the web and against nothing in a mail client.
  const body = stripLeadingTitleHeading(renderContentBlocksToMarkdown(blocks), article.title)
    .replace(/\]\(\/(?!\/)/g, `](${siteOrigin}/`)
    .trim()
  if (!body) throw new Error(`Article ${article.id} has no text to announce`)
  return body
}

/**
 * Claimed broadcasts inside the announceable window, oldest first. Whether one
 * still needs sending is Resend's state, not a local column: a row with no
 * provider id has no draft yet, and a row with one is sent exactly when
 * Resend says its Broadcast is no longer a draft. Past the window an unsent
 * broadcast is not retried, for the same reason an article that old is not
 * announced at all.
 */
async function listRecentBroadcasts(db: DbClient, now: Date): Promise<BroadcastRow[]> {
  const since = new Date(now.getTime() - ANNOUNCEABLE_WINDOW_MS).toISOString()
  return queryAll<BroadcastRow>(db, `
    SELECT id, content_document_id, provider_broadcast_id
      FROM broadcasts
     WHERE category = ? AND created_at >= ?
     ORDER BY created_at ASC
  `, [BROADCAST_CATEGORY, since])
}

function isLogOnlyBroadcastId(providerBroadcastId: string): boolean {
  return providerBroadcastId.startsWith('log-only:')
}

async function needsSend(env: BroadcastEnv, row: BroadcastRow): Promise<boolean> {
  if (!row.provider_broadcast_id) return true
  // An environment that does not deliver email never sends a provider
  // Broadcast, including one whose row was copied from production.
  if (!shouldSendRealEmail(env)) return false
  if (isLogOnlyBroadcastId(row.provider_broadcast_id)) return false
  const providerBroadcastId = row.provider_broadcast_id
  const broadcast = await resendData('broadcasts.get', () => getResendClient(env).broadcasts.get(providerBroadcastId))
  return broadcast.status === 'draft'
}

export interface BroadcastRunResult {
  broadcast_id: string | null
  article_id: string | null
  provider_broadcast_id: string | null
  mode: 'provider' | 'log_only' | null
  reconciliation: ProductNewsReconciliation['counts'] | null
  skipped?: string
}

/**
 * Persists the Resend draft's id on the claimed row, once. Two ticks that
 * both created a draft agree on whichever id landed first; the other draft is
 * an unsent orphan and is removed.
 */
async function persistProviderBroadcastId(db: DbClient, env: BroadcastEnv, row: BroadcastRow, providerBroadcastId: string): Promise<string> {
  const written = await execute(db, 'UPDATE broadcasts SET provider_broadcast_id = ? WHERE id = ? AND provider_broadcast_id IS NULL', [providerBroadcastId, row.id])
  if (written.meta.changes > 0) return providerBroadcastId
  const stored = await queryFirst<{ provider_broadcast_id: string | null }>(db, 'SELECT provider_broadcast_id FROM broadcasts WHERE id = ?', [row.id])
  if (!stored?.provider_broadcast_id) throw new Error(`Broadcast ${row.id} has no provider id after a concurrent claim`)
  if (!isLogOnlyBroadcastId(providerBroadcastId)) {
    await resendData('broadcasts.remove', () => getResendClient(env).broadcasts.remove(providerBroadcastId))
  }
  return stored.provider_broadcast_id
}

/**
 * One tick: announce one article through a native Resend Broadcast.
 *
 * The sequence is claim, reconcile the Product News Segment, render once,
 * create a draft, persist its id, then send that exact Broadcast. The id is
 * stored before the irreversible send, so a retry after an ambiguous failure
 * addresses the same Broadcast and can never send a second campaign; at worst
 * an ambiguous draft creation leaves an unsent orphan draft in Resend.
 * Recipient expansion, queueing, throttling, delivery, suppressions and
 * metrics are Resend's.
 */
async function findPendingBroadcast(db: DbClient, env: BroadcastEnv, now: Date): Promise<BroadcastRow | null> {
  for (const row of await listRecentBroadcasts(db, now)) {
    if (await needsSend(env, row)) return row
  }
  const article = await findAnnounceableArticle(db, now)
  return article ? claimBroadcast(db, article.id) : null
}

export async function runArticleBroadcast(db: DbClient, env: BroadcastEnv, now = new Date()): Promise<BroadcastRunResult> {
  const pending = await findPendingBroadcast(db, env, now)
  if (!pending) {
    return { broadcast_id: null, article_id: null, provider_broadcast_id: null, mode: null, reconciliation: null, skipped: 'no article to announce' }
  }

  const article = await loadBroadcastArticle(db, pending.content_document_id)
  if (!article) throw new Error(`Broadcast ${pending.id} refers to an article that is gone`)

  // The Segment is made to match D1 before anything is sent to it, so an
  // account banned, deleted or unverified since the last run is not mailed.
  const reconciliation = await reconcileProductNewsContacts(db, env)
  if (reconciliation.failures.length > 0) {
    throw new Error(`Product News reconciliation failed for ${reconciliation.failures.length} target(s); broadcast ${pending.id} not sent: ${reconciliation.failures.map(failure => `${failure.target}: ${failure.error}`).join('; ')}`)
  }

  const result = (providerBroadcastId: string): BroadcastRunResult => ({
    broadcast_id: pending.id,
    article_id: article.id,
    provider_broadcast_id: providerBroadcastId,
    mode: reconciliation.mode,
    reconciliation: reconciliation.counts,
  })

  let providerBroadcastId = pending.provider_broadcast_id
  if (!providerBroadcastId) {
    if (!shouldSendRealEmail(env)) {
      // Where email is not delivered the claim is still recorded, so the
      // article is announced once, and nothing reaches the shared Resend account.
      return result(await persistProviderBroadcastId(db, env, pending, logOnlyEmailProviderId('broadcast')))
    }
    const segmentId = env.RESEND_PRODUCT_NEWS_SEGMENT_ID?.trim()
    const topicId = env.RESEND_PRODUCT_NEWS_TOPIC_ID?.trim()
    if (!segmentId || !topicId) throw new Error('RESEND_PRODUCT_NEWS_SEGMENT_ID and RESEND_PRODUCT_NEWS_TOPIC_ID are required to send a broadcast')

    const platformDomain = getPlatformDomain(env)
    // Resend substitutes its Topic-aware unsubscribe page for this placeholder
    // per recipient; KrabiClaw's signed unsubscribe is for mail it sends itself.
    const rendered = await renderNotificationEmail(articleAnnouncementMessage({
      title: article.title,
      summary: article.summary,
      bodyMarkdown: await loadBroadcastBody(db, article, `https://${platformDomain}`),
      coverImageUrl: article.cover_public_url,
      articleUrl: `https://${platformDomain}${collectionArticlePath('blog', article.slug)}`,
    }), {
      platformDomain,
      preferencesUrl: `https://${platformDomain}/dashboard/account/profile/notifications`,
      unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}',
    })
    const draft = await resendData('broadcasts.create', () => getResendClient(env).broadcasts.create({
      name: broadcastName(article.title),
      segmentId,
      topicId,
      from: emailSender(env),
      subject: article.title,
      ...(article.summary ? { previewText: article.summary } : {}),
      html: rendered.html,
      text: rendered.text,
    }))
    providerBroadcastId = await persistProviderBroadcastId(db, env, pending, draft.id)
  }

  if (isLogOnlyBroadcastId(providerBroadcastId)) return result(providerBroadcastId)
  const sendId = providerBroadcastId
  await resendData('broadcasts.send', () => getResendClient(env).broadcasts.send(sendId))
  return result(sendId)
}
