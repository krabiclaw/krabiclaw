import { createHash } from 'node:crypto'
import { guestAccountUrl } from '~/shared/guest-account'
import { formatCalendarDate, formatTime, formatTimestamp, localPartsAt } from '~/utils/timezone'
import { getGuestRequest, requestSummary, type cancelBookingRequest } from '~/server/domain/requests'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { getEmailDeliveryMode, hashEmail, isReservedTestDomain, sendEmail } from '~/server/utils/email-delivery'
import { buildWhatsAppTemplatePayload, sendWhatsAppNotification, type WhatsAppTemplate } from '~/server/utils/whatsapp'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { getWhatsAppDeliveryMode } from '~/server/utils/whatsapp-delivery'
import { buildReplyToAddress } from '~/server/utils/submission-messages'
import { listOrganizationNotificationMembers } from '~/server/utils/member-access'
import { wantsNotification } from '~/server/domain/notification-preferences'
import { buildUnsubscribeUrls } from '~/server/utils/unsubscribe'
import type { NotificationCategory } from '~/shared/notification-categories'
import { renderNotificationEmail } from '~/server/emails/render'
import { toWhatsAppVars } from '~/server/notifications/whatsapp-mapping'
import { NOTIFICATION_CATALOG } from '~/server/notifications/catalog'
import { loadOwnerPictures, organizationLogo } from '~/server/notifications/hero'
import {
  guestBookingCancelledMessage,
  guestBookingReceivedMessage,
  guestContactReceivedMessage,
  guestReservationCancelledMessage,
  guestReservationReceivedMessage,
  organizationInviteMessage,
  reviewRequestMessage,
} from '~/server/notifications/guest-events'
import type { NotificationMessage } from '~/server/notifications/messages'
import {
  bookingCancelledMessage,
  bookingChangeMessage,
  bookingCreatedMessage,
  bookingReassignedMessage,
  contactReceivedMessage,
  guestReplyMessage,
  reservationCancelledMessage,
  reservationCreatedMessage,
  reviewReceivedMessage,
} from '~/server/notifications/events'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createCanonicalNotification } from '~/server/utils/notification-center'
import { buildOwnerThreadInboxUrl, getPlatformDomain, platformOrigin, resolveDashboardSlugs } from '~/server/utils/dashboard-notification-links'
import { reviewEditorPath } from '~/server/utils/dashboard-links'
import { createDeliveryReceipt, isDeliverySent, recordDeliveryOutcome } from '~/server/domain/guest-threads/deliveries'
import { appendEntry, findEntryByDedupeKey } from '~/server/domain/guest-threads/entries'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import type { GuestThreadDeliveryPurpose } from '~/server/domain/guest-threads/types'
import { getPersistedSourceLocale } from '~/server/utils/localization'
import { indexStoredPublicLocalizations, type StoredPublicLocalizationRow } from '~/server/utils/public-localization'
import { platformLocale } from '~/shared/platform-locales'

const SUBJECT_LABELS: Record<string, string> = {
  general: 'General',
  press: 'Press',
  partnerships: 'Partnerships',
  catering: 'Catering',
  careers: 'Careers',
}

type NotificationChannel = 'email' | 'whatsapp'

interface NotificationEnv extends CloudflareEnv {
  RESEND_API_KEY?: string
  WHATSAPP_PHONE_NUMBER_ID?: string
  WHATSAPP_ACCESS_TOKEN?: string
  EMAIL_FROM?: string
  EMAIL_DELIVERY_MODE?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
  EMAIL_REPLY_SECRET?: string
  GUEST_INBOX_HUBS?: DurableObjectNamespace
}

interface OrganizationContext {
  organizationId: string
  organizationName?: string | null
  locale?: string
}

interface ReservationNotificationInput extends OrganizationContext {
  guestAcknowledgement?: boolean
  locationId?: string | null
  locationName?: string | null
  reservationId: string
  guestName: string
  email: string
  /** A guest who gave no phone number has none to show; the template says so. */
  phone: string | null
  date: string
  time: string
  guests: string
  requests?: string | null
  wasConfirmed?: boolean
  cancelUrl?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  ownerInboxUrl?: string | null
}

interface ContactNotificationInput extends OrganizationContext {
  productTitle?: string | null
  locationId?: string | null
  contactId: string
  guestName: string
  email: string
  subject?: string | null
  message: string
  consentAcknowledged?: boolean
}

interface BookingNotificationInput extends OrganizationContext {
  /** Suppress only the guest acknowledgement; owner alerts and inbox audit remain. */
  guestAcknowledgement?: boolean
  status?: 'pending' | 'confirmed'
  /** So the email can lead with the experience's own photo. */
  productId?: string | null
  locationId?: string | null
  bookingId: string
  guestName: string
  email: string
  guestPhone?: string | null
  productTitle: string
  /**
   * The session instant and the zone it belongs to.
   *
   * One instant plus one zone, not a date string and a time string: the pair
   * had no zone of its own, so every formatter had to guess, and a 7pm class
   * became a noon one in whatever zone the worker happened to run in.
   */
  startsAt: string
  timezone: string
  partySize: number
  notes?: string | null
  wasConfirmed?: boolean
  cancelUrl?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  ownerInboxUrl?: string | null
}

interface ReviewNotificationInput extends OrganizationContext {
  locationId?: string | null
  reviewId: string
  authorName: string
  rating: number
  content?: string | null
}

interface ReviewRequestNotificationInput extends OrganizationContext {
  locationId?: string | null
  requestId: string
  bookingType: 'reservation' | 'booking'
  bookingId: string
  guestName: string
  email: string
  locationName?: string | null
  bookingPhrase: string
  visitAt: string
  partySize: string
  reviewUrl: string
  /** Whose review_requests preference governs this email and its unsubscribe link. */
  userId: string
}

interface EmailTemplate {
  subject: string
  html: string
  text: string
}

interface ThreadDeliveryContext {
  threadId: string | null
  entryId: string
  purpose: GuestThreadDeliveryPurpose
  idempotencyKey: string
}

interface GuestThreadReplyNotificationInput extends OrganizationContext {
  locationId?: string | null
  threadId: string
  sourceEntryId: string
  submissionType: 'contact' | 'reservation' | 'booking' | 'stay'
  submissionId: string
  guestName: string
  guestEmail?: string | null
  guestPhone?: string | null
  inboundChannel: 'email' | 'whatsapp' | 'web'
  messagePreview: string
}

function organizationName(opts: OrganizationContext): string {
  const value = opts.organizationName?.trim()
  if (!value) throw new Error('Tenant site name is required for notifications')
  return value
}

export async function guestPresentation(db: DbClient, opts: OrganizationContext & {
  productId?: string | null
  productTitle?: string | null
  locationId?: string | null
  locationName?: string | null
}) {
  const source = await getPersistedSourceLocale(db, opts.organizationId)
  const locale = opts.locale ?? source.locale
  const [localizations, location] = await Promise.all([
    locale === source.locale ? [] : queryAll<StoredPublicLocalizationRow>(db, `
      SELECT rl.resource_type, rl.resource_id, rl.locale, rl.values_json, rl.route_path, p.kind AS product_kind
        FROM resource_localizations rl
        LEFT JOIN products p ON rl.resource_type = 'product' AND p.id = rl.resource_id AND p.organization_id = rl.organization_id
       WHERE rl.organization_id = ? AND rl.locale = ?
         AND ((rl.resource_type = 'organization' AND rl.resource_id = ?)
           OR (rl.resource_type = 'business_location' AND rl.resource_id = ?)
           OR (rl.resource_type = 'product' AND rl.resource_id = ?))
    `, [opts.organizationId, locale, opts.organizationId, opts.locationId ?? null, opts.productId ?? null]).then(indexStoredPublicLocalizations),
    opts.locationId && opts.locationName === undefined
      ? queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE organization_id = ? AND id = ?', [opts.organizationId, opts.locationId])
      : null,
  ])
  const translated = (type: string, id: string | null | undefined, field: string) => {
    const value = localizations.find(item => item.resourceType === type && item.resourceId === id)?.values[field]
    return typeof value === 'string' && value.trim() ? value : undefined
  }
  return {
    locale,
    organizationName: translated('organization', opts.organizationId, 'name') ?? organizationName(opts),
    productTitle: translated('product', opts.productId, 'name') ?? opts.productTitle ?? null,
    locationName: translated('business_location', opts.locationId, 'title') ?? opts.locationName ?? location?.title ?? null,
  }
}

// The WhatsApp "Reply in dashboard" button URL is declared in the approved Meta
// template as a fixed prefix + single {{1}} variable, so only the path/query
// suffix after that prefix can be sent per-message.



// Deep-links an owner notification straight to the dashboard inbox thread for that submission.
async function buildOwnerInboxUrl(
  env: NotificationEnv,
  db: DbClient,
  opts: {
    organizationId: string
    locationId?: string | null
    tab: 'contact' | 'reservations' | 'bookings'
    submissionId: string
  }
): Promise<string | null> {
  const submissionType = opts.tab === 'contact' ? 'contact' : opts.tab === 'reservations' ? 'reservation' : 'booking'
  try {
    const thread = await getGuestRequest(db, opts.submissionId, opts.organizationId, submissionType)
    if (!thread) throw new Error('Submission not found')
    await publishGuestInboxThreadEvent(env, db, { threadId: thread.id, type: 'thread.created' })
    return await buildOwnerThreadInboxUrl(env, db, {
      organizationId: opts.organizationId,
      locationId: opts.locationId,
      threadId: thread.id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Submission not found')) return null
    throw error instanceof Error ? error : new Error(message)
  }
}

// Deep-links an owner notification to the Reviews tab of Reviews and Q&A, at
// the location the review belongs to when it has one.
async function buildOwnerReviewsUrl(
  env: NotificationEnv,
  db: DbClient,
  opts: { organizationId: string; locationId?: string | null; reviewId: string }
): Promise<string | null> {
  const slugs = await resolveDashboardSlugs(env, db, opts)
  if (!slugs) return null

  // The review's own level, beside the Reviews tab it is a row of.
  return `${platformOrigin(env)}${reviewEditorPath(slugs.orgSlug, opts.reviewId, opts.locationId)}`
}

/**
 * One person this alert reaches, and where.
 *
 * `email` and `phone` are null when that channel is not theirs to receive on —
 * they switched the category off, or they have no verified phone. The account
 * is the address for both: there is no configured number any more, so there is
 * no way to name a recipient the product cannot also identify.
 */
export interface OwnerRecipient {
  userId: string
  email: string | null
  phone: string | null
  /** The footer link a person clicks. */
  unsubscribeUrl: string | null
  /** The RFC 8058 endpoint a mail client POSTs to. */
  unsubscribeOneClickUrl: string | null
}

/**
 * Who actually receives this alert, on which channel.
 *
 * Both channels resolve from Better Auth membership and each person's own
 * `user_notification_preferences`. WhatsApp used to resolve from a number typed
 * into a location or organization settings field instead, which made "who gets
 * told" answerable two ways: a tenant could configure a number no account held,
 * and the send was refused to a console line no tenant could read. A number is
 * now reached because a member proved they hold it, which is the same rule
 * email has always followed.
 */
async function resolveOwnerRecipients(
  env: NotificationEnv,
  db: DbClient,
  opts: {
    organizationId: string
    category: NotificationCategory
    /** The team member a booking is assigned to hears about it alongside the owners. */
    assignedMemberId?: string | null
    memberIds?: string[]
  },
): Promise<OwnerRecipient[]> {
  const [members, messagingEnabled] = await Promise.all([
    listOrganizationNotificationMembers(env, opts.organizationId, { includeMemberIds: [...(opts.assignedMemberId ? [opts.assignedMemberId] : []), ...(opts.memberIds ?? [])] }),
    hasOrganizationEntitlement(env, opts.organizationId, 'messaging'),
  ])
  const recipients = await Promise.all(members.map(async (member) => {
    const [wantsEmail, wantsWhatsApp] = await Promise.all([
      wantsNotification(db, member.userId, opts.category, 'email'),
      messagingEnabled && member.phone ? wantsNotification(db, member.userId, opts.category, 'whatsapp') : Promise.resolve(false),
    ])
    if (!wantsEmail && !wantsWhatsApp) return null
    const unsubscribe = await buildUnsubscribeUrls(env, { userId: member.userId, category: opts.category })
    return {
      userId: member.userId,
      email: wantsEmail ? member.email : null,
      phone: wantsWhatsApp ? member.phone : null,
      unsubscribeUrl: unsubscribe?.pageUrl ?? null,
      unsubscribeOneClickUrl: unsubscribe?.oneClickUrl ?? null,
    }
  }))
  return recipients.filter((recipient): recipient is OwnerRecipient => recipient !== null)
}


async function sendEmailNotification(
  env: NotificationEnv,
  db: DbClient,
  opts: Omit<OrganizationContext, 'organizationId'> & { organizationId: string | null } & {
    locationId?: string | null
    to: string
    replyTo?: string | null
    template: string
    title: string
    payload: Record<string, string>
    email: EmailTemplate
    unsubscribeUrl?: string | null
    unsubscribeOneClickUrl?: string | null
    delivery?: ThreadDeliveryContext | null
  }
): Promise<void> {
  const provider = getEmailDeliveryMode(env) === 'provider' && !isReservedTestDomain(opts.to)
    ? 'resend'
    : 'log_only'
  const deliveryContext = opts.delivery
  const delivery = deliveryContext
    ? await createDeliveryReceipt(db, {
        entryId: deliveryContext.entryId,
        channel: 'email',
        provider,
        purpose: deliveryContext.purpose,
        idempotencyKey: deliveryContext.idempotencyKey,
      })
    : null
  // A receipt that already reached Resend is this event's email for this
  // recipient: a replayed event sends nothing. Otherwise the receipt id is the
  // Resend idempotency key, so a concurrent replay cannot send it twice.
  if (delivery && isDeliverySent(delivery)) return

  const result = await sendEmail(env, {
    to: opts.to,
    replyTo: opts.replyTo,
    subject: opts.email.subject,
    html: opts.email.html,
    text: opts.email.text,
    unsubscribeOneClickUrl: opts.unsubscribeOneClickUrl ?? null,
    idempotencyKey: delivery?.id,
  })
  if (delivery) {
    await recordDeliveryOutcome(db, {
      deliveryId: delivery.id,
      status: result.status,
      providerMessageId: result.status === 'sent' ? result.messageId : null,
      error: result.status === 'sent' ? null : result.error,
    })
    if (deliveryContext?.threadId) await publishGuestInboxThreadEvent(env, db, { threadId: deliveryContext.threadId, type: 'delivery.changed' })
  }
  if (result.status === 'sent') {
    console.info(provider === 'log_only' ? 'email_delivery_log_only' : 'email_delivery_sent', {
      organizationId: opts.organizationId,
      template: opts.template,
      recipient: hashEmail(opts.to),
      title: opts.title,
      providerMessageId: result.messageId,
    })
    return
  }
  // A failed send is raised, so the caller accounts for it rather than
  // answering as though the email went out.
  throw new Error(`Email delivery failed: ${result.error}`)
}

async function sendWhatsAppThreadNotification(
  env: NotificationEnv,
  db: DbClient,
  opts: {
    organizationId: string
    locationId?: string | null
    toPhone: string
    template: WhatsAppTemplate
    vars: Record<string, string>
    delivery: ThreadDeliveryContext
  },
): Promise<boolean> {
  const delivery = await createDeliveryReceipt(db, {
    entryId: opts.delivery.entryId,
    channel: 'whatsapp',
    provider: getWhatsAppDeliveryMode(env) === 'provider' ? 'meta' : 'log_only',
    purpose: opts.delivery.purpose,
    idempotencyKey: opts.delivery.idempotencyKey,
  })
  if (isDeliverySent(delivery) || delivery.status === 'skipped') return true

  const result = await sendWhatsAppNotification(env, opts)
  await recordDeliveryOutcome(db, {
    deliveryId: delivery.id,
    status: result.status,
    providerMessageId: result.status === 'sent' ? result.messageId ?? null : null,
    error: result.status === 'skipped' ? result.reason : result.success ? null : result.error,
  })
  if (opts.delivery.threadId) await publishGuestInboxThreadEvent(env, db, { threadId: opts.delivery.threadId, type: 'delivery.changed' })
  return result.success
}

async function getOpeningThreadContext(
  db: DbClient,
  submissionType: 'contact' | 'reservation' | 'booking',
  submissionId: string,
): Promise<{ guestThreadId: string; sourceEntryId: string }> {
  const thread = await getGuestRequest(db, submissionId, undefined, submissionType)
  if (!thread) throw new Error('Submission notification has no canonical request')
  const entry = await findEntryByDedupeKey(db, `request:${submissionId}:submission`)
  if (!entry) throw new Error('Submission notification has no opening activity entry')
  return { guestThreadId: thread.id, sourceEntryId: entry.id }
}

function threadDelivery(
  context: { guestThreadId: string | null; sourceEntryId: string } | null,
  purpose: GuestThreadDeliveryPurpose,
  channel: NotificationChannel,
  template: string,
  recipient: string,
  eventKey?: string,
): ThreadDeliveryContext | null {
  if (!context) return null
  return {
    threadId: context.guestThreadId,
    entryId: context.sourceEntryId,
    purpose,
    idempotencyKey: eventKey
      ? createHash('sha256').update(JSON.stringify([eventKey, purpose, channel, hashEmail(recipient)])).digest('hex')
      : `${context.sourceEntryId}:${purpose}:${channel}:${template}:${hashEmail(recipient)}`,
  }
}

async function recordGuestCancellation(
  db: DbClient,
  input: {
    submissionType: 'reservation' | 'booking'
    submissionId: string
    organizationId: string
    subject: string
    body: string
    wasConfirmed: boolean
  },
): Promise<{ guestThreadId: string; sourceEntryId: string }> {
  const thread = await getGuestRequest(db, input.submissionId, undefined, input.submissionType)
  if (!thread) throw new Error('Guest cancellation has no canonical request')
  const entry = await appendEntry(db, {
    threadId: thread.id,
    kind: 'operation',
    actorKind: 'guest',
    channel: 'web',
    body: input.body,
    eventName: `${input.submissionType}.guest_cancelled`,
    payloadJson: { subject: input.subject, wasConfirmed: input.wasConfirmed },
    dedupeKey: `guest-cancellation:${input.submissionType}:${input.submissionId}`,
  })
  return { guestThreadId: thread.id, sourceEntryId: entry.id }
}


// Both sends are attempted before either failure is raised: an owner alert that
// fails must not cancel the guest's acknowledgement, nor the reverse. But a send
// that failed is a failure, so it is raised rather than logged. Logging it here
// is what let a booking answer 200 while the business was never told — the
// per-channel outcome is already durable in guest_thread_deliveries; this is
// what stops the route above from reporting success it did not have.
export function raiseSettledFailures(
  label: string,
  context: string,
  results: readonly PromiseSettledResult<unknown>[],
  tasks: readonly string[] = ['notifyOwner', 'sendEmailNotification'],
): void {
  const failed = results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ task: tasks[index] ?? String(index), reason: result.reason }] : [])
  if (failed.length === 0) return
  throw new AggregateError(
    failed.map(({ reason }) => reason instanceof Error ? reason : new Error(String(reason))),
    `${label} failed for ${context}: ${failed.map(({ task }) => task).join(' and ')}`,
    { cause: failed[0]!.reason },
  )
}

/**
 * The hero for a message about a location or an experience, or — when the
 * message names neither — about the organization itself.
 */
async function messageHero(db: DbClient, organizationId: string, owner: { type: 'business_location' | 'product'; id: string | null | undefined }) {
  const [ownerType, ownerId] = owner.id ? [owner.type, owner.id] : ['organization' as const, organizationId]
  return (await loadOwnerPictures(db, organizationId, ownerType, [ownerId])).get(ownerId) ?? null
}

async function notifyOwner(
  env: NotificationEnv,
  db: DbClient,
  opts: OrganizationContext & {
    locationId?: string | null
    template: string
    title: string
    payload: Record<string, string>
    /**
     * The event, described once. The email is rendered from it after the
     * recipient is known — so the footer carries that person's own opt-out
     * link — and the WhatsApp vars are selected from the same facts, so the
     * two channels cannot describe the event differently.
     */
    message: NotificationMessage
    /** The approved template the same facts are mapped onto. */
    whatsappTemplate?: WhatsAppTemplate
    submissionType?: 'contact' | 'reservation' | 'booking' | 'invitation' | null
    submissionId?: string | null
    notificationSource?: { threadId: string; entryId: string }
    /** Keys the in-app notification for an event that has no guest thread. */
    idempotencyKey?: string
    /** Native financial event identity, independent of later buyer linking. */
    deliveryEventKey?: string
    /** Team members told alongside the owners and the booking's assignee, such as the one a booking moved away from. */
    memberIds?: string[]
  }
) {
  const threadContext = opts.notificationSource
    ? { guestThreadId: opts.notificationSource.threadId, sourceEntryId: opts.notificationSource.entryId }
    : opts.submissionType && opts.submissionType !== 'invitation' && opts.submissionId
      ? await getOpeningThreadContext(db, opts.submissionType, opts.submissionId)
      : null
  const notificationId = await createCanonicalNotification(db, {
    publishEnv: env,
    scope: 'organization',
    template: opts.template,
    organizationId: opts.organizationId,
    locationId: opts.locationId ?? null,
    sourceEntryId: threadContext?.sourceEntryId ?? null,
    idempotencyKey: threadContext ? `notification:${threadContext.sourceEntryId}:${opts.template}` : opts.idempotencyKey,
    title: opts.title,
    message: opts.message.facts.map(fact => `${fact.label}: ${fact.value}`).join('\n'),
    threadId: threadContext?.guestThreadId ?? null,
    deepLink: opts.payload.deep_link || null,
  })
  const deliveryContext = threadContext ?? { guestThreadId: null, sourceEntryId: notificationId }

  // Owners and admins hear about every booking; the member it is assigned to hears about theirs.
  const assigned = opts.submissionType === 'booking' && opts.submissionId
    ? await queryFirst<{ assigned_member_id: string | null }>(db, 'SELECT assigned_member_id FROM bookings WHERE organization_id = ? AND (request_id = ? OR id = ?) LIMIT 1', [opts.organizationId, opts.submissionId, opts.submissionId])
    : null
  const recipients = await resolveOwnerRecipients(env, db, {
    organizationId: opts.organizationId,
    category: opts.message.category,
    assignedMemberId: assigned?.assigned_member_id ?? null,
    memberIds: opts.memberIds ?? [],
  })

  // The owner reads mail sent for their business, framed by its own mark.
  const message = { ...opts.message, organizationLogoUrl: await organizationLogo(db, opts.organizationId) }

  const whatsappVars = opts.whatsappTemplate && recipients.some(recipient => recipient.phone)
    ? toWhatsAppVars(message, opts.whatsappTemplate)
    : null
  if (whatsappVars?.omitted.length) {
    // Declared in WHATSAPP_MAPPINGS.cannotCarry and enforced by
    // lint:notification-parity, so this is a record of a known template
    // limit rather than a surprise.
    console.info('whatsapp_facts_omitted', { template: opts.whatsappTemplate, omitted: whatsappVars.omitted })
  }

  const results = await Promise.allSettled(recipients.flatMap((recipient) => {
    const sends: Array<Promise<unknown>> = []
    if (recipient.email) {
      const to = recipient.email
      sends.push((async () => {
        // Rendered per person: the footer carries that recipient's own opt-out
        // link, so the same event cannot hand one member another's.
        const rendered = await renderNotificationEmail(message, {
          platformDomain: getPlatformDomain(env),
          preferencesUrl: `https://${getPlatformDomain(env)}/dashboard/account/profile/notifications`,
          unsubscribeUrl: recipient.unsubscribeUrl,
        })
        await sendEmailNotification(env, db, {
          ...opts,
          to,
          email: { subject: sanitizeEmailHeaderValue(message.title), html: rendered.html, text: rendered.text },
          unsubscribeOneClickUrl: recipient.unsubscribeOneClickUrl,
          delivery: threadDelivery(deliveryContext, 'owner_alert', 'email', opts.template, to, opts.deliveryEventKey),
        })
      })())
    }
    if (recipient.phone && opts.whatsappTemplate && whatsappVars) {
      const toPhone = recipient.phone
      const sendOptions = {
        organizationId: opts.organizationId,
        locationId: opts.locationId ?? null,
        toPhone,
        template: opts.whatsappTemplate,
        vars: whatsappVars.vars,
      }
      const delivery = threadDelivery(deliveryContext, 'owner_alert', 'whatsapp', opts.template, toPhone, opts.deliveryEventKey)
      // A refused send resolves rather than throwing, so without this the
      // settled-failure check sees a fulfilled promise and reports nothing —
      // the alert is lost exactly as quietly as the console line it replaced.
      sends.push((async () => {
        if (delivery) {
          if (!await sendWhatsAppThreadNotification(env, db, { ...sendOptions, delivery })) {
            throw new Error(`WhatsApp owner alert was not delivered for organization ${opts.organizationId}`)
          }
          return
        }
        const result = await sendWhatsAppNotification(env, sendOptions)
        if (!result.success) {
          throw new Error(`WhatsApp owner alert was not delivered for organization ${opts.organizationId}: ${result.error}`)
        }
      })())
    }
    return sends
  }))
  raiseSettledFailures('notifyOwner', `organization ${opts.organizationId}`, results,
    results.map(() => 'ownerAlert'))
}

/** Financial status mail shares the canonical notification and delivery ledger. */
export async function notifyFinancialNotification(
  env: NotificationEnv,
  db: DbClient,
  input: {
    organizationId: string | null
    eventKey: string
    ownerMessage?: NotificationMessage
    guest?: { userId: string | null; email: string | null; message: NotificationMessage }
    sourceEntryId?: string | null
    threadId?: string | null
    deepLink?: string | null
  },
): Promise<void> {
  if (!input.eventKey.trim()) throw new Error('Financial notification requires its native event identity')
  if (Boolean(input.sourceEntryId) !== Boolean(input.threadId)) throw new Error('Financial conversation activity requires both its entry and thread')
  const ownerDeliveryAnchor = async () => {
    if (input.sourceEntryId) return input.sourceEntryId
    if (!input.organizationId || !input.ownerMessage) throw new Error('Contact-only financial mail has no retained notification delivery anchor')
    return await createCanonicalNotification(db, {
      publishEnv: env, scope: 'organization', organizationId: input.organizationId,
      template: input.eventKey, idempotencyKey: `${input.eventKey}:owner`,
      title: input.ownerMessage.title,
      message: input.ownerMessage.facts.map(fact => `${fact.label}: ${fact.value}`).join('\n'),
      deepLink: input.deepLink ?? input.ownerMessage.primaryAction?.url ?? null,
    })
  }
  const tasks: Array<Promise<unknown>> = []
  const taskNames: string[] = []
  if (input.ownerMessage) {
    if (!input.organizationId) throw new Error('Merchant financial notification requires its organization')
    tasks.push(notifyOwner(env, db, {
      organizationId: input.organizationId,
      organizationName: input.ownerMessage.organizationName,
      template: input.eventKey,
      title: input.ownerMessage.title,
      payload: { deep_link: input.deepLink ?? input.ownerMessage.primaryAction?.url ?? '' },
      message: input.ownerMessage,
      notificationSource: input.sourceEntryId && input.threadId ? { entryId: input.sourceEntryId, threadId: input.threadId } : undefined,
      idempotencyKey: `${input.eventKey}:owner`,
      deliveryEventKey: `${input.eventKey}:owner`,
    }))
    taskNames.push('merchant')
  }
  if (input.guest && (input.guest.userId || input.guest.email)) {
    const guest = input.guest
    tasks.push((async () => {
      // The native checkout contact is an email destination, never an account
      // identity. Only Better Auth's explicit buyer owns the personal alert.
      const id = guest.userId
        ? await createCanonicalNotification(db, {
            scope: 'global', template: input.eventKey, targetUserId: guest.userId,
            idempotencyKey: `${input.eventKey}:buyer`,
            title: guest.message.title,
            message: guest.message.facts.map(fact => `${fact.label}: ${fact.value}`).join('\n'),
            deepLink: guest.message.primaryAction?.url ?? '/dashboard/account/activity',
          })
        : await ownerDeliveryAnchor()
      if (!guest.email) return
      // Mail receipts survive personal account deletion with the merchant's
      // financial activity. Deleting a personal alert must not allow a resend.
      const emailEntryId = input.organizationId && input.ownerMessage ? await ownerDeliveryAnchor() : id
      const rendered = await renderNotificationEmail(guest.message, {
        platformDomain: getPlatformDomain(env),
        preferencesUrl: `https://${getPlatformDomain(env)}/dashboard/account/profile/notifications`,
      })
      await sendEmailNotification(env, db, {
        organizationId: input.organizationId, organizationName: guest.message.organizationName,
        to: guest.email, template: input.eventKey, title: guest.message.title, payload: {},
        email: { subject: sanitizeEmailHeaderValue(guest.message.title), html: rendered.html, text: rendered.text },
        delivery: threadDelivery({ guestThreadId: input.threadId ?? null, sourceEntryId: emailEntryId }, 'status_update', 'email', input.eventKey, guest.email, `${input.eventKey}:buyer`),
      })
    })())
    taskNames.push('buyer')
  }
  raiseSettledFailures('Financial notification', input.eventKey, await Promise.allSettled(tasks), taskNames)
}

// Email subjects go into a header context, not HTML — strip CR/LF so a guest name can't
// inject additional headers, independent of the HTML-body escaping used elsewhere.
function sanitizeEmailHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export async function notifyReservationCreated(
  env: NotificationEnv,
  db: DbClient,
  opts: ReservationNotificationInput
) {
  const restaurant = organizationName(opts)
  const prettyDate = formatCalendarDate(opts.date, 'en')
  const prettyTime = formatTime(opts.time, 'en')
  const platformDomain = getPlatformDomain(env)
  const [replyTo, inboxUrl] = await Promise.all([
    buildReplyToAddress(env, 'reservation', opts.reservationId),
    opts.ownerInboxUrl !== undefined
      ? opts.ownerInboxUrl
      : buildOwnerInboxUrl(env, db, {
          organizationId: opts.organizationId,
          locationId: opts.locationId,
          tab: 'reservations',
          submissionId: opts.reservationId,
        }),
  ])
  const threadContext = await getOpeningThreadContext(db, 'reservation', opts.reservationId)

  const payload = {
    reservation_id: opts.reservationId,
    guest_name: opts.guestName,
    email: opts.email,
    phone: opts.phone ?? '',
    date: opts.date,
    time: opts.time,
    guests: opts.guests,
    requests: opts.requests ?? '',
    location_name: opts.locationName ?? '',
    organization_name: restaurant,
    deep_link: inboxUrl ?? '',
  }

  const [hero, logoUrl] = await Promise.all([
    messageHero(db, opts.organizationId, { type: 'business_location', id: opts.locationId }),
    organizationLogo(db, opts.organizationId),
  ])
  const ownerMessage = reservationCreatedMessage({
    guestName: opts.guestName, guestEmail: opts.email, guestPhone: opts.phone ?? null,
    date: prettyDate, time: prettyTime, partySize: opts.guests,
    locationName: opts.locationName ?? null, organizationName: restaurant,
    notes: opts.requests ?? null, heroImageUrl: hero?.imageUrl ?? null, replyUrl: inboxUrl,
  })
  const guest = await guestPresentation(db, opts)
  const guestMessage = guestReservationReceivedMessage({
    ...guest,
    accountUrl: guestAccountUrl(env.NUXT_PUBLIC_PLATFORM_DOMAIN!, '/signup', opts.email),
    guestName: opts.guestName, organizationLogoUrl: logoUrl,
    date: formatCalendarDate(opts.date, guest.locale), time: formatTime(opts.time, guest.locale), partySize: opts.guests, notes: opts.requests,
    contactPhone: opts.contactPhone, contactEmail: opts.contactEmail,
    cancelUrl: opts.cancelUrl, heroImageUrl: hero?.imageUrl ?? null,
  })
  const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain })

  const results = await Promise.allSettled([
    notifyOwner(env, db, {
      ...opts,
      submissionType: 'reservation',
      submissionId: opts.reservationId,
      template: 'new_reservation',
      title: ownerMessage.title,
      payload,
      message: ownerMessage,
      whatsappTemplate: 'new_reservation',
    }),
    ...(opts.guestAcknowledgement === false ? [] : [sendEmailNotification(env, db, {
      ...opts,
      to: opts.email,
      replyTo,
      template: 'reservation_customer_received',
      title: guestMessage.title,
      payload,
      email: { subject: guestMessage.title, html: guestEmail.html, text: guestEmail.text },
      delivery: threadDelivery(threadContext, 'guest_acknowledgement', 'email', 'reservation_customer_received', opts.email),
    })]),
  ])

  raiseSettledFailures('notifyReservationCreated', `reservationId ${opts.reservationId}`, results)
}

export async function notifyReservationCancelled(
  env: NotificationEnv,
  db: DbClient,
  opts: ReservationNotificationInput
) {
  const confirmed = Boolean(opts.wasConfirmed)
  const restaurant = organizationName(opts)
  const prettyDate = formatCalendarDate(opts.date, 'en')
  const prettyTime = formatTime(opts.time, 'en')
  const platformDomain = getPlatformDomain(env)
  const [inboxUrl, logoUrl] = await Promise.all([
    buildOwnerInboxUrl(env, db, {
      organizationId: opts.organizationId,
      locationId: opts.locationId,
      tab: 'reservations',
      submissionId: opts.reservationId,
    }),
    organizationLogo(db, opts.organizationId),
  ])

  const payload = {
    reservation_id: opts.reservationId,
    guest_name: opts.guestName,
    email: opts.email,
    phone: opts.phone ?? '',
    date: opts.date,
    time: opts.time,
    guests: opts.guests,
    reservation_was_confirmed: confirmed ? 'true' : 'false',
    location_name: opts.locationName ?? '',
    organization_name: restaurant,
    deep_link: inboxUrl ?? '',
  }

  const ownerMessage = reservationCancelledMessage({
    guestName: opts.guestName, guestEmail: opts.email, guestPhone: opts.phone ?? null,
    date: prettyDate, time: prettyTime, partySize: opts.guests,
    locationName: opts.locationName ?? null, organizationName: restaurant,
    notes: opts.requests ?? null, heroImageUrl: null, replyUrl: inboxUrl,
    wasConfirmed: confirmed,
  })
  const guest = await guestPresentation(db, opts)
  const guestMessage = guestReservationCancelledMessage({
    ...guest,
    guestName: opts.guestName, date: formatCalendarDate(opts.date, guest.locale), time: formatTime(opts.time, guest.locale),
    partySize: opts.guests, notes: opts.requests, wasConfirmed: confirmed,
    organizationLogoUrl: logoUrl,
  })
  const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain })
  const threadContext = await recordGuestCancellation(db, {
    submissionType: 'reservation',
    submissionId: opts.reservationId,
    organizationId: opts.organizationId,
    subject: guestMessage.title,
    body: guestEmail.text,
    wasConfirmed: confirmed,
  })

  const results = await Promise.allSettled([
    notifyOwner(env, db, {
      ...opts,
      submissionType: 'reservation',
      submissionId: opts.reservationId,
      // The opening entry already carries the new_reservation alert and a source
      // entry holds one notification, so this one hangs off the cancellation
      // entry recorded above.
      notificationSource: { threadId: threadContext.guestThreadId, entryId: threadContext.sourceEntryId },
      template: 'reservation_cancelled',
      title: ownerMessage.title,
      payload,
      message: ownerMessage,
      whatsappTemplate: 'reservation_cancelled',
    }),
    sendEmailNotification(env, db, {
      ...opts,
      to: opts.email,
      template: 'reservation_customer_cancelled',
      title: guestMessage.title,
      payload,
      email: { subject: guestMessage.title, html: guestEmail.html, text: guestEmail.text },
      delivery: threadDelivery(threadContext, 'status_update', 'email', 'reservation_customer_cancelled', opts.email),
    }),
  ])

  raiseSettledFailures('notifyReservationCancelled', `reservationId ${opts.reservationId}`, results)
}

export async function notifyContactSubmitted(
  env: NotificationEnv,
  db: DbClient,
  opts: ContactNotificationInput
) {
  const restaurant = organizationName(opts)
  const platformDomain = getPlatformDomain(env)
  const replyTo = await buildReplyToAddress(env, 'contact', opts.contactId)
  const inboxUrl = await buildOwnerInboxUrl(env, db, {
    organizationId: opts.organizationId,
    locationId: opts.locationId,
    tab: 'contact',
    submissionId: opts.contactId,
  })
  const threadContext = await getOpeningThreadContext(db, 'contact', opts.contactId)
  const payload = {
    contact_id: opts.contactId,
    guest_name: opts.guestName,
    email: opts.email,
    subject: opts.subject ?? '',
    message_preview: opts.message.slice(0, 200),
    organization_name: restaurant,
    experience_title: opts.productTitle ?? '',
    consent_acknowledged: opts.consentAcknowledged === true ? 'true' : 'false',
    deep_link: inboxUrl ?? '',
  }

  const ownerMessage = contactReceivedMessage({
    guestName: opts.guestName, guestEmail: opts.email,
    subject: SUBJECT_LABELS[opts.subject ?? 'general'] ?? opts.subject ?? 'General',
    message: opts.message, productTitle: opts.productTitle ?? null,
    organizationName: restaurant, consentAcknowledged: Boolean(opts.consentAcknowledged), replyUrl: inboxUrl,
  })
  const guest = await guestPresentation(db, opts)
  const subjectLabel = opts.subject ? platformLocale(guest.locale)!.messages[`saya.contact_page.${opts.subject}`] ?? opts.subject : null
  const guestMessage = guestContactReceivedMessage({
    ...guest,
    accountUrl: guestAccountUrl(env.NUXT_PUBLIC_PLATFORM_DOMAIN!, '/signup', opts.email),
    guestName: opts.guestName, organizationLogoUrl: await organizationLogo(db, opts.organizationId),
    subject: subjectLabel,
    productTitle: guest.productTitle, message: opts.message,
    consentAcknowledged: Boolean(opts.consentAcknowledged),
  })
  const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain })

  const results = await Promise.allSettled([
    notifyOwner(env, db, {
      ...opts,
      submissionType: 'contact',
      submissionId: opts.contactId,
      template: 'new_contact_msg',
      title: ownerMessage.title,
      payload,
      message: ownerMessage,
      whatsappTemplate: 'new_contact_msg',
    }),
    sendEmailNotification(env, db, {
      ...opts,
      to: opts.email,
      replyTo,
      template: 'contact_customer_received',
      title: guestMessage.title,
      payload,
      email: { subject: guestMessage.title, html: guestEmail.html, text: guestEmail.text },
      delivery: threadDelivery(threadContext, 'guest_acknowledgement', 'email', 'contact_customer_received', opts.email),
    }),
  ])

  raiseSettledFailures('notifyContactSubmitted', `contactId ${opts.contactId}`, results)

}

export async function notifyReviewReceived(
  env: NotificationEnv,
  db: DbClient,
  opts: ReviewNotificationInput
) {
  const restaurant = organizationName(opts)
  const reviewsUrl = await buildOwnerReviewsUrl(env, db, {
    organizationId: opts.organizationId,
    locationId: opts.locationId,
    reviewId: opts.reviewId,
  })

  const ownerMessage = reviewReceivedMessage({
    authorName: opts.authorName,
    rating: opts.rating,
    content: opts.content ?? '',
    organizationName: restaurant,
    reviewsUrl,
  })

  await notifyOwner(env, db, {
    ...opts,
    template: 'new_review',
    // A guest retrying a submission whose alert failed re-sends it; the
    // dashboard's notification is still one per review.
    idempotencyKey: `notification:review:${opts.reviewId}:new_review`,
    title: ownerMessage.title,
    payload: {
      review_id: opts.reviewId,
      author_name: opts.authorName,
      rating: String(opts.rating),
      content_preview: (opts.content ?? '').slice(0, 200),
      organization_name: restaurant,
      deep_link: reviewsUrl ?? '',
    },
    message: ownerMessage,
    whatsappTemplate: 'new_review',
  })
}

export async function notifyReviewRequest(
  env: NotificationEnv,
  db: DbClient,
  opts: ReviewRequestNotificationInput
): Promise<void> {
  const restaurant = organizationName(opts)
  const platformDomain = getPlatformDomain(env)
  const logoUrl = await organizationLogo(db, opts.organizationId)
  const unsubscribe = await buildUnsubscribeUrls(env, { userId: opts.userId, category: 'review_requests' })
  if (!unsubscribe) throw new Error('EMAIL_REPLY_SECRET is required to send a review request')

  const email = await renderNotificationEmail(reviewRequestMessage({
    guestName: opts.guestName,
    organizationName: restaurant,
    locationName: opts.locationName ?? null,
    visitAt: opts.visitAt,
    partySize: opts.partySize,
    reviewUrl: opts.reviewUrl,
    organizationLogoUrl: logoUrl,
  }), { platformDomain, unsubscribeUrl: unsubscribe.pageUrl })

  await sendEmailNotification(env, db, {
    ...opts,
    to: opts.email,
    template: 'booking_thank_you_review_request',
    title: `Review request for ${opts.bookingPhrase}`,
    payload: {
      request_id: opts.requestId,
      booking_type: opts.bookingType,
      booking_id: opts.bookingId,
      guest_name: opts.guestName,
      booking_phrase: opts.bookingPhrase,
      visit_at: opts.visitAt,
      party_size: opts.partySize,
      review_url: opts.reviewUrl,
      unsubscribe_url: unsubscribe.pageUrl,
      organization_name: restaurant,
    },
    unsubscribeUrl: unsubscribe.pageUrl,
    unsubscribeOneClickUrl: unsubscribe.oneClickUrl,
    email: {
      subject: `How was your visit to ${restaurant}?`,
      html: email.html,
      text: email.text,
    },
  })
}

export async function notifyBookingCreated(
  env: NotificationEnv,
  db: DbClient,
  opts: BookingNotificationInput & { status: 'pending' | 'confirmed' }
) {
  const studio = organizationName(opts)
  const prettyDate = new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone, dateStyle: 'medium' }).format(new Date(opts.startsAt))
  const prettyTime = formatTimestamp(opts.startsAt, 'en', opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const platformDomain = getPlatformDomain(env)
  const [replyTo, inboxUrl] = await Promise.all([
    buildReplyToAddress(env, 'booking', opts.bookingId),
    opts.ownerInboxUrl !== undefined
      ? opts.ownerInboxUrl
      : buildOwnerInboxUrl(env, db, {
          organizationId: opts.organizationId,
          locationId: opts.locationId,
          tab: 'bookings',
          submissionId: opts.bookingId,
        }),
  ])
  const threadContext = await getOpeningThreadContext(db, 'booking', opts.bookingId)

  const payload = {
    booking_id: opts.bookingId,
    guest_name: opts.guestName,
    email: opts.email,
    experience: opts.productTitle,
    starts_at: opts.startsAt,
    timezone: opts.timezone,
    party_size: String(opts.partySize),
    requests: opts.notes ?? '',
    organization_name: studio,
    deep_link: inboxUrl ?? '',
  }

  const [hero, logoUrl] = await Promise.all([
    messageHero(db, opts.organizationId, { type: 'product', id: opts.productId }),
    organizationLogo(db, opts.organizationId),
  ])
  const ownerMessage = bookingCreatedMessage({
    guestName: opts.guestName, guestEmail: opts.email, guestPhone: opts.guestPhone ?? null,
    date: prettyDate, time: prettyTime, partySize: String(opts.partySize),
    locationName: null, organizationName: studio, productTitle: opts.productTitle,
    notes: opts.notes ?? null, heroImageUrl: hero?.imageUrl ?? null, replyUrl: inboxUrl,
  })
  const guest = await guestPresentation(db, opts)
  const guestMessage = guestBookingReceivedMessage({
    ...guest,
    accountUrl: guestAccountUrl(env.NUXT_PUBLIC_PLATFORM_DOMAIN!, '/signup', opts.email),
    guestName: opts.guestName, organizationLogoUrl: logoUrl, status: opts.status,
    productTitle: guest.productTitle!,
    date: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { dateStyle: 'medium' }),
    time: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), partySize: String(opts.partySize),
    notes: opts.notes, contactPhone: opts.contactPhone ?? null, contactEmail: opts.contactEmail ?? null,
    cancelUrl: opts.cancelUrl ?? null, heroImageUrl: hero?.imageUrl ?? null,
  })
  const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain })
  const guestTitle = `${guestMessage.title} — ${guest.productTitle}`

  const results = await Promise.allSettled([
    notifyOwner(env, db, {
      ...opts,
      submissionType: 'booking',
      submissionId: opts.bookingId,
      // A booking is not a reservation. Recording both under 'new_reservation'
      // meant the canonical record could not tell an experience booking from a
      // restaurant table — the cancelled path already names itself correctly.
      template: 'new_booking',
      title: ownerMessage.title,
      payload,
      message: ownerMessage,
      whatsappTemplate: 'new_reservation',
    }),
    ...(opts.guestAcknowledgement === false ? [] : [sendEmailNotification(env, db, {
      ...opts,
      to: opts.email,
      replyTo,
      template: 'booking_customer_received',
      title: guestTitle,
      payload,
      email: { subject: guestTitle, html: guestEmail.html, text: guestEmail.text },
      delivery: threadDelivery(threadContext, 'guest_acknowledgement', 'email', 'booking_customer_received', opts.email),
    })]),
  ])

  raiseSettledFailures('notifyBookingCreated', `bookingId ${opts.bookingId}`, results)
}

export async function notifyBookingCancelled(
  env: NotificationEnv,
  db: DbClient,
  opts: BookingNotificationInput
) {
  const confirmed = Boolean(opts.wasConfirmed)
  const studio = organizationName(opts)
  const prettyDate = new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone, dateStyle: 'medium' }).format(new Date(opts.startsAt))
  const prettyTime = formatTimestamp(opts.startsAt, 'en', opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const platformDomain = getPlatformDomain(env)
  const [inboxUrl, logoUrl] = await Promise.all([
    buildOwnerInboxUrl(env, db, {
      organizationId: opts.organizationId,
      locationId: opts.locationId,
      tab: 'bookings',
      submissionId: opts.bookingId,
    }),
    organizationLogo(db, opts.organizationId),
  ])

  const payload = {
    booking_id: opts.bookingId,
    guest_name: opts.guestName,
    email: opts.email,
    experience: opts.productTitle,
    starts_at: opts.startsAt,
    timezone: opts.timezone,
    party_size: String(opts.partySize),
    booking_was_confirmed: confirmed ? 'true' : 'false',
    organization_name: studio,
    deep_link: inboxUrl ?? '',
  }

  const ownerMessage = bookingCancelledMessage({
    guestName: opts.guestName, guestEmail: opts.email, guestPhone: opts.guestPhone ?? null,
    date: prettyDate, time: prettyTime, partySize: String(opts.partySize),
    locationName: null, organizationName: studio, productTitle: opts.productTitle,
    notes: opts.notes ?? null, heroImageUrl: null, replyUrl: inboxUrl,
    wasConfirmed: confirmed,
  })
  const guest = await guestPresentation(db, opts)
  const guestMessage = guestBookingCancelledMessage({
    ...guest,
    guestName: opts.guestName, productTitle: guest.productTitle!,
    date: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { dateStyle: 'medium' }),
    time: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), partySize: String(opts.partySize), notes: opts.notes, wasConfirmed: confirmed,
    organizationLogoUrl: logoUrl,
  })
  const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain })
  const threadContext = await recordGuestCancellation(db, {
    submissionType: 'booking',
    submissionId: opts.bookingId,
    organizationId: opts.organizationId,
    subject: guestMessage.title,
    body: guestEmail.text,
    wasConfirmed: confirmed,
  })

  const results = await Promise.allSettled([
    notifyOwner(env, db, {
      ...opts,
      submissionType: 'booking',
      submissionId: opts.bookingId,
      // The opening entry already carries the new_booking alert and a source
      // entry holds one notification, so this one hangs off the cancellation
      // entry recorded above.
      notificationSource: { threadId: threadContext.guestThreadId, entryId: threadContext.sourceEntryId },
      template: 'booking_cancelled',
      title: ownerMessage.title,
      payload,
      message: ownerMessage,
      whatsappTemplate: 'reservation_cancelled',
    }),
    sendEmailNotification(env, db, {
      ...opts,
      to: opts.email,
      template: 'booking_customer_cancelled',
      title: guestMessage.title,
      payload,
      email: { subject: guestMessage.title, html: guestEmail.html, text: guestEmail.text },
      delivery: threadDelivery(threadContext, 'status_update', 'email', 'booking_customer_cancelled', opts.email),
    }),
  ])

  raiseSettledFailures('notifyBookingCancelled', `bookingId ${opts.bookingId}`, results)
}

/** Notify the tenant through the same dashboard/email/WhatsApp path as other booking events. */
export async function notifyBookingChangeOwner(
  env: NotificationEnv,
  db: DbClient,
  opts: OrganizationContext & {
    locationId: string
    threadId: string
    submissionType: 'reservation' | 'booking'
    submissionId: string
    sourceEntryId: string
    guestName: string
    guestEmail: string
    status: 'requested' | 'accepted' | 'declined'
    noun: string
    /**
     * The occurrence as the guest sees it, already rendered in the
     * location's own timezone. A split date/time pair here would be a second
     * place that has to agree with the session's zone, and it would not.
     */
    whenLabel: string
    /**
     * The same occurrence split for the approved WhatsApp template's date and
     * time slots, derived beside whenLabel from one formatter. Null on
     * proposals recorded before those slots were filled correctly.
     */
    whenDate: string | null
    whenTime: string | null
    guests: number
    locationTitle: string
  },
) {
  const noun = opts.noun
  const message = opts.status === 'requested'
    ? 'The guest has been asked to accept or decline. The original details remain unchanged until they accept.'
    : opts.status === 'accepted'
      ? 'The guest accepted. The updated details are now confirmed.'
      : 'The guest declined. The original details remain unchanged.'
  const replyUrl = await buildOwnerThreadInboxUrl(env, db, opts)
  const ownerMessage = bookingChangeMessage({
    recordKind: noun,
    guestName: opts.guestName,
    status: opts.status,
    location: opts.locationTitle,
    date: opts.whenDate,
    time: opts.whenTime,
    whenLabel: opts.whenLabel,
    partySize: String(opts.guests),
    summary: message,
    replyUrl,
    organizationName: organizationName(opts),
  })
  await notifyOwner(env, db, {
    ...opts,
    template: `${noun}.change_${opts.status}`,
    title: ownerMessage.title,
    payload: {
      request_id: opts.threadId,
      submission_type: opts.submissionType,
      submission_id: opts.submissionId,
      status: opts.status,
      deep_link: replyUrl ?? '',
    },
    notificationSource: { threadId: opts.threadId, entryId: opts.sourceEntryId },
    message: ownerMessage,
    whatsappTemplate: 'booking_change_update',
  })
}

/** Owners and both team members hear that a booking moved; the guest is told in their thread. */
export async function notifyBookingReassigned(
  env: NotificationEnv,
  db: DbClient,
  opts: { organizationId: string; bookingId: string; previousMemberId: string | null; memberId: string; sourceEntryId: string },
) {
  const row = await queryFirst<{ request_id: string; location_id: string | null; title: string; starts_at: string; timezone: string; party_size: number; guest_name: string | null; organization_name: string }>(db, `
    SELECT b.request_id, r.location_id, p.name title, s.starts_at, s.timezone, b.party_size, json_extract(r.payload_json,'$.guest.name') guest_name, o.name organization_name
    FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
      JOIN products p ON p.id=b.product_id AND p.organization_id=b.organization_id
      JOIN organization o ON o.id=b.organization_id
      LEFT JOIN requests r ON r.id=b.request_id AND r.organization_id=b.organization_id
    WHERE b.id=? AND b.organization_id=?`, [opts.bookingId, opts.organizationId])
  if (!row) throw new Error(`Booking ${opts.bookingId} disappeared before its reassignment was announced`)
  const memberName = async (memberId: string) => (await queryFirst<{ name: string }>(db, `SELECT COALESCE(NULLIF(ms.public_name,''), u.name, u.email) name FROM member m JOIN user u ON u.id=m.userId
    LEFT JOIN member_scheduling ms ON ms.member_id=m.id WHERE m.id=? AND m.organizationId=?`, [memberId, opts.organizationId]))?.name ?? null
  const toName = await memberName(opts.memberId)
  if (!toName) throw new Error(`Team member ${opts.memberId} is not in this organization`)
  const fromName = opts.previousMemberId ? await memberName(opts.previousMemberId) : null
  const replyUrl = await buildOwnerThreadInboxUrl(env, db, { organizationId: opts.organizationId, locationId: row.location_id, threadId: row.request_id })
  const message = bookingReassignedMessage({
    guestName: row.guest_name ?? 'Guest',
    productTitle: row.title,
    date: new Intl.DateTimeFormat('en-US', { timeZone: row.timezone, dateStyle: 'medium' }).format(new Date(row.starts_at)),
    time: new Intl.DateTimeFormat('en-US', { timeZone: row.timezone, timeStyle: 'short' }).format(new Date(row.starts_at)),
    partySize: String(row.party_size),
    fromName, toName, replyUrl,
    organizationName: row.organization_name,
  })
  await notifyOwner(env, db, {
    organizationId: opts.organizationId,
    organizationName: row.organization_name,
    locationId: row.location_id,
    template: 'booking_reassigned',
    title: message.title,
    payload: { booking_id: opts.bookingId, request_id: row.request_id, deep_link: replyUrl ?? '' },
    submissionType: 'booking',
    submissionId: opts.bookingId,
    notificationSource: { threadId: row.request_id, entryId: opts.sourceEntryId },
    message,
    memberIds: [opts.memberId, ...(opts.previousMemberId ? [opts.previousMemberId] : [])],
  })
}

export async function notifyGuestThreadReply(
  env: NotificationEnv,
  db: DbClient,
  opts: GuestThreadReplyNotificationInput,
) {
  const threadContext = { guestThreadId: opts.threadId, sourceEntryId: opts.sourceEntryId }
  const replyUrl = await buildOwnerThreadInboxUrl(env, db, {
    organizationId: opts.organizationId,
    locationId: opts.locationId,
    threadId: opts.threadId,
  })

  const payload = {
    request_id: opts.threadId,
    submission_type: opts.submissionType,
    submission_id: opts.submissionId,
    guest_name: opts.guestName,
    inbound_channel: opts.inboundChannel,
    message_preview: opts.messagePreview.slice(0, 200),
    deep_link: replyUrl ?? '',
  }

  const title = `New guest reply from ${opts.guestName}`

  const template = `submission_reply_${opts.inboundChannel}`
  await createCanonicalNotification(db, {
    publishEnv: env,
    scope: 'organization',
    template,
    organizationId: opts.organizationId,
    locationId: opts.locationId ?? null,
    sourceEntryId: opts.sourceEntryId,
    // Keyed by the guest's entry, so a redelivered email that resolves to the
    // same entry does not notify the owner a second time.
    idempotencyKey: `notification:${opts.sourceEntryId}:${template}`,
    title,
    threadId: threadContext.guestThreadId,
    deepLink: payload.deep_link || null,
  })

  const ownerMessage = {
    ...guestReplyMessage({
      guestName: opts.guestName,
      guestEmail: opts.guestEmail ?? null,
      inboundChannel: opts.inboundChannel,
      messagePreview: opts.messagePreview,
      organizationName: opts.organizationName ?? null,
      replyUrl,
    }),
    organizationLogoUrl: await organizationLogo(db, opts.organizationId),
  }

  const recipients = await resolveOwnerRecipients(env, db, {
    organizationId: opts.organizationId,
    category: ownerMessage.category,
  })

  const results = await Promise.allSettled(recipients.flatMap((recipient) => {
    const sends: Array<Promise<unknown>> = []
    if (recipient.email) {
      const to = recipient.email
      sends.push((async () => {
        await sendEmailNotification(env, db, {
          organizationId: opts.organizationId,
          organizationName: opts.organizationName ?? null,
          locationId: opts.locationId ?? null,
          to,
          template: 'guest_thread_reply_email',
          title,
          payload,
          email: {
            subject: sanitizeEmailHeaderValue(ownerMessage.title),
            ...(await renderNotificationEmail(ownerMessage, {
              platformDomain: getPlatformDomain(env),
              preferencesUrl: `https://${getPlatformDomain(env)}/dashboard/account/profile/notifications`,
              unsubscribeUrl: recipient.unsubscribeUrl,
            })),
          },
          unsubscribeUrl: recipient.unsubscribeUrl,
          unsubscribeOneClickUrl: recipient.unsubscribeOneClickUrl,
          delivery: threadDelivery(threadContext, 'owner_alert', 'email', 'guest_thread_reply_email', to),
        })
      })())
    }
    if (recipient.phone) {
      const toPhone = recipient.phone
      const delivery = threadDelivery(threadContext, 'owner_alert', 'whatsapp', 'guest_thread_reply_whatsapp', toPhone)
      if (!delivery) throw new Error('Guest reply delivery context is missing')
      sends.push((async () => {
        if (!await sendWhatsAppThreadNotification(env, db, {
          organizationId: opts.organizationId,
          locationId: opts.locationId ?? null,
          toPhone,
          template: 'guest_thread_reply_whatsapp',
          vars: toWhatsAppVars(ownerMessage, 'guest_thread_reply_whatsapp').vars,
          delivery,
        })) {
          throw new Error(`WhatsApp guest-reply alert was not delivered for thread ${opts.threadId}`)
        }
      })())
    }
    return sends
  }))
  raiseSettledFailures('notifyGuestThreadReply', `thread ${opts.threadId}`, results,
    results.map(() => 'ownerAlert'))
}

export interface OrganizationInvitationInput {
  organizationId: string
  invitationId: string
  expiresAt: string
  inviterUserId: string
  email: string
  role: string
  organizationName: string
  inviterName: string
}

// Called from the Better Auth organization plugin's sendInvitationEmail hook
// (server/utils/auth.ts) — the only place organization invitation emails are
// sent, so every invite (dashboard, admin, or a future API surface) that goes
// through auth.api.createInvitation gets this for free.
export async function notifyOrganizationInvited(
  env: NotificationEnv,
  db: DbClient,
  opts: OrganizationInvitationInput
) {
  const platformDomain = getPlatformDomain(env)
  const inviteUrl = `https://${platformDomain}/accept-invitation/${opts.invitationId}`
  const eventKey = `organization-invitation:${opts.invitationId}`
  const audit = organizationEventQuery({ organizationId: opts.organizationId, actorId: opts.inviterUserId,
    eventType: 'member.invited', entityType: 'invitation', entityId: opts.invitationId,
    dedupeKey: eventKey, metadata: { role: opts.role } })
  await execute(db, `${audit.query} ON CONFLICT(dedupe_key) DO NOTHING`, audit.params)
  const entry = await queryFirst<{id:string}>(db, "SELECT id FROM activity_entries WHERE dedupe_key=? AND organization_id=? AND scope_kind='organization'", [eventKey,opts.organizationId])
  if (!entry) throw new Error('Invitation delivery has no organization receipt')

  const rendered = await renderNotificationEmail(organizationInviteMessage({
    organizationName: opts.organizationName,
    inviterName: opts.inviterName,
    role: opts.role,
    inviteUrl,
  }), { platformDomain })

  await sendEmailNotification(env, db, {
    organizationId: opts.organizationId,
    to: opts.email,
    template: 'organization_invited',
    title: `You're invited to join ${opts.organizationName}`,
    delivery: { threadId: null, entryId: entry.id, purpose: 'status_update', idempotencyKey: `organization-invitation-email:${opts.invitationId}:${opts.expiresAt}` },
    payload: {
      invitation_id: opts.invitationId,
      role: opts.role,
      organization_name: opts.organizationName,
      deep_link: inviteUrl,
    },
    email: {
      subject: `You're invited to join ${opts.organizationName} on Krabiclaw`,
      html: rendered.html,
      text: rendered.text,
    },
  })
}

/**
 * Every piece of outbound copy, for /dev/notifications.
 *
 * Email previews come from the single EMAIL_PREVIEWS registry, so a template
 * cannot exist without appearing here — the previous hand-maintained list had
 * silently drifted to covering 14 of 23 templates. WhatsApp copy stays inline
 * because it is approved template text, not a component we render.
 */
export interface CatalogPreviewEntry {
  id: string
  title: string
  audience: 'owner' | 'guest'
  subject: string
  html: string
  text: string
  /** What this event actually sends, for the row that previews it. */
  channels: string[]
  whatsapp: { template: string; text: string } | null
}

/**
 * The catalog, rendered, for /dev/notifications.
 *
 * One entry per event carrying both channels, because the question the page
 * answers is whether they agree — and the WhatsApp side is the approved
 * template's filled slots rather than prose written to stand in for them.
 *
 * The origin comes from the request rather than a constant, so the page shows
 * the assets of the server being looked at. Hardcoding the production domain
 * made every preview load production's images, which cannot show a local
 * change to one.
 */
export async function renderNotificationCatalog(origin: string): Promise<CatalogPreviewEntry[]> {
  const root = origin.trim().replace(/\/$/, '')
  return Promise.all(NOTIFICATION_CATALOG.map(async (entry) => {
    const rendered = await renderNotificationEmail(entry.message, {
      platformDomain: root,
      preferencesUrl: `${root}/dashboard/account/profile/notifications`,
      unsubscribeUrl: entry.message.category === 'account_security'
        ? null
        : `${root}/unsubscribe?user=preview&category=preview&token=preview`,
    })

    let whatsapp: CatalogPreviewEntry['whatsapp'] = null
    if (entry.whatsappTemplate) {
      const { vars } = toWhatsAppVars(entry.message, entry.whatsappTemplate)
      const payload = buildWhatsAppTemplatePayload(entry.whatsappTemplate, vars)
      whatsapp = {
        template: entry.whatsappTemplate,
        text: payload.components
          .flatMap(component => component.parameters.map(parameter => parameter.text))
          .filter(Boolean)
          .join('\n'),
      }
    }

    return {
      id: entry.id,
      title: entry.title,
      audience: entry.audience,
      subject: entry.message.title,
      html: rendered.html,
      text: rendered.text,
      channels: whatsapp ? ['Email', 'WhatsApp'] : ['Email'],
      whatsapp,
    }
  }))
}

/** Cancellation delivery is shared by emailed capabilities and authenticated buyers. */
export async function notifyGuestCancellation(env: NotificationEnv, db: DbClient, cancelled: NonNullable<Awaited<ReturnType<typeof cancelBookingRequest>>>) {
  const request = cancelled.request
  const record = cancelled.record
  const organizationId = request.organization_id
  if (record.kind === 'booking' && !record.product_name?.trim()) throw new Error('Booking cancellation delivery requires its canonical offering')
  await publishGuestInboxThreadEvent(env, db, { threadId: request.id, type: 'thread.changed' })

  const organization = await queryFirst<{ name?: string | null }>(db, 'SELECT name FROM organization WHERE id = ? LIMIT 1', [organizationId])

  if (record.kind === 'booking') {
    await notifyBookingCancelled(env, db, {
      organizationId: request.organization_id, organizationName: organization?.name,
      locale: request.payload.guest.locale,
      locationId: record.location_id, bookingId: request.id, guestName: request.payload.guest.name,
      email: request.payload.guest.email, guestPhone: request.payload.guest.phone,
      productId: record.product_id, productTitle: record.product_name!,
      startsAt: record.starts_at, timezone: record.timezone, partySize: record.party_size,
      notes: request.payload.notes, wasConfirmed: cancelled.wasConfirmed,
    })
  } else {
    const summary = await requestSummary(db, request)
    // The reservation email states a calendar date and a clock time, so the
    // instant is read back in the reservation's own zone rather than the
    // worker's.
    const parts = localPartsAt(new Date(record.starts_at), record.timezone)
    const localDate = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
    const localTime = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
    await notifyReservationCancelled(env, db, {
      organizationId: request.organization_id, organizationName: organization?.name,
      locale: request.payload.guest.locale,
      locationId: record.location_id, locationName: summary.locationTitle, reservationId: request.id,
      guestName: request.payload.guest.name, email: request.payload.guest.email, phone: request.payload.guest.phone,
      date: localDate, time: localTime,
      guests: `${record.party_size}${request.payload.party_size_is_minimum ? '+' : ''}`,
      requests: request.payload.notes, wasConfirmed: cancelled.wasConfirmed,
    })
  }

}
