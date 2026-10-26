import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { getGuestRequest, getThreadOperationalRecord } from '~/server/domain/requests'
import { listOrganizationGuestThreads } from '~/server/domain/guest-threads/repository'
import { resolveGuestThreadMailbox } from '~/server/domain/guest-threads/mailbox'
import { guestThreadReplyRecipient } from '~/server/domain/guest-threads/operations'
import { isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'
import { blogPublicationReadiness, getBlogPost, listBlogPosts } from '~/server/utils/content/publishing'
import { assertOrganizationWideAccess, assertRoleAllows, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { readBusinessProgressReference } from '~/server/utils/business-outcomes'
import type { BusinessProgressOperation, BusinessProgressReference } from '~/shared/business-outcomes'
import { assertCalendarDate, localDateAt } from '~/utils/timezone'

const ARTICLE_SCAN_LIMIT = 12
const THREAD_SCAN_LIMIT = 24
// A conservative discovery bound for this preview, not owner-validated reply policy.
export const RECOMMENDATION_INBOUND_FRESHNESS_DAYS = 14

export interface RecommendationCandidate {
  id: string
  operation: BusinessProgressOperation
  reference: BusinessProgressReference
  label: string
  facts: Record<string, unknown>
  eligibility: { available: boolean; reasons: string[] }
}

interface ContextEntry { id: string; kind: string; body: string | null; occurred_at: string; sequence: number; channel: string | null }

function text(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Recommendation source text has an invalid type')
  return value.slice(0, limit)
}

function candidate(operation: BusinessProgressOperation, reference: BusinessProgressReference, label: string, facts: Record<string, unknown>, reasons: string[]): RecommendationCandidate {
  return { id: `${operation}:${reference.subjectId}`, operation, reference, label, facts, eligibility: { available: reasons.length === 0, reasons } }
}

/** Read authorized facts and explicit technical eligibility; goals never become keyword rules here. */
export async function loadRecommendationCandidates(db: DbClient, principal: MemberAccessPrincipal, now: Date) {
  await assertOrganizationWideAccess(db, principal)
  await assertRoleAllows({ ...principal, permissions: { organization: ['update'], content: ['read'], operations: ['read'] } })
  if (!Number.isFinite(now.getTime())) throw new HTTPError({ statusCode: 400, message: 'Recommendation evaluation time is invalid' })
  const organization = await queryFirst<{ id: string; name: string; timezone: string }>(db, 'SELECT id, name, timezone FROM organization WHERE id = ?', [principal.organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  if (!organization.name.trim() || !organization.timezone.trim()) throw new Error('Recommendation organization has no name or timezone')
  const [articles, threads, canUpdateArticle, canPublishArticle, canReply] = await Promise.all([
    listBlogPosts(db, principal.organizationId, null, principal.env, { limit: ARTICLE_SCAN_LIMIT, offset: 0 }, { resource: 'recommendation-preview-articles' }),
    listOrganizationGuestThreads(db, { organizationId: principal.organizationId, principal, userId: principal.userId, limit: THREAD_SCAN_LIMIT + 1, offset: 0 }),
    roleAllows({ ...principal, permissions: { content: ['update'] } }),
    roleAllows({ ...principal, permissions: { content: ['publish'] } }),
    roleAllows({ ...principal, permissions: { operations: ['reply'] } }),
  ])
  const articleCandidates = await Promise.all(articles.posts.map(async (summary) => {
    if (typeof summary.id !== 'string' || !summary.id) throw new Error('Recommendation article has no canonical ID')
    const initialReference = await readBusinessProgressReference(db, principal, { operation: 'article.update', subjectId: summary.id })
    const post = await getBlogPost(db, summary.id, principal.organizationId, principal.env)
    const status = text(post.status, 30), categoryId = post.category?.id ?? null
    if (status === null) throw new Error('Recommendation article has no publication status')
    const facts = {
      kind: 'article', title: text(post.title, 200), excerpt: text(post.excerpt, 500), content: text(post.body, 1600),
      categoryId, category: post.category, status, updatedAt: post.updated_at, effortMinutes: null,
    }
    const publishReference = await readBusinessProgressReference(db, principal, { operation: 'article.publish', subjectId: summary.id })
    const updateReference = await readBusinessProgressReference(db, principal, { operation: 'article.update', subjectId: summary.id })
    if (initialReference.evidenceRevision !== updateReference.evidenceRevision) throw new HTTPError({ statusCode: 409, message: 'An article changed while recommendation context was being read' })
    const publication = blogPublicationReadiness({ status, categoryId })
    return [
      candidate('article.update', updateReference, 'Review and update this article', facts, canUpdateArticle ? [] : ['permission_denied']),
      candidate('article.publish', publishReference, 'Review this article for publication', facts, [...publication.reasons, ...(canPublishArticle ? [] : ['permission_denied'])]),
    ]
  }))
  const threadCandidates = await Promise.all(threads.slice(0, THREAD_SCAN_LIMIT).map(async (summary) => {
    const initialReference = await readBusinessProgressReference(db, principal, { operation: 'guest_thread.reply', subjectId: summary.id })
    const thread = await getGuestRequest(db, summary.id, principal.organizationId)
    if (!thread) throw new HTTPError({ statusCode: 409, message: 'A recommendation conversation changed during the read' })
    const [record, latestGuest, latestMember] = await Promise.all([
      getThreadOperationalRecord(db, thread.id),
      queryFirst<ContextEntry>(db, `SELECT id, kind, body, occurred_at, sequence, channel FROM activity_entries
        WHERE request_id = ? AND actor_kind = 'guest' AND kind IN ('submission', 'message') ORDER BY sequence DESC LIMIT 1`, [thread.id]),
      queryFirst<ContextEntry>(db, `SELECT id, kind, body, occurred_at, sequence, channel FROM activity_entries
        WHERE request_id = ? AND actor_kind = 'member' AND kind = 'message' ORDER BY sequence DESC LIMIT 1`, [thread.id]),
    ])
    const mailbox = resolveGuestThreadMailbox(thread, record, now.toISOString())
    if (record?.kind === 'stay') {
      assertCalendarDate(record.check_in_date)
      assertCalendarDate(record.check_out_date)
      if (record.check_out_date <= record.check_in_date) throw new Error('Stay commitment has invalid arrival and departure dates')
    }
    // Stay mailbox ends include a grace period; commitment relevance uses the actual local departure date.
    const activeCommitment = record !== null && record.status !== 'cancelled' && (record.kind === 'stay'
      ? record.check_out_date! >= localDateAt(now, record.timezone)
      : record.ends_at >= now.toISOString())
    const reasons: string[] = canReply ? [] : ['permission_denied']
    if (thread.archived_at !== null) reasons.push('conversation_archived')
    if (thread.blocked_at !== null) reasons.push('conversation_blocked')
    if (thread.conversation_state === 'resolved') reasons.push('conversation_resolved')
    const guestInstant = latestGuest == null ? null : Date.parse(latestGuest.occurred_at)
    if (guestInstant !== null && !Number.isFinite(guestInstant)) throw new Error('Guest activity has an invalid occurrence time')
    if (guestInstant === null) reasons.push('no_guest_activity')
    else if (guestInstant > now.getTime()) reasons.push('activity_after_evaluation_time')
    else if (now.getTime() - guestInstant > RECOMMENDATION_INBOUND_FRESHNESS_DAYS * 86_400_000 && !activeCommitment) reasons.push('stale_uncommitted_inbound')
    let replyDelivery: string = 'not_attempted'
    const laterMember = latestMember != null && (latestGuest == null || latestMember.sequence > latestGuest.sequence)
    if (laterMember) {
      const receipts = await queryAll<GuestThreadDeliveryRow>(db, "SELECT * FROM guest_thread_deliveries WHERE entry_id = ? AND purpose = 'member_reply' ORDER BY id", [latestMember.id])
      const accepted = receipts.some(receipt => receipt.provider !== 'log_only' && isDeliverySent(receipt))
      replyDelivery = latestMember.channel === 'web' ? 'stored_web_reply' : accepted ? 'provider_accepted'
        : receipts.length > 0 && receipts.every(receipt => receipt.status === 'failed') ? 'failed' : 'unconfirmed'
      reasons.push(replyDelivery === 'failed' ? 'reply_delivery_failed' : replyDelivery === 'unconfirmed' ? 'reply_delivery_unconfirmed' : 'member_reply_already_recorded')
    } else if (thread.conversation_state === 'waiting_on_guest') reasons.push('conversation_waiting_on_guest')
    let recipientReadiness: string = 'available'
    if (summary.replyChannel === 'airbnb') {
      recipientReadiness = 'provider_preflight_required'
      reasons.push('channel_provider_preflight_required')
    } else {
      const recipient = await guestThreadReplyRecipient(db, { thread, record })
      if (typeof recipient === 'object' && recipient !== null) {
        recipientReadiness = recipient.reason
        reasons.push(recipient.reason)
      }
    }
    const entry = (value: ContextEntry | null | undefined) => value == null ? null : { id: value.id, kind: value.kind, text: text(value.body, 400), occurredAt: value.occurred_at }
    const reference = await readBusinessProgressReference(db, principal, { operation: 'guest_thread.reply', subjectId: thread.id })
    if (initialReference.evidenceRevision !== reference.evidenceRevision) throw new HTTPError({ statusCode: 409, message: 'A conversation changed while recommendation context was being read' })
    return candidate('guest_thread.reply', reference, 'Consider whether this conversation needs a reply', {
      kind: 'guest_thread', conversationState: thread.conversation_state, mailbox: mailbox.mailbox,
      latestGuest: entry(latestGuest), latestMember: entry(latestMember),
      openingMessage: thread.kind === 'contact' ? text(thread.payload.message, 400) : null,
      commitment: record, activeCommitment, replyDelivery, recipientReadiness,
      freshnessHorizonDays: RECOMMENDATION_INBOUND_FRESHNESS_DAYS, freshnessPolicyValidated: false, effortMinutes: null,
    }, reasons)
  }))
  return {
    organization, candidates: [...articleCandidates.flat(), ...threadCandidates],
    coverage: {
      articles: { scanned: articles.posts.length, hasMore: articles.page_info.has_more },
      guestThreads: { scanned: Math.min(threads.length, THREAD_SCAN_LIMIT), hasMore: threads.length > THREAD_SCAN_LIMIT },
      supportedOperations: ['article.update', 'article.publish', 'guest_thread.reply'] as BusinessProgressOperation[],
      unknowns: ['Owner priorities have not been validated by this preview.', 'Effort estimates are unknown.',
        'The 14-day uncommitted-inbound freshness horizon is an unvalidated technical discovery policy.', 'External channel provider preflight is not performed.'],
    },
  }
}
