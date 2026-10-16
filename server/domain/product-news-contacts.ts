import type { Resend, Response as ResendResponse } from 'resend'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { disableCategoryEmail, wantsCategoryEmailSql, wantsNotification } from '~/server/domain/notification-preferences'
import { isReservedTestDomain, shouldSendRealEmail } from '~/server/utils/email-delivery'
import { getResendClient, resendData, type ResendEnv } from '~/server/utils/resend'

/**
 * Product News is a Resend projection of KrabiClaw state.
 *
 * D1 holds the intent — the Better Auth user and `product_news.email` in
 * user_notification_preferences. Resend holds the email-provider side: one
 * global Contact per address, membership of the Product News Segment for every
 * eligible person, and the Product News Topic subscription carrying the
 * category preference. Nothing here stores a Resend identifier; a Contact is
 * found by the Better Auth email every time.
 *
 * An opt-out wins from either side. A person who turns Product News off here
 * unsubscribes the Topic; a person who unsubscribes through Resend turns the
 * local preference off. Only an explicit opt-in in KrabiClaw's settings turns
 * a Contact back on — background reconciliation never re-subscribes anyone.
 */

export interface ProductNewsEnv extends ResendEnv {
  EMAIL_DELIVERY_MODE?: string
  RESEND_PRODUCT_NEWS_SEGMENT_ID?: string
  RESEND_PRODUCT_NEWS_TOPIC_ID?: string
}

export type ProductNewsSyncReason = 'user_opt_in' | 'user_opt_out' | 'reconcile'

export interface ProductNewsSyncCounts {
  created: number
  resubscribed: number
  segment_added: number
  segment_removed: number
  topic_subscribed: number
  topic_unsubscribed: number
  local_opted_out: number
}

interface ProductNewsProvider {
  resend: Resend
  segmentId: string
  topicId: string
}

interface ProductNewsUser {
  id: string
  email: string
  emailVerified: number
  isAnonymous: number
  banned: number
  wants_product_news: number
}

function zeroCounts(): ProductNewsSyncCounts {
  return { created: 0, resubscribed: 0, segment_added: 0, segment_removed: 0, topic_subscribed: 0, topic_unsubscribed: 0, local_opted_out: 0 }
}

function productNewsProvider(env: ProductNewsEnv): ProductNewsProvider {
  const segmentId = env.RESEND_PRODUCT_NEWS_SEGMENT_ID?.trim()
  const topicId = env.RESEND_PRODUCT_NEWS_TOPIC_ID?.trim()
  if (!segmentId) throw new Error('RESEND_PRODUCT_NEWS_SEGMENT_ID is not configured')
  if (!topicId) throw new Error('RESEND_PRODUCT_NEWS_TOPIC_ID is not configured')
  return { resend: getResendClient(env), segmentId, topicId }
}

/**
 * Who may be in the Product News Segment: a verified, registered, unbanned
 * person at an address that can receive mail. The RFC 2606 test domains are
 * excluded for the same reason sendEmail refuses them — seeded fixture
 * addresses must never become provider Contacts.
 */
function isEligible(user: ProductNewsUser): boolean {
  return user.emailVerified === 1
    && user.isAnonymous === 0
    && user.banned === 0
    && !isReservedTestDomain(user.email)
}

function userSelectSql(where: string): { sql: string; params: unknown[] } {
  const wants = wantsCategoryEmailSql('u.id', 'product_news')
  return {
    sql: `SELECT u.id, u.email, u.emailVerified, u.isAnonymous, COALESCE(u.banned, 0) AS banned,
                 (${wants.sql}) AS wants_product_news
            FROM user u
           ${where}`,
    params: wants.params,
  }
}

/** Every item of a cursor-paginated SDK listing. */
async function collectPages<T extends { id: string }>(
  operation: string,
  page: (after: string | undefined) => Promise<ResendResponse<{ data: T[]; has_more: boolean }>>,
): Promise<T[]> {
  const items: T[] = []
  let after: string | undefined
  for (;;) {
    const result = await resendData(operation, () => page(after))
    items.push(...result.data)
    const last = result.data.at(-1)
    if (!result.has_more || !last) return items
    after = last.id
  }
}

async function contactSegmentIds(provider: ProductNewsProvider, email: string): Promise<Set<string>> {
  const segments = await collectPages<{ id: string }>(
    'contacts.segments.list',
    after => provider.resend.contacts.segments.list({ email, limit: 100, ...(after ? { after } : {}) }),
  )
  return new Set(segments.map(segment => segment.id))
}

async function contactTopicSubscription(provider: ProductNewsProvider, email: string): Promise<'opt_in' | 'opt_out' | null> {
  const topics = await collectPages<{ id: string; subscription: 'opt_in' | 'opt_out' }>(
    'contacts.topics.list',
    after => provider.resend.contacts.topics.list({ email, limit: 100, ...(after ? { after } : {}) }),
  )
  return topics.find(topic => topic.id === provider.topicId)?.subscription ?? null
}

async function syncUser(
  db: DbClient,
  provider: ProductNewsProvider,
  user: ProductNewsUser,
  reason: ProductNewsSyncReason,
  counts: ProductNewsSyncCounts,
): Promise<void> {
  const { resend, segmentId, topicId } = provider
  const email = user.email
  const contact = await resendData('contacts.get', () => resend.contacts.get({ email }), { notFound: 'null' })

  if (!isEligible(user)) {
    // Ineligible people leave the Segment. Their global Contact stays, and its
    // global subscription is not touched: eligibility is not a preference.
    if (!contact) return
    if ((await contactSegmentIds(provider, email)).has(segmentId)) {
      await resendData('contacts.segments.remove', () => resend.contacts.segments.remove({ email, segmentId }))
      counts.segment_removed += 1
    }
    return
  }

  let wants = user.wants_product_news === 1

  if (!contact) {
    const subscription = wants ? 'opt_in' : 'opt_out'
    await resendData('contacts.create', () => resend.contacts.create({
      email,
      segments: [{ id: segmentId }],
      topics: [{ id: topicId, subscription }],
    }))
    counts.created += 1
    counts.segment_added += 1
    if (wants) counts.topic_subscribed += 1
    else counts.topic_unsubscribed += 1
    return
  }

  if (contact.unsubscribed) {
    if (reason === 'user_opt_in') {
      // The one path that may lift a global unsubscribe: the person turned
      // Product News on in KrabiClaw's settings just now.
      await resendData('contacts.update', () => resend.contacts.update({ email, unsubscribed: false }))
      counts.resubscribed += 1
    } else if (wants) {
      // Globally unsubscribed in Resend means Product News cannot reach them;
      // the local preference follows rather than contradicting the provider.
      await disableCategoryEmail(db, user.id, 'product_news', { origin: 'provider' })
      counts.local_opted_out += 1
      wants = false
    }
  }

  if (!(await contactSegmentIds(provider, email)).has(segmentId)) {
    await resendData('contacts.segments.add', () => resend.contacts.segments.add({ email, segmentId }))
    counts.segment_added += 1
  }

  const current = await contactTopicSubscription(provider, email)
  if (reason === 'reconcile' && wants && current === 'opt_out') {
    // The Topic was unsubscribed in Resend (its unsubscribe page) and the
    // contact.updated webhook for it has not been applied yet. The opt-out
    // stands; reconciliation does not re-subscribe.
    await disableCategoryEmail(db, user.id, 'product_news', { origin: 'provider' })
    counts.local_opted_out += 1
    return
  }
  const desired = wants ? 'opt_in' : 'opt_out'
  if (current === desired) return
  await resendData('contacts.topics.update', () => resend.contacts.topics.update({ email, topics: [{ id: topicId, subscription: desired }] }))
  if (desired === 'opt_in') counts.topic_subscribed += 1
  else counts.topic_unsubscribed += 1
}

/**
 * Makes Resend match one person's canonical Better Auth and preference state.
 *
 * `user_opt_in` and `user_opt_out` are the person's own settings change and run
 * after the D1 write that recorded it; `reconcile` is background alignment and
 * never lifts a global unsubscribe or re-subscribes a Topic Resend holds as
 * unsubscribed. Nothing is sent to Resend where email is not delivered
 * (EMAIL_DELIVERY_MODE log_only): those environments share the one Resend
 * account and their users are not the people it mails.
 */
export async function syncProductNewsContact(
  db: DbClient,
  env: ProductNewsEnv,
  userId: string,
  reason: ProductNewsSyncReason,
): Promise<ProductNewsSyncCounts> {
  const counts = zeroCounts()
  if (!shouldSendRealEmail(env)) return counts
  const select = userSelectSql('WHERE u.id = ?')
  const user = await queryFirst<ProductNewsUser>(db, select.sql, [...select.params, userId])
  if (!user) throw new Error(`User ${userId} not found for Product News sync`)
  await syncUser(db, productNewsProvider(env), user, reason, counts)
  return counts
}

export interface ProductNewsReconciliation {
  mode: 'provider' | 'log_only'
  users: number
  counts: ProductNewsSyncCounts
  failures: { target: string; error: string }[]
}

/**
 * Reconciles every Better Auth user, then removes Segment members who are no
 * longer an eligible local user — deleted accounts and changed addresses
 * leave nothing behind in D1 to reconcile from.
 *
 * Each person is attempted even if another fails, and every failure is
 * returned: the caller decides, and a Broadcast is never sent over a Segment
 * that did not reconcile completely.
 */
export async function reconcileProductNewsContacts(db: DbClient, env: ProductNewsEnv): Promise<ProductNewsReconciliation> {
  const counts = zeroCounts()
  if (!shouldSendRealEmail(env)) return { mode: 'log_only', users: 0, counts, failures: [] }
  const provider = productNewsProvider(env)
  const select = userSelectSql('ORDER BY u.createdAt ASC')
  const users = await queryAll<ProductNewsUser>(db, select.sql, select.params)
  const failures: ProductNewsReconciliation['failures'] = []

  for (const user of users) {
    try {
      await syncUser(db, provider, user, 'reconcile', counts)
    } catch (error) {
      failures.push({ target: `user ${user.id}`, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const eligibleEmails = new Set(users.filter(isEligible).map(user => user.email.toLowerCase()))
  const members = await collectPages<{ id: string; email: string }>(
    'contacts.list',
    after => provider.resend.contacts.list({ segmentId: provider.segmentId, limit: 100, ...(after ? { after } : {}) }),
  )
  for (const member of members) {
    if (eligibleEmails.has(member.email.toLowerCase())) continue
    try {
      await resendData('contacts.segments.remove', () => provider.resend.contacts.segments.remove({ contactId: member.id, segmentId: provider.segmentId }))
      counts.segment_removed += 1
    } catch (error) {
      failures.push({ target: `contact ${member.id}`, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { mode: 'provider', users: users.length, counts, failures }
}

export type ProviderContactOutcome = 'no_user' | 'no_contact' | 'already_off' | 'opted_out_globally' | 'opted_out_topic' | 'unchanged'

/**
 * Applies a Resend-side unsubscribe to the local preference.
 *
 * `contact.updated` fires for any change to a Contact, so the event is only a
 * cue: the current global and Topic state is read from Resend and acted on,
 * and only an unsubscribe moves the local preference. The write is a provider
 * reconciliation, so it is not echoed back to Resend. Other categories and
 * WhatsApp are untouched.
 */
export async function reconcileProductNewsFromProvider(db: DbClient, env: ProductNewsEnv, eventEmail: string): Promise<ProviderContactOutcome> {
  // Better Auth stores addresses lowercased; the Contact is the same address.
  const email = eventEmail.trim().toLowerCase()
  const user = await queryFirst<{ id: string }>(db, 'SELECT id FROM user WHERE email = ? AND emailVerified = 1', [email])
  if (!user) return 'no_user'
  const provider = productNewsProvider(env)
  const contact = await resendData('contacts.get', () => provider.resend.contacts.get({ email }), { notFound: 'null' })
  if (!contact) return 'no_contact'
  if (!(await wantsNotification(db, user.id, 'product_news', 'email'))) return 'already_off'
  if (contact.unsubscribed) {
    await disableCategoryEmail(db, user.id, 'product_news', { origin: 'provider' })
    return 'opted_out_globally'
  }
  if ((await contactTopicSubscription(provider, email)) === 'opt_out') {
    await disableCategoryEmail(db, user.id, 'product_news', { origin: 'provider' })
    return 'opted_out_topic'
  }
  return 'unchanged'
}
