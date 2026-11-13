import { RESOURCE_LOCALIZATIONS_SQL } from '~/shared/content-registries'
import { createHash } from 'node:crypto'
import { HTTPError } from 'nitro'
import { z } from 'zod'
import { formatFormAnswer, type FormAnswerSnapshot } from '~/shared/form-questions'
import { formatCalendarDate, formatTime, formatTimestamp } from '~/utils/timezone'
import { bookingDay, getGuestRequest, isBookingDay, participantLabel, requestSummary, type cancelBookingRequest, type GuestRequest } from '~/server/domain/requests'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { organizationEventQuery, type OrganizationEventType } from '~/server/utils/organization-events'
import { getEmailDeliveryMode, hashEmail, sendEmail, type EmailSendResult } from '~/server/utils/email-delivery'
import { buildWhatsAppTemplatePayload, sendWhatsAppImage, sendWhatsAppNotification, WhatsAppTemplateRefusal, type SendWhatsAppResult, type WhatsAppTemplate } from '~/server/utils/whatsapp'
import { whatsAppServiceWindowOpen } from '~/server/utils/mcp-context'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { getWhatsAppDeliveryMode } from '~/server/utils/whatsapp-delivery'
import { buildReplyToAddress, type ReplyAs } from '~/server/utils/reply-address'
import { assignedMemberSql, listOrganizationNotificationMembers } from '~/server/utils/member-access'
import { wantsNotification } from '~/server/domain/notification-preferences'
import { listUserDevices, retireDevice, type UserDevice } from '~/server/domain/devices'
import { sendApnsAlert, type ApnsAlert, type ApnsEnv } from '~/server/utils/apns'
import { unreadBadge } from '~/server/domain/guest-threads/repository'
import { sendWebPush, type WebPushEnv } from '~/server/utils/web-push'
import { isRecord } from '~/server/utils/type-guards'
import { buildUnsubscribeUrls } from '~/server/utils/unsubscribe'
import type { NotificationCategory, NotificationChannel } from '~/shared/notification-categories'
import { renderNotificationEmail, type RenderedNotificationEmail } from '~/server/emails/render'
import { toWhatsAppVars } from '~/server/notifications/whatsapp-mapping'
import { NOTIFICATION_CATALOG } from '~/server/notifications/catalog'
import { loadOwnerPictures, organizationLogo } from '~/server/notifications/hero'
import {
  guestBookingCancelledMessage,
  guestBookingReceivedMessage,
  guestContactReceivedMessage,
  guestStayConfirmedMessage,
  organizationInviteMessage,
  reviewRequestMessage,
} from '~/server/notifications/guest-events'
import type { BookingChangeAssignment, BookingChangeEventInput, ConversationRecord } from '~/server/notifications/events'
import type { MemberAlertMessage, NotificationMessage } from '~/server/notifications/messages'
import {
  bookingCancelledMessage,
  bookingChangeMessage,
  bookingChangeWithoutMoney,
  bookingCreatedMessage,
  memberGuestName,
  stayChangeDifferences,
  contactReceivedMessage,
  inquiryReceivedMessage,
  messageReceived,
  reviewReceivedMessage,
  stayBookedMessage,
  stayCancelledMessage,
  stayTurnoverAlert,
  taskAlertMessage,
  REPLY_NOTE,
} from '~/server/notifications/events'
import type { CloudflareEnv } from '~/server/utils/auth'
import { buildOwnerThreadInboxUrl, buildBuyerRequestActivityUrl, dashboardOrigin, destinationUnavailable, getPlatformDomain, platformOrigin, resolveDashboardSlugs } from '~/server/utils/dashboard-notification-links'
import { bookingEditorPath, insightsPath, reviewEditorPath } from '~/server/utils/dashboard-links'
import { createDeliveryReceipt, deliverReceiptEmail, getDeliveryById, isDeliverySent, recordDeliveryOutcome, type DeliverySubject } from '~/server/domain/guest-threads/deliveries'
import { GUEST_NOTE_EVENT, appendMessage, findMessageByDedupeKey, getMessage, parseMessagePayload, type MessageRow } from '~/server/domain/conversations'
import { listMessagePhotos, messagePreview } from '~/server/domain/guest-threads/attachments'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import type { GuestThreadDeliveryPurpose, GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'
import { getPersistedSourceLocale } from '~/server/utils/localization'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { createReplayableReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import { indexStoredPublicLocalizations, type StoredPublicLocalizationRow } from '~/server/utils/public-localization'
import { platformLocale } from '~/shared/platform-locales'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { resolveLocationContact } from '~/server/utils/contact-resolution'
import { formatMinorAmount } from '~/shared/prices'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type { ProductKind } from '~/shared/product-details'
import { STAY_CHANNEL_LABELS } from '~/shared/bookings'
import type { AirbnbInquiry } from '~/server/integrations/channex/live-feed'
import type { ChannelStayTerms } from '~/server/domain/stays'

// The guest chose a label, not a key: on a studio the option keyed `catering`
// reads "Workshops & events", so the label comes from the copy the form shows.
function contactSubjectLabel(subject: string, vertical: string, locale: string) {
  if (subject === 'catering') return getVerticalCopy(vertical, locale).contactSubjectCatering
  return platformLocale(locale)!.messages[`site.contact_page.${subject}`] ?? subject
}

interface NotificationEnv extends CloudflareEnv, ApnsEnv, WebPushEnv {
  RESEND_API_KEY?: string
  WHATSAPP_PHONE_NUMBER_ID?: string
  WHATSAPP_ACCESS_TOKEN?: string
  EMAIL_FROM?: string
  EMAIL_DELIVERY_MODE?: string
  WHATSAPP_DELIVERY_MODE?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
  EMAIL_REPLY_SECRET?: string
  GUEST_INBOX_HUBS?: DurableObjectNamespace
}

interface OrganizationContext {
  organizationId: string
  organizationName?: string | null
  locale?: string
}

interface ContactNotificationInput extends OrganizationContext {
  productTitle?: string | null
  locationId?: string | null
  contactId: string
  guestName: string
  email: string
  phone?: string | null
  subject?: string | null
  message: string
  /** Answers to the organization's inquiry questions, as the guest read them. */
  answers?: FormAnswerSnapshot[]
  consentAcknowledged?: boolean
  /** The site's vertical decides what the subject the guest chose is called. */
  vertical: string
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
  /** What was booked and the site's vertical decide what the guest and the owner call it: a table is a reservation. */
  productKind: ProductKind
  vertical: string | null
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
  /** The guest asked for this many or more ("8+"). */
  partySizeIsMinimum: boolean
  notes?: string | null
  wasConfirmed?: boolean
  receiptUrl?: string | null
  /** What the guest paid on the site for it; null when nothing was paid online. */
  paid?: { amount: number; currency: CurrencyCode } | null
  contactPhone?: string | null
  contactEmail?: string | null
  ownerInboxUrl?: string
}

interface ReviewNotificationInput extends OrganizationContext {
  locationId?: string | null
  reviewId: string
  authorName: string
  rating: number
  content?: string | null
  hasPrivateFeedback?: boolean
  /**
   * The conversation of the visit an invited guest reviewed. Its responsible
   * members hear about the review beside the owners and admins, and read it
   * in Insights; a review with no visit goes to its moderation record.
   */
  visitRequestId?: string
}

interface ReviewRequestNotificationInput extends OrganizationContext {
  locationId?: string | null
  requestId: string
  bookingType: 'booking' | 'stay'
  bookingId: string
  guestName: string
  email: string
  locationName?: string | null
  visitAt: string
  partySize: string
  partyLabel?: string
  reviewUrl: string
  /** Whose review_requests preference governs this email and its unsubscribe link. */
  userId: string
  /** The invitation's message in the visit's conversation, which this email is the receipt of. */
  delivery: { conversationId: string; messageId: string }
}

interface EmailTemplate extends RenderedNotificationEmail {
  subject: string
}

interface ThreadDeliveryContext {
  /** The conversation the send is about, when it is about a message. */
  conversationId: string | null
  subject: DeliverySubject
  purpose: GuestThreadDeliveryPurpose
  idempotencyKey: string
  publishWithMessage?: boolean
}

/** The business is read from the conversation's organization, never passed in. */
interface GuestThreadReplyNotificationInput extends Omit<OrganizationContext, 'organizationName'> {
  locationId?: string | null
  threadId: string
  /** The guest's (or Airbnb Support's) message the alert is about. */
  messageId: string
  submissionType: 'contact' | 'booking' | 'stay'
  submissionId: string
  /** Who the conversation is with: the contact's recorded name, or the channel's title for a channel thread. */
  participantLabel: string
  guestEmail?: string | null
  guestPhone?: string | null
  inboundChannel: 'email' | 'whatsapp' | 'web' | 'airbnb'
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
        FROM ${RESOURCE_LOCALIZATIONS_SQL} rl
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
    tab: 'contact' | 'bookings'
    submissionId: string
  }
): Promise<string> {
  const submissionType = opts.tab === 'contact' ? 'contact' : 'booking'
  const thread = await getGuestRequest(db, opts.submissionId, opts.organizationId, submissionType)
  if (!thread) throw destinationUnavailable('submission_id', opts.submissionId)
  await publishConversationEvent(env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE' })
  return await buildOwnerThreadInboxUrl(env, db, {
    organizationId: opts.organizationId,
    locationId: opts.locationId,
    threadId: thread.id,
  })
}

// Deep-links an owner notification to the review itself: in Insights for a
// visit's review, which its responsible members may read too, or at its own
// level beside the Reviews tab.
async function buildOwnerReviewsUrl(
  env: NotificationEnv,
  db: DbClient,
  opts: { organizationId: string; locationId?: string | null; reviewId: string; visit: boolean }
): Promise<string> {
  const slugs = await resolveDashboardSlugs(env, db, opts)
  return `${platformOrigin(env)}${opts.visit ? insightsPath(slugs.orgSlug, { tab: 'reviews', review: opts.reviewId }) : reviewEditorPath(slugs.orgSlug, opts.reviewId, opts.locationId)}`
}

/**
 * One person this alert reaches, and where.
 *
 * `email` and `phone` are null when that channel is not theirs to receive on —
 * they switched the category off, or they have no verified phone. The account
 * is the address for both: there is no configured number any more, so there is
 * no way to name a recipient the product cannot also identify.
 */
export interface NotificationRecipient {
  userId: string
  email: string | null
  phone: string | null
  /** The footer link a person clicks. */
  unsubscribeUrl: string | null
  /** The RFC 8058 endpoint a mail client POSTs to. */
  unsubscribeOneClickUrl: string | null
  /** The person's signed-in app devices, empty when they switched push off for the category. */
  pushDevices: UserDevice[]
  /** An owner or admin, who reads the whole event; anyone else reads it as the event projects for them. */
  organizationWide: boolean
}

/**
 * Who actually receives this alert, on which channel.
 *
 * Every channel resolves from Better Auth membership and each person's own
 * `user_notification_preferences`; push reaches the devices that person's own
 * signed-in app sessions registered. WhatsApp used to resolve from a number typed
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
    emailPurpose: NotificationMessage['emailPurpose']
    /** The team member a booking is assigned to hears about it alongside the owners. */
    assignedMemberId?: string | null
    memberIds?: string[]
    requestId?: string
    guestMessage?: boolean
  },
): Promise<NotificationRecipient[]> {
  const [members, messagingEnabled] = await Promise.all([
    listOrganizationNotificationMembers(env, opts.organizationId, { includeMemberIds: [...(opts.assignedMemberId ? [opts.assignedMemberId] : []), ...(opts.memberIds ?? [])], requestId: opts.requestId, guestMessage: opts.guestMessage }),
    hasOrganizationEntitlement(env, opts.organizationId, 'messaging'),
  ])
  const recipients = await Promise.all(members.map(async (member) => {
    const [wantsEmail, wantsWhatsApp, pushDevices] = await Promise.all([
      wantsNotification(db, member.userId, opts.category, 'email'),
      messagingEnabled && member.phone ? wantsNotification(db, member.userId, opts.category, 'whatsapp') : Promise.resolve(false),
      wantsNotification(db, member.userId, opts.category, 'push')
        .then(wantsPush => wantsPush ? listUserDevices(db, member.userId) : []),
    ])
    const unsubscribe = wantsEmail ? await buildUnsubscribeUrls(env, { userId: member.userId, category: opts.category }, opts.emailPurpose) : null
    return {
      userId: member.userId,
      email: wantsEmail ? member.email : null,
      phone: wantsWhatsApp ? member.phone : null,
      unsubscribeUrl: unsubscribe?.pageUrl ?? null,
      unsubscribeOneClickUrl: unsubscribe?.oneClickUrl ?? null,
      pushDevices,
      organizationWide: member.organizationWide,
    }
  }))
  return recipients
}

/** The message an email's reply address names: the delivery it is recorded on. */
function requireDeliveryMessage(delivery: ThreadDeliveryContext | null | undefined): string {
  if (!delivery || !('messageId' in delivery.subject)) throw new Error('A reply address names a message, and this email is not the delivery of one')
  return delivery.subject.messageId
}

/** Open apps redraw the conversation a receipt changed. */
async function publishReceipt(env: NotificationEnv, db: DbClient, delivery: ThreadDeliveryContext) {
  if (delivery.conversationId && !delivery.publishWithMessage) await publishConversationEvent(env, db, { conversationId: delivery.conversationId, type: 'MESSAGE_UPDATE' })
}

async function sendEmailNotification(
  env: NotificationEnv,
  db: DbClient,
  opts: Omit<OrganizationContext, 'organizationId'> & { organizationId: string | null } & {
    locationId?: string | null
    to: string
    /** Who a reply to this email speaks as; the address names the delivery's message. */
    replyAs?: ReplyAs
    template: string
    title: string
    payload: Record<string, string>
    email: EmailTemplate
    unsubscribeUrl?: string | null
    unsubscribeOneClickUrl?: string | null
    delivery?: ThreadDeliveryContext | null
  }
): Promise<void> {
  // In provider mode a reserved test address is refused by sendEmail, and the
  // refusal is this Resend delivery's recorded outcome.
  const provider = getEmailDeliveryMode(env) === 'provider' ? 'resend' : 'log_only'
  const deliveryContext = opts.delivery
  const delivery = deliveryContext
    ? await createDeliveryReceipt(db, {
        subject: deliveryContext.subject,
        channel: 'email',
        provider,
        purpose: deliveryContext.purpose,
        idempotencyKey: deliveryContext.idempotencyKey,
      })
    : null
  // The dispatcher resumes the recorded receipt without resending accepted
  // mail. Replays still complete metadata, error clearing and publication.

  const email = {
    to: opts.to, subject: opts.email.subject,
    ...(opts.replyAs ? { replyTo: await buildReplyToAddress(env, requireDeliveryMessage(deliveryContext), opts.replyAs) } : {}),
    html: opts.email.html, text: opts.email.text, emailPurpose: opts.email.emailPurpose,
    unsubscribeOneClickUrl: opts.unsubscribeOneClickUrl ?? null,
  }
  let result: EmailSendResult
  if (delivery) {
    const outcome = await deliverReceiptEmail(db, { env, delivery, threadId: deliveryContext!.conversationId, email }).catch(async (error: unknown) => {
      // The dispatcher writes a failure onto the delivery before raising it, where the thread shows it.
      const recorded = await getDeliveryById(db, delivery.id)
      if (recorded?.error) throw new RecordedDeliveryFailure(`Email delivery failed: ${recorded.error}`, { cause: error })
      throw error
    })
    if (isDeliverySent(outcome)) {
      if (!outcome.provider_message_id) throw new Error('Sent email delivery has no provider identity')
      result = { status: 'sent', messageId: outcome.provider_message_id }
    } else {
      if (!outcome.error) throw new Error('Incomplete email delivery has no recorded failure reason')
      result = { status: 'failed', code: 'EMAIL_DELIVERY_FAILED', error: outcome.error }
    }
  } else result = await sendEmail(env, email)
  if (deliveryContext) await publishReceipt(env, db, deliveryContext)
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
  if (delivery) throw new RecordedDeliveryFailure(`Email delivery failed: ${result.error}`)
  throw new Error(`Email delivery failed: ${result.error}`)
}

async function sendWhatsAppThreadNotification(
  env: NotificationEnv,
  db: DbClient,
  opts: { delivery: ThreadDeliveryContext; send: () => Promise<SendWhatsAppResult> },
): Promise<boolean> {
  const delivery = await createDeliveryReceipt(db, {
    subject: opts.delivery.subject,
    channel: 'whatsapp',
    provider: getWhatsAppDeliveryMode(env) === 'provider' ? 'meta' : 'log_only',
    purpose: opts.delivery.purpose,
    idempotencyKey: opts.delivery.idempotencyKey,
  })
  if (isDeliverySent(delivery) || delivery.status === 'skipped') return true

  const result = await opts.send()
  await recordDeliveryOutcome(db, {
    deliveryId: delivery.id,
    status: result.status,
    providerMessageId: result.status === 'sent' ? result.messageId ?? null : null,
    error: result.status === 'skipped' ? result.reason : result.success ? null : result.error,
  })
  await publishReceipt(env, db, opts.delivery)
  return result.success
}

/**
 * A push to any device: the app reads `data`, a browser opens `url`. The link is
 * built only for a browser and inside its send, so a link that cannot be built
 * is that browser's recorded failure and never stops a phone's alert.
 */
type PushAlert = Omit<ApnsAlert, 'badge'> & {
  url: () => Promise<string>
  /** The message's first photo. A browser shows it; the app's alerts carry text, as APNs shows nothing else without a notification service extension. */
  image: string | null
}

type PushDispatch =
  | { status: 'sent'; providerMessageId: string | null }
  | { status: 'failed'; error: string; deviceGone: boolean }

/** The device's own push service: Apple for the app, the browser's push service for a subscription. */
async function dispatchPush(env: NotificationEnv, db: DbClient, userId: string, device: UserDevice, alert: PushAlert): Promise<PushDispatch> {
  if (device.kind === 'apns') {
    const apnsId = crypto.randomUUID()
    // Read when it is sent, after the notification it announces was recorded, so the icon counts it.
    const result = await sendApnsAlert(env, { deviceToken: device.token, environment: device.environment, apnsId, alert: { title: alert.title, body: alert.body, threadId: alert.threadId, data: alert.data, badge: await unreadBadge(db, userId) } })
    return result.status === 'sent' ? { status: 'sent', providerMessageId: apnsId } : { status: 'failed', error: result.error, deviceGone: result.tokenRetired }
  }
  const result = await sendWebPush(env, {
    subscription: { endpoint: device.token, p256dh: device.p256dh, auth: device.auth },
    alert: { title: alert.title, body: alert.body, url: await alert.url(), tag: alert.threadId, image: alert.image },
  })
  return result.status === 'sent' ? { status: 'sent', providerMessageId: result.messageId } : { status: 'failed', error: result.error, deviceGone: result.subscriptionGone }
}

/**
 * One push to one device, recorded on that device's own delivery.
 *
 * Every outcome is written before it is raised: missing configuration, a
 * request that never reached the push service, and the service's own answer. A
 * device its push service reports gone is removed, and its delivery still
 * records the failure.
 */
async function sendPushThreadNotification(
  env: NotificationEnv,
  db: DbClient,
  opts: { userId: string; device: UserDevice; alert: PushAlert; delivery: ThreadDeliveryContext },
): Promise<void> {
  const delivery = await createDeliveryReceipt(db, {
    subject: opts.delivery.subject,
    channel: 'push',
    provider: opts.device.kind === 'apns' ? 'apns' : 'web_push',
    purpose: opts.delivery.purpose,
    idempotencyKey: opts.delivery.idempotencyKey,
  })
  if (isDeliverySent(delivery)) return

  const record = async (outcome: { status: 'sent'; providerMessageId: string | null } | { status: 'failed'; error: string }) => {
    await recordDeliveryOutcome(db, { deliveryId: delivery.id, ...outcome })
    await publishReceipt(env, db, opts.delivery)
  }
  let result: PushDispatch
  try {
    result = await dispatchPush(env, db, opts.userId, opts.device, opts.alert)
  } catch (error) {
    const code = HTTPError.isError(error) && isRecord(error.data) && typeof error.data.code === 'string' ? `${error.data.code}: ` : ''
    await record({ status: 'failed', error: `${code}${error instanceof Error ? error.message : String(error)}` })
    throw new RecordedDeliveryFailure(`Push delivery failed: ${code}${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (result.status === 'sent') {
    await record({ status: 'sent', providerMessageId: result.providerMessageId })
    return
  }
  if (result.deviceGone) await retireDevice(db, { userId: opts.userId, device: opts.device })
  await record({ status: 'failed', error: result.deviceGone ? `${result.error}; device removed` : result.error })
  throw new RecordedDeliveryFailure(`Push delivery failed: ${result.error}`)
}

/** A page inside the organization's dashboard. */
async function dashboardPathUrl(env: NotificationEnv, db: DbClient, organizationId: string, path: string): Promise<string> {
  return `${dashboardOrigin(env, await resolveDashboardSlugs(env, db, { organizationId }))}${path}`
}

/** What a push opens: a conversation, a stay, a task, or a page. */
type MemberNotificationTarget =
  | { kind: 'guest' | 'team'; conversation_id: string }
  | { kind: 'stay'; booking_id: string }
  | { kind: 'task'; task_id: string }
  | { kind: 'link'; url: string }

/** Every member alert uses the same channel delivery and receipt implementation. */
function memberNotificationSends(
  env: NotificationEnv,
  db: DbClient,
  recipient: NotificationRecipient,
  input: OrganizationContext & {
    locationId?: string | null
    context: DeliveryAnchor
    template: string
    pushTemplate: string
    whatsappTemplate: WhatsAppTemplate | null
    payload: Record<string, string>
    message: MemberAlertMessage
    target: MemberNotificationTarget
    eventKey?: string
  },
): Array<Promise<unknown>> {
  const sends: Array<Promise<unknown>> = []
  if (recipient.email) {
    const to = recipient.email
    sends.push((async () => {
      const rendered = await renderNotificationEmail(input.message, {
        platformDomain: getPlatformDomain(env),
        preferencesUrl: `https://${getPlatformDomain(env)}/dashboard/account/profile/notifications`,
        unsubscribeUrl: recipient.unsubscribeUrl,
      })
      // Only an email that says it can be answered carries a reply address: an alert about a new booking or cancellation does not send the member's reply to the guest.
      await sendEmailNotification(env, db, {
        ...input, to, title: input.message.title,
        ...(input.message.finePrint === REPLY_NOTE ? { replyAs: { kind: 'member' as const, userId: recipient.userId } } : {}),
        email: { subject: sanitizeEmailHeaderValue(input.message.title), ...rendered },
        unsubscribeOneClickUrl: recipient.unsubscribeOneClickUrl,
        delivery: threadDelivery(input.context, 'owner_alert', 'email', input.template, to, input.eventKey),
      })
    })())
  }
  if (recipient.phone && input.whatsappTemplate) {
    const toPhone = recipient.phone
    const template = input.whatsappTemplate
    const mapped = toWhatsAppVars(input.message, template)
    if (mapped.omitted.length) console.info('whatsapp_facts_omitted', { template, omitted: mapped.omitted })
    sends.push((async () => {
      if (!await sendWhatsAppThreadNotification(env, db, {
        delivery: threadDelivery(input.context, 'owner_alert', 'whatsapp', template, toPhone, input.eventKey),
        send: () => sendWhatsAppNotification(env, { organizationId: input.organizationId, locationId: input.locationId ?? null, toPhone, template, vars: mapped.vars }),
      })) throw new RecordedDeliveryFailure(`WhatsApp notification was not delivered for organization ${input.organizationId}`)
      // No approved template has an image header, so the message's photos follow it as images,
      // which Meta delivers only while the member's 24-hour service window is open.
      const photos = input.message.quote?.photos ?? []
      if (!photos.length || !await whatsAppServiceWindowOpen(db, recipient.userId)) return
      for (const [index, photo] of photos.entries()) {
        if (!await sendWhatsAppThreadNotification(env, db, {
          delivery: threadDelivery(input.context, 'owner_alert', 'whatsapp', `${template}:photo:${index}`, toPhone, input.eventKey && `${input.eventKey}:photo:${index}`),
          send: () => sendWhatsAppImage(env, { organizationId: input.organizationId, toPhone, imageUrl: photo.imageUrl }),
        })) throw new RecordedDeliveryFailure(`WhatsApp photo was not delivered for organization ${input.organizationId}`)
      }
    })())
  }
  sends.push(...recipient.pushDevices.map(device => sendPushThreadNotification(env, db, {
    userId: recipient.userId, device,
    delivery: threadDelivery(input.context, 'owner_alert', 'push', input.pushTemplate, device.token, input.eventKey),
    alert: {
      title: input.message.title, body: input.message.preheader,
      image: input.message.quote?.photos[0]?.imageUrl ?? null,
      url: async () => input.message.primaryAction.url,
      threadId: input.target.kind === 'guest' || input.target.kind === 'team' ? input.target.conversation_id : null,
      data: { organization_id: input.organizationId, user_id: recipient.userId, ...input.target },
    },
  })))
  return sends
}

/** A new conversation's alerts are the deliveries of its first message: the guest's words, or the booking's opening. */
async function getOpeningThreadContext(db: DbClient, conversationId: string): Promise<DeliveryAnchor> {
  const first = await queryFirst<{ id: string }>(db, `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ? AND c.kind IN ('contact', 'booking') ORDER BY m.sequence LIMIT 1`, [conversationId])
  if (!first) throw new Error(`Conversation ${conversationId} has no first message for its alert`)
  return { conversationId, subject: { messageId: first.id } }
}

/** What a send is recorded on: a message of a conversation, an audit row, or a task. */
type DeliveryAnchor = { conversationId: string | null; subject: DeliverySubject; publishWithMessage?: boolean }
const anchorId = (subject: DeliverySubject) => 'messageId' in subject ? subject.messageId : 'activityEntryId' in subject ? subject.activityEntryId : subject.taskId

/**
 * An alert about no conversation (a payout, a domain, a channel's change to a
 * stay) is recorded on the audit row that says the owner was told, keyed by
 * the event, so a replay finds the same row and sends nothing twice.
 */
async function auditAnchor(db: DbClient, input: { organizationId: string; eventKey: string; template: string; entityType: string; entityId: string; locationId?: string | null }): Promise<DeliveryAnchor> {
  const dedupeKey = `alert:${input.eventKey}`
  const audit = organizationEventQuery({ organizationId: input.organizationId, locationId: input.locationId ?? null, actorType: 'system', eventType: 'owner.alerted' satisfies OrganizationEventType,
    entityType: input.entityType, entityId: input.entityId, dedupeKey, metadata: { template: input.template } })
  await execute(db, `${audit.query} ON CONFLICT(dedupe_key) DO NOTHING`, audit.params)
  const entry = await queryFirst<{ id: string }>(db, 'SELECT id FROM activity_entries WHERE dedupe_key = ? AND organization_id = ?', [dedupeKey, input.organizationId])
  if (!entry) throw new Error(`The alert ${input.eventKey} has no audit row to record its deliveries on`)
  return { conversationId: null, subject: { activityEntryId: entry.id } }
}
function threadDelivery(context: DeliveryAnchor, purpose: GuestThreadDeliveryPurpose, channel: NotificationChannel, template: string, recipient: string, eventKey?: string): ThreadDeliveryContext
function threadDelivery(context: DeliveryAnchor | null, purpose: GuestThreadDeliveryPurpose, channel: NotificationChannel, template: string, recipient: string, eventKey?: string): ThreadDeliveryContext | null
function threadDelivery(
  context: DeliveryAnchor | null,
  purpose: GuestThreadDeliveryPurpose,
  channel: NotificationChannel,
  template: string,
  recipient: string,
  eventKey?: string,
): ThreadDeliveryContext | null {
  if (!context) return null
  return {
    conversationId: context.conversationId,
    subject: context.subject,
    publishWithMessage: context.publishWithMessage,
    purpose,
    idempotencyKey: eventKey
      ? createHash('sha256').update(JSON.stringify([eventKey, purpose, channel, hashEmail(recipient)])).digest('hex')
      : `${anchorId(context.subject)}:${purpose}:${channel}:${template}:${hashEmail(recipient)}`,
  }
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
  raiseFailures(label, context, results.map((result, index) => ({ result, task: tasks[index] ?? String(index) })))
}

/** A send whose failure is already written on its delivery row, where the thread shows it. */
export class RecordedDeliveryFailure extends Error {}

/**
 * The owner's alerts for something a guest did. A send that failed is recorded
 * on its delivery row and shown on the thread, and it does not fail what the
 * guest did: the reservation, booking or reply stands. Anything not recorded —
 * the alert could not even be prepared — is raised.
 */
function raiseUnrecordedOwnerAlertFailures(label: string, context: string, sends: Array<{ result: PromiseSettledResult<unknown>; task: string }>): void {
  raiseFailures(label, context, sends.filter(({ result }) => !(result.status === 'rejected' && result.reason instanceof RecordedDeliveryFailure)))
}

function raiseFailures(label: string, context: string, sends: Array<{ result: PromiseSettledResult<unknown>; task: string }>): void {
  const results = sends.map(send => send.result)
  const tasks = sends.map(send => send.task)
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

// An alert about a booking's schedule opens the booking, not its conversation.
const scheduleEvents = ['new_reservation', 'new_booking', 'new_stay', 'reservation_cancelled', 'booking_cancelled', 'stay_cancelled']
const schedulePrefixes = ['channel_stay.', 'booking.change_', 'reservation.change_', 'stay.change_', 'consultation.change_']
const isScheduleNotification = (event: string) => scheduleEvents.includes(event) || schedulePrefixes.some(prefix => event.startsWith(prefix))

export async function notifyOwner(
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
    message: MemberAlertMessage
    /** The approved template the same facts are mapped onto. */
    whatsappTemplate?: WhatsAppTemplate
    submissionType?: 'contact' | 'booking' | 'invitation' | null
    submissionId?: string | null
    /** The message the alert is about; its deliveries are that message's. */
    source?: { conversationId: string; messageId: string }
    /**
     * Keys an alert about no conversation: its deliveries are recorded on the
     * audit row that says the owner was told about `entity`.
     */
    idempotencyKey?: string
    entity?: { type: string; id: string }
    /** Native financial event identity, independent of later buyer linking. */
    deliveryEventKey?: string
    /** A webhook caller can finish a recorded failed send on its next delivery. */
    surfaceDeliveryFailures?: boolean
    /** Explicit assignment audience from the event snapshot. When supplied, no later assignee is inferred. */
    memberIds?: string[]
    /** KrabiClaw operator addresses copied on operational mail: routing, not a person's preference, so no opt-out link. */
    operatorEmails?: string[]
    /** A conversation whose responsible members are recipients, without the event being a fact on it. */
    responsibleRequestId?: string
    /**
     * The same event as members who are not owners or admins receive it, built
     * by the same message builder from the facts they may read, and the stay it
     * opens for them. Without one, every recipient reads `message`.
     */
    memberAlert?: { message: MemberAlertMessage; stayId: string }
    /** The stay an event without a conversation is about, which every recipient's push opens. */
    stayId?: string
  }
) {
  const opening = opts.source ? null : opts.submissionType && opts.submissionType !== 'invitation' && opts.submissionId ? opts.submissionId : null
  const threadContext: DeliveryAnchor | null = opts.source
    ? { conversationId: opts.source.conversationId, subject: { messageId: opts.source.messageId } }
    : opening ? await getOpeningThreadContext(db, opening) : null
  const stayId = opts.stayId ?? opts.memberAlert?.stayId
  let scheduleUrl: string | null = null
  if (isScheduleNotification(opts.template)) {
    const { orgSlug } = await resolveDashboardSlugs(env, db, { organizationId: opts.organizationId })
    if (stayId) scheduleUrl = bookingEditorPath(orgSlug, 'stay', stayId)
    else if (threadContext?.conversationId && opts.submissionType === 'booking') {
      scheduleUrl = bookingEditorPath(orgSlug, opts.submissionType, threadContext.conversationId)
    } else throw new Error(`Schedule notification ${opts.template} has no booking destination`)
    scheduleUrl = new URL(scheduleUrl, dashboardOrigin(env, { orgSlug, locationSlug: null })).href
  }
  let deliveryContext: DeliveryAnchor
  if (threadContext) deliveryContext = threadContext
  else {
    if (!opts.idempotencyKey || !opts.entity) throw new Error(`Alert ${opts.template} is about no conversation and names no event to record its deliveries on`)
    deliveryContext = await auditAnchor(db, { organizationId: opts.organizationId, eventKey: opts.idempotencyKey, template: opts.template, entityType: opts.entity.type, entityId: opts.entity.id, locationId: opts.locationId })
  }

  // Owners and admins hear about every booking; the member it is assigned to hears about theirs.
  const assigned = opts.memberIds === undefined && opts.submissionType === 'booking' && opts.submissionId
    ? await queryFirst<{ assigned_member_id: string | null }>(db, `SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.organization_id = b.organization_id AND c.product_id = b.product_id
      WHERE b.organization_id = ? AND (b.id = (SELECT booking_id FROM conversations WHERE id = ?) OR b.id = ?) LIMIT 1`, [opts.organizationId, opts.submissionId, opts.submissionId])
    : null
  const recipients = await resolveOwnerRecipients(env, db, {
    organizationId: opts.organizationId,
    category: opts.message.category,
    emailPurpose: opts.message.emailPurpose,
    assignedMemberId: assigned?.assigned_member_id ?? null,
    memberIds: opts.memberIds ?? [],
    requestId: threadContext?.conversationId ?? opts.responsibleRequestId,
    guestMessage: opts.message.category === 'messages',
  })

  // The owner reads mail sent for their business, framed by its own mark.
  const organizationLogoUrl = await organizationLogo(db, opts.organizationId)
  const message = {
    ...opts.message, organizationLogoUrl,
    primaryAction: scheduleUrl ? { ...opts.message.primaryAction, url: scheduleUrl } : opts.message.primaryAction,
  }
  const memberMessage = opts.memberAlert ? { ...opts.memberAlert.message, organizationLogoUrl } : message

  const results = await Promise.allSettled(recipients.flatMap(recipient => {
    const projected = !recipient.organizationWide && opts.memberAlert !== undefined
    const read = projected ? memberMessage : message
    return memberNotificationSends(env, db, recipient, {
      ...opts, message: read,
      context: deliveryContext,
      pushTemplate: opts.template, whatsappTemplate: opts.whatsappTemplate ?? null,
      eventKey: opts.deliveryEventKey,
      target: stayId ? { kind: 'stay', booking_id: stayId }
        : !scheduleUrl && deliveryContext.conversationId ? { kind: 'guest', conversation_id: deliveryContext.conversationId }
          : { kind: 'link', url: read.primaryAction.url },
    })
  }))
  const memberEmails = new Set(recipients.map(recipient => recipient.email?.toLowerCase()))
  const operatorEmails = [...new Set(opts.operatorEmails ?? [])].filter(to => !memberEmails.has(to.toLowerCase()))
  const operatorResults = await Promise.allSettled(operatorEmails.map(async (to) => {
    const rendered = await renderNotificationEmail(message, {
      platformDomain: getPlatformDomain(env),
      preferencesUrl: `https://${getPlatformDomain(env)}/dashboard/account/profile/notifications`,
      unsubscribeUrl: null,
    })
    await sendEmailNotification(env, db, {
      ...opts,
      to,
      email: { subject: sanitizeEmailHeaderValue(message.title), ...rendered },
      delivery: threadDelivery(deliveryContext, 'owner_alert', 'email', opts.template, to, opts.deliveryEventKey),
    })
  }))
  const sends = [...results.map(result => ({ result, task: 'ownerAlert' })), ...operatorResults.map(result => ({ result, task: 'operatorCopy' }))]
  const reportFailures = opts.surfaceDeliveryFailures ? raiseFailures : raiseUnrecordedOwnerAlertFailures
  reportFailures('notifyOwner', `organization ${opts.organizationId}`, sends)
}

/**
 * Financial status mail on the canonical delivery ledger: about a booking's
 * payment it is the deliveries of the payment's message in the booking's
 * conversation; otherwise (a payout, a payment no conversation holds) of the
 * audit row that records the owner was told.
 */
export async function notifyFinancialNotification(
  env: NotificationEnv,
  db: DbClient,
  input: {
    organizationId: string | null
    eventKey: string
    ownerMessage?: MemberAlertMessage
    guest?: { email: string | null; message: NotificationMessage }
    /** The payment's message in its booking's conversation. */
    source?: { conversationId: string; messageId: string } | null
    /** What the event is about, for the audit row of an event no conversation holds. */
    entity?: { type: string; id: string }
    deepLink?: string | null
  },
): Promise<void> {
  if (!input.eventKey.trim()) throw new Error('Financial notification requires its native event identity')
  const anchor = async (): Promise<DeliveryAnchor> => {
    if (input.source) return { conversationId: input.source.conversationId, subject: { messageId: input.source.messageId } }
    if (!input.organizationId || !input.entity) throw new Error(`Financial mail ${input.eventKey} has neither a conversation message nor an organization event to record its deliveries on`)
    return await auditAnchor(db, { organizationId: input.organizationId, eventKey: `${input.eventKey}:owner`, template: input.eventKey, entityType: input.entity.type, entityId: input.entity.id })
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
      payload: { deep_link: input.deepLink ?? input.ownerMessage.primaryAction.url },
      message: input.ownerMessage,
      source: input.source ?? undefined,
      idempotencyKey: `${input.eventKey}:owner`,
      entity: input.entity,
      deliveryEventKey: `${input.eventKey}:owner`,
    }))
    taskNames.push('merchant')
  }
  if (input.guest?.email) {
    const guest = input.guest
    const to = input.guest.email
    tasks.push((async () => {
      const rendered = await renderNotificationEmail(guest.message, {
        platformDomain: getPlatformDomain(env),
      })
      await sendEmailNotification(env, db, {
        organizationId: input.organizationId, organizationName: guest.message.organizationName,
        to, template: input.eventKey, title: guest.message.title, payload: {},
        email: { subject: sanitizeEmailHeaderValue(guest.message.title), ...rendered },
        delivery: threadDelivery(await anchor(), 'status_update', 'email', input.eventKey, to, `${input.eventKey}:buyer`),
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

export async function notifyContactSubmitted(
  env: NotificationEnv,
  db: DbClient,
  opts: ContactNotificationInput
) {
  const restaurant = organizationName(opts)
  const platformDomain = getPlatformDomain(env)
  const inboxUrl = await buildOwnerInboxUrl(env, db, {
    organizationId: opts.organizationId,
    locationId: opts.locationId,
    tab: 'contact',
    submissionId: opts.contactId,
  })
  const threadContext = await getOpeningThreadContext(db, opts.contactId)
  // An inquiry's answers are part of what the guest said: they travel with the message on every channel.
  const answerLines = (words: { yes: string; no: string }) => (opts.answers ?? []).map(answer => `${answer.label}: ${formatFormAnswer(answer, words)}`)
  const ownerText = [opts.message, ...answerLines({ yes: 'Yes', no: 'No' }), opts.phone ? `Phone: ${opts.phone}` : ''].filter(Boolean).join('\n')
  const payload = {
    contact_id: opts.contactId,
    guest_name: opts.guestName,
    email: opts.email,
    subject: opts.subject ?? '',
    message_preview: ownerText.slice(0, 200),
    organization_name: restaurant,
    experience_title: opts.productTitle ?? '',
    consent_acknowledged: opts.consentAcknowledged === true ? 'true' : 'false',
    deep_link: inboxUrl ?? '',
  }

  const ownerMessage = contactReceivedMessage({
    guestName: opts.guestName, guestEmail: opts.email,
    subject: contactSubjectLabel(opts.subject ?? 'general', opts.vertical, 'en'),
    message: ownerText, productTitle: opts.productTitle ?? null,
    organizationName: restaurant, consentAcknowledged: Boolean(opts.consentAcknowledged), replyUrl: inboxUrl,
  })
  const guest = await guestPresentation(db, opts)
  const subjectLabel = opts.subject ? contactSubjectLabel(opts.subject, opts.vertical, guest.locale) : null
  const guestMessage = guestContactReceivedMessage({
    ...guest,
    guestName: opts.guestName, organizationLogoUrl: await organizationLogo(db, opts.organizationId),
    subject: subjectLabel,
    productTitle: guest.productTitle, message: opts.message, answers: opts.answers ?? [],
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
      replyAs: { kind: 'guest' },
      template: 'contact_customer_received',
      title: guestMessage.title,
      payload,
      email: { subject: guestMessage.title, ...guestEmail },
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
    visit: opts.visitRequestId !== undefined,
  })

  const ownerMessage = reviewReceivedMessage({
    authorName: opts.authorName,
    rating: opts.rating,
    content: opts.content ?? '',
    hasPrivateFeedback: opts.hasPrivateFeedback,
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
    entity: { type: 'review', id: opts.reviewId },
    responsibleRequestId: opts.visitRequestId,
  })
}

export async function notifyReviewRequest(
  env: NotificationEnv,
  db: DbClient,
  opts: ReviewRequestNotificationInput
): Promise<void> {
  // The invitation owns one email, even if contact details are edited while
  // completion is pending. Retain any already-recorded receipt for this link.
  const recorded = await queryFirst<{ id: string }>(db, `
    SELECT id FROM guest_thread_deliveries
    WHERE message_id = ? AND channel = 'email' AND purpose = 'status_update'
      AND (email_json IS NULL OR instr(email_json, ?) > 0)
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, [opts.delivery.messageId, new URL(opts.reviewUrl).searchParams.get('token')])
  const restaurant = organizationName(opts)
  const platformDomain = getPlatformDomain(env)
  const logoUrl = await organizationLogo(db, opts.organizationId)
  const message = reviewRequestMessage({
    guestName: opts.guestName,
    organizationName: restaurant,
    locationName: opts.locationName ?? null,
    visitAt: opts.visitAt,
    partySize: opts.partySize,
    partyLabel: opts.partyLabel,
    reviewUrl: opts.reviewUrl,
    organizationLogoUrl: logoUrl,
  })
  const unsubscribe = await buildUnsubscribeUrls(env, { userId: opts.userId, category: message.category }, message.emailPurpose)
  if (!unsubscribe) throw new Error('Review requests require email unsubscribe links')
  const email = await renderNotificationEmail(message, { platformDomain, unsubscribeUrl: unsubscribe.pageUrl })

  await sendEmailNotification(env, db, {
    ...opts,
    to: opts.email,
    replyAs: { kind: 'guest' },
    template: 'booking_thank_you_review_request',
    title: `How was your visit to ${restaurant}?`,
    delivery: { conversationId: opts.delivery.conversationId, subject: { messageId: opts.delivery.messageId }, purpose: 'status_update', idempotencyKey: recorded?.id ?? `review-request:${opts.requestId}` },
    payload: {
      request_id: opts.requestId,
      booking_type: opts.bookingType,
      booking_id: opts.bookingId,
      guest_name: opts.guestName,
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
      ...email,
    },
  })
}

/**
 * What a booking is called and pictured as, from what was booked: a table is a
 * reservation led by its place's picture, anything else a booking led by the
 * offering's own. The owner reads where it is in English, from the location.
 */
async function bookingFrame(db: DbClient, opts: BookingNotificationInput) {
  const presentation = resolveBookingPresentation(opts.productKind, opts.vertical)
  const [hero, location] = await Promise.all([
    messageHero(db, opts.organizationId, opts.productKind === 'table' ? { type: 'business_location', id: opts.locationId } : { type: 'product', id: opts.productId }),
    opts.locationId ? queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE organization_id = ? AND id = ?', [opts.organizationId, opts.locationId]) : null,
  ])
  if (opts.locationId && !location) throw new Error(`Booking ${opts.bookingId} names a missing location`)
  return {
    presentation, hero, locationName: location?.title ?? null,
    partySize: presentation.formatCount(opts.partySize, opts.partySizeIsMinimum),
    wording: presentation.noun === 'reservation' ? 'reservation' as const : 'booking' as const,
  }
}

export async function notifyBookingCreated(
  env: NotificationEnv,
  db: DbClient,
  /** The answers the guest gave when booking, which are on the booking. */
  opts: BookingNotificationInput & { status: 'pending' | 'confirmed'; answers: FormAnswerSnapshot[] }
) {
  const studio = organizationName(opts)
  const prettyDate = new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone, dateStyle: 'medium' }).format(new Date(opts.startsAt))
  const prettyTime = formatTimestamp(opts.startsAt, 'en', opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const platformDomain = getPlatformDomain(env)
  const inboxUrl = opts.ownerInboxUrl !== undefined
    ? opts.ownerInboxUrl
    : await buildOwnerInboxUrl(env, db, {
        organizationId: opts.organizationId,
        locationId: opts.locationId,
        tab: 'bookings',
        submissionId: opts.bookingId,
      })
  const threadContext = await getOpeningThreadContext(db, opts.bookingId)

  const payload = {
    booking_id: opts.bookingId,
    guest_name: opts.guestName,
    email: opts.email,
    experience: opts.productTitle,
    starts_at: opts.startsAt,
    timezone: opts.timezone,
    party_size: `${opts.partySize}${opts.partySizeIsMinimum ? '+' : ''}`,
    requests: opts.notes ?? '',
    organization_name: studio,
    deep_link: inboxUrl ?? '',
  }

  const [{ presentation, hero, locationName, partySize: formattedPartySize, wording }, logoUrl] = await Promise.all([
    bookingFrame(db, opts),
    organizationLogo(db, opts.organizationId),
  ])
  const ownerMessage = bookingCreatedMessage({
    guestName: opts.guestName, guestEmail: opts.email, guestPhone: opts.guestPhone ?? null,
    date: prettyDate, day: formatTimestamp(opts.startsAt, 'en-US', opts.timezone, { month: 'short', day: 'numeric' }), time: prettyTime, partySize: formattedPartySize,
    locationName, organizationName: studio, productTitle: opts.productTitle,
    presentation, status: opts.status,
    notes: opts.notes ?? null, heroImageUrl: hero?.imageUrl ?? null, replyUrl: inboxUrl,
    paid: opts.paid ? formatMinorAmount(opts.paid.amount, opts.paid.currency, 'en-US') : null,
    answers: opts.answers,
  })
  const guest = await guestPresentation(db, opts)
  const copy = getVerticalCopy(opts.vertical, guest.locale)
  const guestMessage = guestBookingReceivedMessage({
    ...guest, manageUrl: await buildBuyerRequestActivityUrl(env, db, { organizationId: opts.organizationId, threadId: opts.bookingId }),
    guestName: opts.guestName, organizationLogoUrl: logoUrl, status: opts.status, wording,
    productTitle: guest.productTitle!,
    date: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { dateStyle: 'medium' }),
    time: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    partySize: formattedPartySize,
    partyLabel: copy.guestsLabel,
    notes: opts.notes, contactPhone: opts.contactPhone ?? null, contactEmail: opts.contactEmail ?? null,
    receiptUrl: opts.receiptUrl ?? null, heroImageUrl: hero?.imageUrl ?? null,
    paid: opts.paid ? formatMinorAmount(opts.paid.amount, opts.paid.currency, guest.locale) : null,
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
      replyAs: { kind: 'guest' },
      template: 'booking_customer_received',
      title: guestTitle,
      payload,
      email: { subject: guestTitle, ...guestEmail },
      delivery: threadDelivery(threadContext, 'guest_acknowledgement', 'email', 'booking_customer_received', opts.email),
    })]),
  ])

  raiseSettledFailures('notifyBookingCreated', `bookingId ${opts.bookingId}`, results)
}

/**
 * A stay a guest booked and paid for on the site: the host (owners, admins and
 * the member who looks after the home) by email, WhatsApp-free alert and push;
 * the guest by a confirmation email in the site's language with the dates,
 * times, guests, what they paid and the home's check-in instructions.
 */
/**
 * A stay alert's member audience: the members responsible for its home, by
 * member or team, who read it as the turnover (`stayTurnoverAlert`) and open
 * the stay rather than its guest conversation.
 */
async function stayTurnoverAudience(env: NotificationEnv, db: DbClient, organizationId: string, stay: { id: string; product_id: string; starts_at: string; timezone: string }, checkInTime: string | null) {
  const responsible = await queryAll<{ id: string }>(db, `SELECT m.id FROM member m JOIN product_booking_configs c ON c.organization_id = m.organizationId
    WHERE c.organization_id = ? AND c.product_id = ? AND ${assignedMemberSql('c', 'm.userId')}`, [organizationId, stay.product_id])
  // The arrival the host recorded: the stay's start when it is not the home's check-in time.
  const arrival = isBookingDay(stay.starts_at) ? null : new Intl.DateTimeFormat('en-GB', { timeZone: stay.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(stay.starts_at))
  return {
    memberIds: responsible.map(member => member.id),
    stayUrl: await dashboardPathUrl(env, db, organizationId, `/bookings/${encodeURIComponent(stay.id)}`),
    arrival: arrival === null || arrival === checkInTime ? null : formatTime(arrival, 'en-US'),
  }
}

/** The note a guest left when booking: their message in the booking's conversation. */
async function guestNote(db: DbClient, conversationId: string): Promise<string | null> {
  return (await queryFirst<{ body: string | null }>(db, "SELECT body FROM messages WHERE conversation_id = ? AND event_name = 'thread.guest_note' ORDER BY sequence LIMIT 1", [conversationId]))?.body ?? null
}

/** Who is staying, as the host reads it: "2 adults, 1 child". */
export function stayParty(stay: { adults: number; children: number; infants: number }): string {
  return [`${stay.adults} adult${stay.adults === 1 ? '' : 's'}`, ...(stay.children ? [`${stay.children} child${stay.children === 1 ? '' : 'ren'}`] : []), ...(stay.infants ? [`${stay.infants} infant${stay.infants === 1 ? '' : 's'}`] : [])].join(', ')
}

const stayNights = (stay: { check_in_date: string; check_out_date: string }) =>
  Math.round((Date.parse(`${stay.check_out_date}T00:00:00Z`) - Date.parse(`${stay.check_in_date}T00:00:00Z`)) / 86_400_000)

/**
 * A stay its channel sent as it happened: a new booking, a change, a
 * cancellation, or a booking on nights another stay holds. The reservations a
 * home's import loads arrive through the same path and are not told; the
 * caller knows which they are. Each revision is told once, keyed by its own
 * identity, from the terms it recorded before and after itself — never from
 * the stay as a later revision has since left it — and only for what it
 * changed: a revision that restates the stay, as a re-import does, sends nothing.
 */
export async function notifyChannelStay(env: NotificationEnv, db: DbClient, organizationId: string, input: { stayId: string; revisionId: string; previous: ChannelStayTerms | null; terms: ChannelStayTerms }) {
  const { readCheckoutStay } = await import('~/server/domain/stays')
  const stay = await readCheckoutStay(db, organizationId, input.stayId)
  const { previous, terms } = input
  const cancelled = terms.status === 'cancelled' && previous !== null && previous.status !== 'cancelled'
  const booked = terms.status !== 'cancelled' && (previous === null || previous.status === 'cancelled')
  const overlap = terms.overbooked && !previous?.overbooked
  const changed = !booked && !cancelled && previous !== null && terms.status !== 'cancelled'
    && (previous.check_in_date !== terms.check_in_date || previous.check_out_date !== terms.check_out_date || previous.product_id !== terms.product_id
      || previous.adults !== terms.adults || previous.children !== terms.children || previous.infants !== terms.infants || previous.total_minor !== terms.total_minor)
  if (!booked && !cancelled && !changed && !overlap) return
  if (!isCurrencyCode(stay.currency)) throw new Error('The channel stay has an unsupported currency')
  const channel = STAY_CHANNEL_LABELS[stay.channel]
  // A channel may send a reservation without a guest name; its reservation code still names it.
  const named = stay.guest_name?.trim() ?? ''
  const guestName = named || `${channel} reservation ${stay.channel_booking_id ?? stay.external_booking_id}`
  const guest: { name: string } | { label: string } = named ? { name: named } : { label: guestName }
  const homes = await queryAll<{ product_id: string; name: string; location_id: string; check_in_time: string | null; check_out_time: string | null }>(db, `SELECT p.id AS product_id, p.name, c.location_id, b.check_in_time, b.check_out_time
    FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
    JOIN product_booking_configs b ON b.organization_id = p.organization_id AND b.product_id = p.id WHERE p.organization_id = ? AND p.id IN (?, ?)`,
  [organizationId, terms.product_id, previous?.product_id ?? terms.product_id])
  const homeOf = (productId: string) => {
    const found = homes.find(home => home.product_id === productId)
    if (!found) throw new HTTPError({ statusCode: 500, message: 'The channel stay names a home that no longer exists', data: { code: 'CHANNEL_STAY_HOME_MISSING', field: 'product_id', product_id: productId, booking_id: stay.id } })
    return found
  }
  const home = homeOf(terms.product_id)
  const organization = await queryFirst<{ name: string | null }>(db, 'SELECT name FROM organization WHERE id = ?', [organizationId])
  const studio = organizationName({ organizationId, organizationName: organization?.name })
  const [hero, audience] = await Promise.all([
    messageHero(db, organizationId, { type: 'product', id: home.product_id }),
    stayTurnoverAudience(env, db, organizationId, { ...stay, product_id: home.product_id }, home.check_in_time),
  ])
  const memberName = memberGuestName(guest)
  const day = (date: string) => formatCalendarDate(date, 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const money = (minor: number) => formatMinorAmount(minor, stay.currency as CurrencyCode, 'en-US')
  const eventKey = `channel-stay:${organizationId}:${stay.id}:${input.revisionId}`
  const base = {
    guestName, guestEmail: stay.guest_email, guestPhone: stay.guest_phone, homeName: home.name, channel,
    checkIn: [day(terms.check_in_date), home.check_in_time ? formatTime(home.check_in_time, 'en-US') : null].filter(Boolean).join(' · '), checkOut: [day(terms.check_out_date), home.check_out_time ? formatTime(home.check_out_time, 'en-US') : null].filter(Boolean).join(' · '),
    stayDates: { checkIn: terms.check_in_date, checkOut: terms.check_out_date }, arrival: audience.arrival, nights: String(stayNights(terms)), guests: stayParty(terms),
    organizationName: studio, heroImageUrl: hero?.imageUrl ?? null, replyUrl: audience.stayUrl,
  }
  const send = (template: string, message: MemberAlertMessage, memberMessage: MemberAlertMessage, whatsappTemplate?: WhatsAppTemplate) => notifyOwner(env, db, {
    organizationId, organizationName: studio, locationId: home.location_id, template, title: message.title,
    payload: { booking_id: stay.id, revision_id: input.revisionId, deep_link: audience.stayUrl },
    message, idempotencyKey: `notification:${eventKey}`, entity: { type: 'booking', id: stay.id }, deliveryEventKey: eventKey, stayId: stay.id,
    memberIds: audience.memberIds, memberAlert: { message: memberMessage, stayId: stay.id }, whatsappTemplate,
  })
  if (cancelled) {
    const cancellation = { ...base, refund: null }
    return send('channel_stay.cancelled', stayCancelledMessage(cancellation), stayCancelledMessage(stayTurnoverAlert(cancellation, audience.stayUrl, memberName)))
  }
  if (booked || !changed) {
    const booking = { ...base, total: money(terms.total_minor), paid: null, balance: null, overlap, notes: null }
    return send(overlap ? 'channel_stay.overlap' : 'channel_stay.booked', stayBookedMessage(booking), stayBookedMessage(stayTurnoverAlert(booking, audience.stayUrl, memberName)))
  }
  const before = previous!
  const previousHome = homeOf(before.product_id)
  const side = (value: ChannelStayTerms, homeName: string) => ({ date: `${day(value.check_in_date)} – ${day(value.check_out_date)}`, time: null, nights: stayNights(value), partySize: stayParty(value), location: homeName, total: money(value.total_minor), assignee: null })
  const counts = (value: ChannelStayTerms) => ({ checkIn: value.check_in_date, checkOut: value.check_out_date, guests: value.adults + value.children, infants: value.infants, totalMinor: value.total_minor })
  const change: BookingChangeEventInput = {
    recordKind: 'stay', channel, guestName, requestedBy: { kind: 'guest' }, status: 'changed', locationLabel: 'Home',
    counterpartyLabel: 'Guest', partyLabel: 'Guests',
    current: side(before, previousHome.name), requested: side(terms, home.name),
    differences: [
      ...(overlap ? [{ text: 'The new nights overlap another stay: resolve the double booking' }] : []),
      ...(previousHome.product_id !== home.product_id ? [{ text: `Moves to ${home.name}` }] : []),
      ...stayChangeDifferences(counts(before), counts(terms), money),
    ],
    replyUrl: audience.stayUrl, organizationName: studio,
  }
  return send('stay.change_changed', bookingChangeMessage(change), bookingChangeMessage(bookingChangeWithoutMoney(change, audience.stayUrl, memberName)), 'booking_change_update')
}

export async function notifyStayBooked(env: NotificationEnv, db: DbClient, organizationId: string, stayId: string) {
  // Loaded when used: the stays domain reaches notifications through the guest inbox.
  const { readCheckoutStay } = await import('~/server/domain/stays')
  const stay = await readCheckoutStay(db, organizationId, stayId)
  const { paidOnline } = await import('~/server/domain/payments')
  const [organization, paid, sourceLocale] = await Promise.all([
    queryFirst<{ name: string | null; public_url: string | null }>(db, `SELECT name, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url FROM organization WHERE id = ?`, [organizationId]),
    paidOnline(db, organizationId, stayId),
    getPersistedSourceLocale(db, organizationId),
  ])
  if (!organization || !stay.guest_email || !stay.guest_name) throw new Error('A stay booked on the site needs its organization, guest name and email')
  if (!paid) throw new Error('A stay booked on the site is confirmed only once it is paid')
  if (!isCurrencyCode(stay.currency)) throw new Error('The stay has an unsupported currency')
  const home = stay.home
  const studio = organizationName({ organizationId, organizationName: organization.name })
  const threadContext = await getOpeningThreadContext(db, stay.conversation_id)
  const [inboxUrl, hero, logoUrl, guest, contact, audience, notes] = await Promise.all([
    buildOwnerThreadInboxUrl(env, db, { organizationId, locationId: home.location_id, threadId: stay.conversation_id }),
    messageHero(db, organizationId, { type: 'product', id: home.product_id }),
    organizationLogo(db, organizationId),
    guestPresentation(db, { organizationId, organizationName: studio, productId: home.product_id, productTitle: home.name, locationId: home.location_id }),
    resolveLocationContact(db, organizationId, home.location_id),
    stayTurnoverAudience(env, db, organizationId, stay, home.check_in_time),
    guestNote(db, stay.conversation_id),
  ])
  const nights = stayNights(stay)
  const when = (date: string, time: string | null, locale: string) => [formatCalendarDate(date, locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), time ? formatTime(time, locale) : null].filter(Boolean).join(' · ')
  const party = stayParty(stay)
  if (paid.currency !== stay.currency) throw new Error('A stay booked on the site was paid in a different currency than it was priced')
  const ownerInput = {
    guestName: stay.guest_name, guestEmail: stay.guest_email, guestPhone: stay.guest_phone, homeName: home.name, channel: null,
    checkIn: when(stay.check_in_date, home.check_in_time, 'en-US'), checkOut: when(stay.check_out_date, home.check_out_time, 'en-US'), arrival: audience.arrival,
    stayDates: { checkIn: stay.check_in_date, checkOut: stay.check_out_date },
    nights: String(nights), guests: party, notes, answers: stay.answers, overlap: false,
    total: formatMinorAmount(stay.total_minor, stay.currency, 'en-US'), paid: formatMinorAmount(paid.amount, paid.currency, 'en-US'),
    balance: stay.total_minor > paid.amount ? formatMinorAmount(stay.total_minor - paid.amount, stay.currency, 'en-US') : null,
    organizationName: studio, heroImageUrl: hero?.imageUrl ?? null, replyUrl: inboxUrl,
  }
  const ownerMessage = stayBookedMessage(ownerInput)
  const guestMessage = guestStayConfirmedMessage({
    manageUrl: await buildBuyerRequestActivityUrl(env, db, { organizationId, threadId: stay.conversation_id }),
    locale: guest.locale, guestName: stay.guest_name, organizationName: guest.organizationName, organizationLogoUrl: logoUrl, homeName: guest.productTitle ?? home.name,
    checkIn: when(stay.check_in_date, home.check_in_time, guest.locale), checkOut: when(stay.check_out_date, home.check_out_time, guest.locale),
    nights: String(nights), guests: String(stay.adults + stay.children), total: formatMinorAmount(paid.amount, paid.currency, guest.locale),
    checkInInstructions: home.check_in_instructions, contactPhone: contact.contactPhone ?? null, contactEmail: contact.contactEmail ?? null,
    heroImageUrl: hero?.imageUrl ?? null,
    receiptUrl: organization.public_url ? `${organization.public_url.replace(/\/$/, '')}${formatTenantLocalePath('/bookings/stay', guest.locale, sourceLocale.locale)}?id=${encodeURIComponent(stay.conversation_id)}#${(await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', stay.conversation_id)).token}` : null,
  })
  const payload = {
    booking_id: stay.id, guest_name: stay.guest_name, email: stay.guest_email, home: home.name, check_in_date: stay.check_in_date, check_out_date: stay.check_out_date,
    party_size: String(stay.adults + stay.children), organization_name: studio, deep_link: inboxUrl ?? '',
  }
  const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain: getPlatformDomain(env) })
  const guestTitle = guestMessage.title
  const results = await Promise.allSettled([
    notifyOwner(env, db, {
      organizationId, organizationName: studio, locationId: home.location_id, template: 'new_stay', title: ownerMessage.title, payload, message: ownerMessage,
      source: { conversationId: stay.conversation_id, messageId: anchorId(threadContext.subject) },
      memberIds: audience.memberIds, memberAlert: { message: stayBookedMessage(stayTurnoverAlert(ownerInput, audience.stayUrl, memberGuestName({ name: stay.guest_name }))), stayId: stay.id },
    }),
    sendEmailNotification(env, db, {
      organizationId, organizationName: studio, locationId: home.location_id, to: stay.guest_email, replyAs: { kind: 'guest' },
      template: 'stay_customer_confirmed', title: guestTitle, payload,
      email: { subject: guestTitle, ...guestEmail },
      delivery: threadDelivery(threadContext, 'guest_acknowledgement', 'email', 'stay_customer_confirmed', stay.guest_email),
    }),
  ])
  raiseSettledFailures('notifyStayBooked', `stayId ${stayId}`, results)
}

/**
 * A stay paid on the site was cancelled. The cancellation is recorded on the
 * stay's conversation; when the guest cancelled, the host is told with what
 * the guest's policy refunded. The guest is emailed either way, in the site's
 * language.
 */
export async function notifyStayCancelled(env: NotificationEnv, db: DbClient, organizationId: string, stayId: string, by: 'guest' | 'host', refundMinor: number) {
  const { readCheckoutStay } = await import('~/server/domain/stays')
  const stay = await readCheckoutStay(db, organizationId, stayId)
  if (!isCurrencyCode(stay.currency)) throw new Error('The stay has an unsupported currency')
  const home = stay.home
  const dedupeKey = `stay-cancellation:${stayId}`
  let entry = await findMessageByDedupeKey(db, dedupeKey)
  if (!entry) {
    const organization = await queryFirst<{ name: string | null }>(db, 'SELECT name FROM organization WHERE id = ?', [organizationId])
    if (!organization || !stay.guest_email || !stay.guest_name) throw new Error('A stay paid on the site needs its organization, guest name and email')
    const studio = organizationName({ organizationId, organizationName: organization.name })
    const [inboxUrl, hero, logoUrl, guest, contact] = await Promise.all([
      buildOwnerThreadInboxUrl(env, db, { organizationId, locationId: home.location_id, threadId: stay.conversation_id }),
      messageHero(db, organizationId, { type: 'product', id: home.product_id }),
      organizationLogo(db, organizationId),
      guestPresentation(db, { organizationId, organizationName: studio, productId: home.product_id, productTitle: home.name, locationId: home.location_id }),
      resolveLocationContact(db, organizationId, home.location_id),
    ])
    const nights = stayNights(stay)
    const day = (date: string, locale: string) => formatCalendarDate(date, locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    const guestMessage = guestBookingCancelledMessage({
      manageUrl: await buildBuyerRequestActivityUrl(env, db, { organizationId, threadId: stay.conversation_id }),
      locale: guest.locale, guestName: stay.guest_name, organizationName: guest.organizationName, organizationLogoUrl: logoUrl, productTitle: guest.productTitle ?? home.name,
      date: `${day(stay.check_in_date, guest.locale)} – ${day(stay.check_out_date, guest.locale)}`, time: home.check_in_time ? formatTime(home.check_in_time, guest.locale) : '',
      partySize: String(stay.adults + stay.children), contactPhone: contact.contactPhone ?? null, contactEmail: contact.contactEmail ?? null, wasConfirmed: true, wording: 'booking',
    })
    const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain: getPlatformDomain(env) })
    const guestTitle = `${guestMessage.title} — ${guestMessage.preheader?.split(' · ')[0] ?? home.name}`
    entry = await appendMessage(db, {
      conversationId: stay.conversation_id, authorKind: 'krabiclaw', authorUserId: null, channel: 'web', body: guestEmail.text,
      eventName: `stay.${by}_cancelled`, dedupeKey,
      payload: { subject: guestTitle, refund_minor: refundMinor, location_id: home.location_id,
        email: { to: stay.guest_email, fromName: studio, html: guestEmail.html, text: guestEmail.text },
        owner: {
          guestName: stay.guest_name, guestEmail: stay.guest_email, guestPhone: stay.guest_phone, homeName: home.name,
          checkIn: [day(stay.check_in_date, 'en-US'), home.check_in_time ? formatTime(home.check_in_time, 'en-US') : null].filter(Boolean).join(' · '), checkOut: [day(stay.check_out_date, 'en-US'), home.check_out_time ? formatTime(home.check_out_time, 'en-US') : null].filter(Boolean).join(' · '),
          nights: String(nights), guests: String(stay.adults + stay.children), refund: formatMinorAmount(refundMinor, stay.currency, 'en-US'),
          organizationName: studio, heroImageUrl: hero?.imageUrl ?? null, replyUrl: inboxUrl,
        },
      },
    })
  }
  if (entry.conversation_id !== stay.conversation_id || entry.author_kind !== 'krabiclaw' || entry.event_name !== `stay.${by}_cancelled`) throw new Error('Stay cancellation notification has a different message')
  const stored = parseMessagePayload(entry)
  if (stored?.refund_minor !== refundMinor) throw new Error('Stay cancellation notification differs from its recorded refund')
  // A host cancellation has one required notice. Guest cancellations also
  // resume the host alert: a sent guest email cannot prove that alert completed.
  if (by === 'host') {
    const receipts = await queryAll<GuestThreadDeliveryRow>(db, 'SELECT * FROM guest_thread_deliveries WHERE message_id = ?', [entry.id])
    if (receipts.some(receipt => receipt.channel === 'email' && receipt.purpose === 'guest_acknowledgement') && receipts.every(isDeliverySent)) return
  }
  if (!isRecord(stored?.email)) throw new Error('Stay cancellation notification has no recorded email content to retry')
  const recorded = z.object({
    subject: z.string().min(1), refund_minor: z.number().int().nonnegative(), location_id: z.string().min(1),
    email: z.object({ to: z.string().min(1), fromName: z.string().min(1), html: z.string().min(1), text: z.string().min(1) }),
    owner: z.object({
      guestName: z.string(), guestEmail: z.string(), guestPhone: z.string().nullable(), homeName: z.string(), checkIn: z.string(), checkOut: z.string(),
      nights: z.string(), guests: z.string(), refund: z.string(), organizationName: z.string(), heroImageUrl: z.string().nullable(), replyUrl: z.string().min(1),
    }),
  }).parse(stored)
  if (recorded.refund_minor !== refundMinor || entry.body !== recorded.email.text) throw new Error('Stay cancellation notification differs from its recorded refund or email')
  const audience = await stayTurnoverAudience(env, db, organizationId, stay, home.check_in_time)
  const ownerInput = { ...recorded.owner, channel: null, arrival: audience.arrival, stayDates: { checkIn: stay.check_in_date, checkOut: stay.check_out_date } }
  const ownerMessage = stayCancelledMessage(ownerInput)
  const threadContext: DeliveryAnchor = { conversationId: stay.conversation_id, subject: { messageId: entry.id } }
  const payload = { booking_id: stay.id, organization_name: recorded.email.fromName, deep_link: recorded.owner.replyUrl ?? '' }
  const results = await Promise.allSettled([
    ...(by === 'guest' ? [notifyOwner(env, db, {
      organizationId, organizationName: recorded.email.fromName, locationId: recorded.location_id, template: 'stay_cancelled', payload,
      source: { conversationId: stay.conversation_id, messageId: entry.id },
      title: ownerMessage.title, message: ownerMessage,
      memberIds: audience.memberIds, memberAlert: { message: stayCancelledMessage(stayTurnoverAlert(ownerInput, audience.stayUrl, memberGuestName({ name: recorded.owner.guestName }))), stayId: stay.id },
    })] : []),
    sendEmailNotification(env, db, {
      organizationId, organizationName: recorded.email.fromName, locationId: recorded.location_id, to: recorded.email.to, replyAs: { kind: 'guest' },
      template: 'stay_customer_cancelled', title: recorded.subject, payload,
      email: { subject: recorded.subject, html: recorded.email.html, text: recorded.email.text, emailPurpose: 'transactional' },
      delivery: threadDelivery(threadContext, 'guest_acknowledgement', 'email', 'stay_customer_cancelled', recorded.email.to),
    }),
  ])
  raiseSettledFailures('notifyStayCancelled', `stayId ${stayId}`, results, by === 'guest' ? ['notifyOwner', 'sendEmailNotification'] : ['sendEmailNotification'])
}

export async function notifyBookingCancelled(
  env: NotificationEnv,
  db: DbClient,
  /** cancellationMessageId: the one KrabiClaw message the cancellation wrote in the booking's conversation. */
  opts: BookingNotificationInput & { cancellationMessageId: string }
) {
  const confirmed = Boolean(opts.wasConfirmed)
  const studio = organizationName(opts)
  const prettyDate = new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone, dateStyle: 'medium' }).format(new Date(opts.startsAt))
  const prettyTime = formatTimestamp(opts.startsAt, 'en', opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const platformDomain = getPlatformDomain(env)
  const [inboxUrl, logoUrl, { presentation, locationName, partySize: formattedPartySize, wording }] = await Promise.all([
    buildOwnerInboxUrl(env, db, {
      organizationId: opts.organizationId,
      locationId: opts.locationId,
      tab: 'bookings',
      submissionId: opts.bookingId,
    }),
    organizationLogo(db, opts.organizationId),
    bookingFrame(db, opts),
  ])

  const payload = {
    booking_id: opts.bookingId,
    guest_name: opts.guestName,
    email: opts.email,
    experience: opts.productTitle,
    starts_at: opts.startsAt,
    timezone: opts.timezone,
    party_size: `${opts.partySize}${opts.partySizeIsMinimum ? '+' : ''}`,
    booking_was_confirmed: confirmed ? 'true' : 'false',
    organization_name: studio,
    deep_link: inboxUrl ?? '',
  }

  const ownerMessage = bookingCancelledMessage({
    guestName: opts.guestName, guestEmail: opts.email, guestPhone: opts.guestPhone ?? null,
    date: prettyDate, day: formatTimestamp(opts.startsAt, 'en-US', opts.timezone, { month: 'short', day: 'numeric' }), time: prettyTime, partySize: formattedPartySize,
    locationName, organizationName: studio, productTitle: opts.productTitle,
    presentation,
    notes: opts.notes ?? null, heroImageUrl: null, replyUrl: inboxUrl,
    wasConfirmed: confirmed,
  })
  const guest = await guestPresentation(db, opts)
  const copy = getVerticalCopy(opts.vertical, guest.locale)
  const guestMessage = guestBookingCancelledMessage({
    ...guest, manageUrl: await buildBuyerRequestActivityUrl(env, db, { organizationId: opts.organizationId, threadId: opts.bookingId }),
    guestName: opts.guestName, productTitle: guest.productTitle!,
    date: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { dateStyle: 'medium' }),
    time: formatTimestamp(opts.startsAt, guest.locale, opts.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    partySize: formattedPartySize,
    partyLabel: copy.guestsLabel,
    notes: opts.notes, wasConfirmed: confirmed, wording,
    organizationLogoUrl: logoUrl,
  })
  const guestEmail = await renderNotificationEmail(guestMessage, { platformDomain })
  const threadContext: DeliveryAnchor = { conversationId: opts.bookingId, subject: { messageId: opts.cancellationMessageId } }

  const results = await Promise.allSettled([
    notifyOwner(env, db, {
      ...opts,
      submissionType: 'booking',
      submissionId: opts.bookingId,
      // The opening message carries the new_booking alert; this one is the cancellation's.
      source: { conversationId: opts.bookingId, messageId: opts.cancellationMessageId },
      template: 'booking_cancelled',
      title: ownerMessage.title,
      payload,
      message: ownerMessage,
      whatsappTemplate: 'reservation_cancelled',
    }),
    sendEmailNotification(env, db, {
      ...opts,
      to: opts.email,
      replyAs: { kind: 'guest' },
      template: 'booking_customer_cancelled',
      title: guestMessage.title,
      payload,
      email: { subject: guestMessage.title, ...guestEmail },
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
    threadId: string
    submissionType: 'booking' | 'stay'
    submissionId: string
    /** The change's message in the conversation. */
    messageId: string
    locationId: string | null
    vertical?: string | null
    /** A booking's assignment before and after, which decides the members told; a stay's members are its home's. */
    assignment?: BookingChangeAssignment
    /** The stay changed, for its home's responsible members, who read the change without money and open the stay. */
    stay?: { id: string; product_id: string }
    change: Omit<BookingChangeEventInput, 'replyUrl' | 'organizationName' | 'counterpartyLabel' | 'partyLabel'>
  },
) {
  const { submissionType, change } = opts
  // A stay's members read its changes without money; the projection needs the stay.
  if (submissionType === 'stay' && !opts.stay) throw new HTTPError({ statusCode: 500, message: 'A stay change alert needs its stay to tell the members who look after the home', data: { code: 'STAY_REQUIRED', field: 'stay', conversation_id: opts.threadId } })
  const replyUrl = await buildOwnerThreadInboxUrl(env, db, opts)
  // The record's own noun, which its presentation resolved from what was booked: a table's is a reservation.
  const presentation = change.recordKind === 'consultation' || opts.vertical === 'service'
    ? resolveBookingPresentation('service', 'service')
    : resolveBookingPresentation(change.recordKind === 'reservation' ? 'table' : 'experience', opts.vertical ?? 'experience')
  const input: BookingChangeEventInput = {
    ...change, replyUrl, organizationName: organizationName(opts),
    counterpartyLabel: presentation.counterpartyLabel,
    partyLabel: submissionType === 'stay' ? 'Guests' : presentation.partyLabel,
  }
  const ownerMessage = bookingChangeMessage(input)
  const stay = opts.stay ? await queryFirst<{ id: string; product_id: string; starts_at: string; timezone: string; check_in_time: string | null }>(db, `SELECT b.id, b.product_id, b.starts_at, b.timezone, c.check_in_time
    FROM bookings b JOIN product_booking_configs c ON c.organization_id = b.organization_id AND c.product_id = b.product_id WHERE b.organization_id = ? AND b.id = ? AND b.product_id = ?`, [opts.organizationId, opts.stay.id, opts.stay.product_id]) : null
  if (opts.stay && !stay) throw new HTTPError({ statusCode: 500, message: 'The changed stay is not at its home', data: { code: 'STAY_REQUIRED', field: 'stay', conversation_id: opts.threadId } })
  const audience = stay ? await stayTurnoverAudience(env, db, opts.organizationId, stay, stay.check_in_time) : null
  await notifyOwner(env, db, {
    organizationId: opts.organizationId, organizationName: opts.organizationName, locationId: opts.locationId,
    ...(submissionType === 'stay' ? {} : { submissionType, submissionId: opts.submissionId }),
    template: `${change.recordKind}.change_${change.status}`,
    title: ownerMessage.title,
    payload: {
      request_id: opts.threadId,
      submission_type: submissionType,
      submission_id: opts.submissionId,
      status: change.status,
      deep_link: replyUrl,
    },
    source: { conversationId: opts.threadId, messageId: opts.messageId },
    message: ownerMessage,
    memberIds: audience ? audience.memberIds
      : opts.assignment ? [...new Set([opts.assignment.beforeMemberId, ...(change.status === 'accepted' ? [opts.assignment.afterMemberId] : [])].filter((id): id is string => id !== null))]
        : submissionType === 'booking' ? [] : undefined,
    memberAlert: audience && opts.stay ? { message: bookingChangeMessage(bookingChangeWithoutMoney(input, audience.stayUrl, memberGuestName({ name: change.guestName }))), stayId: opts.stay.id } : undefined,
    whatsappTemplate: 'booking_change_update',
  })
}

export async function notifyGuestThreadReply(
  env: NotificationEnv,
  db: DbClient,
  opts: GuestThreadReplyNotificationInput,
) {
  // A blocked guest's messages are still recorded, but nobody is alerted to them.
  const thread = await getGuestRequest(db, opts.threadId, opts.organizationId)
  if (!thread) throw new Error(`Guest thread ${opts.threadId} does not exist in organization ${opts.organizationId}`)
  if (thread.blocked_at !== null) return
  // What the conversation is about: the home, class or booking it belongs to, or its location.
  const [summary, organization] = await Promise.all([
    requestSummary(db, thread),
    queryFirst<{ name: string | null }>(db, 'SELECT name FROM organization WHERE id = ?', [opts.organizationId]),
  ])
  const business = organizationName({ organizationId: opts.organizationId, organizationName: organization?.name })
  const threadContext: DeliveryAnchor = { conversationId: opts.threadId, subject: { messageId: opts.messageId } }
  const replyUrl = await buildOwnerThreadInboxUrl(env, db, {
    organizationId: opts.organizationId,
    locationId: opts.locationId,
    threadId: opts.threadId,
  })

  const payload = {
    request_id: opts.threadId,
    submission_type: opts.submissionType,
    submission_id: opts.submissionId,
    participant_label: opts.participantLabel,
    inbound_channel: opts.inboundChannel,
    deep_link: replyUrl ?? '',
  }

  // Who wrote decides the alert: a guest's message carries the conversation's
  // record under it; Airbnb Support writing about a case carries none.
  const entry = await getMessage(db, opts.messageId)
  if (!entry || entry.conversation_id !== opts.threadId) throw new Error(`Message ${opts.messageId} is not in conversation ${opts.threadId}`)
  const support = isAirbnbSupportMessage(entry)
  if (entry.author_kind !== 'guest' && !support) throw new Error(`Message ${entry.id} is neither a guest's nor Airbnb Support's; nobody is alerted to it`)
  const { guestName, body, photos, preview, history } = await alertedMessage(db, thread, entry, business)
  const ownerMessage = {
    ...messageReceived({
      sender: support ? { kind: 'support' } : { kind: 'person', name: guestName, email: opts.guestEmail ?? null },
      conversationLabel: { email: 'Email reply', whatsapp: 'WhatsApp reply', web: 'Website reply', airbnb: 'Airbnb message' }[opts.inboundChannel],
      about: summary.productTitle ?? summary.locationTitle,
      messagePreview: preview, body, photos, history,
      translation: airbnbTranslation(entry),
      record: support ? null : await conversationRecord(db, thread),
      organizationName: business,
      replyUrl,
    }),
    organizationLogoUrl: await organizationLogo(db, opts.organizationId),
  }


  const recipients = await resolveOwnerRecipients(env, db, {
    organizationId: opts.organizationId,
    category: ownerMessage.category,
    emailPurpose: ownerMessage.emailPurpose,
    guestMessage: true,
  })

  const results = await Promise.allSettled(recipients.flatMap(recipient => memberNotificationSends(env, db, recipient, {
    ...opts, organizationName: business, context: threadContext,
    template: 'guest_thread_reply_email', pushTemplate: 'guest_thread_reply_push',
    whatsappTemplate: 'guest_thread_reply_whatsapp', payload, message: ownerMessage,
    target: { kind: 'guest', conversation_id: opts.threadId },
  })))
  raiseUnrecordedOwnerAlertFailures('notifyGuestThreadReply', `thread ${opts.threadId}`, results.map(result => ({ result, task: 'ownerAlert' })))
}

/** How many earlier messages an alert shows under the new one. */
const ALERT_HISTORY = 3

/**
 * The message an alert is about, read from the conversation itself: its words,
 * its photos as served from the media store (public URLs a mail client and Meta
 * can fetch), what a list says when it has no words, and the last messages
 * before it, named as the inbox names their authors.
 */
async function alertedMessage(db: DbClient, thread: GuestRequest, entry: MessageRow, business: string) {
  // The conversation reader depends on this module through the inbox, so it is loaded when an alert needs it.
  const { guestMessageAlertWindow } = await import('~/server/domain/guest-threads/detail')
  const { messages, channelGuestName } = await guestMessageAlertWindow(db, entry, thread, business, ALERT_HISTORY)
  const alerted = messages.at(-1)!
  const guestFullName = isAirbnbSupportMessage(entry) ? 'Airbnb Support' : thread.payload.guest.name ?? channelGuestName ?? participantLabel(thread)
  const guest = isAirbnbSupportMessage(entry) ? guestFullName : channelGuestName ?? guestFullName
  const author = (item: typeof alerted): string => {
    return item.actorLabel ?? (item.actorKind === 'guest' ? guest : business)
  }
  const fileCount = (payload: Record<string, unknown> | null) =>
    (Array.isArray(payload?.attachments) ? payload.attachments.length : 0) + (Array.isArray(payload?.unshownFiles) ? payload.unshownFiles.length : 0)
  const said = (item: typeof alerted) => item.body?.trim()
    || (item.attachments.length ? messagePreview(null, item.attachments.length) : fileCount(item.payload) === 1 ? 'Sent an attachment' : `Sent ${fileCount(item.payload)} attachments`)
  return {
    guestName: guestFullName,
    // A file with no words is still what the guest sent; photos show themselves.
    body: alerted.body?.trim() || (alerted.attachments.length ? '' : said(alerted)),
    photos: alerted.attachments.map(photo => ({ imageUrl: photo.url, alt: photo.alt ?? `Photo from ${guest}` })),
    preview: said(alerted),
    history: messages.slice(0, -1)
      .map(item => ({ author: author(item), text: said(item) })),
  }
}

/** Channex marks an Airbnb agent's message with the role AGENT (read from a live thread, 2026-10-23); the mirror records it as KrabiClaw's relay. */
export function isAirbnbSupportMessage(entry: MessageRow): boolean {
  const meta = entry.channel === 'airbnb' ? parseMessagePayload(entry).meta : null
  return entry.author_kind === 'krabiclaw' && isRecord(meta) && meta.role === 'AGENT'
}

/** Airbnb's translation of a guest's message, which Channex sends as meta.translated_message beside the words as written. */
function airbnbTranslation(entry: MessageRow): { by: string; text: string } | null {
  const meta = entry.channel === 'airbnb' ? parseMessagePayload(entry).meta : null
  const text = isRecord(meta) && typeof meta.translated_message === 'string' ? meta.translated_message.trim() : ''
  return text ? { by: 'Airbnb', text } : null
}

/** The home a channel conversation belongs to, with the clock its dates are read in. */
async function channelHome(db: DbClient, thread: GuestRequest) {
  const home = await queryFirst<{ product_id: string; name: string; timezone: string; organization_name: string | null }>(db, `SELECT p.id AS product_id, p.name, l.timezone, o.name AS organization_name
    FROM channel_threads t JOIN products p ON p.id = t.product_id AND p.organization_id = t.organization_id
    JOIN product_stay_configs c ON c.product_id = t.product_id AND c.organization_id = t.organization_id
    JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id
    JOIN organization o ON o.id = t.organization_id WHERE t.conversation_id = ? AND t.organization_id = ?`, [thread.id, thread.organization_id])
  if (!home) throw new HTTPError({ statusCode: 500, message: 'The channel conversation has no home', data: { code: 'CHANNEL_THREAD_MISSING', field: 'conversation_id', conversation_id: thread.id } })
  return home
}

/** The home's own picture: an alert never lets the business's sharing image stand in for it. */
async function homePicture(db: DbClient, organizationId: string, productId: string) {
  return (await loadOwnerPictures(db, organizationId, 'product', [productId], { organizationFallback: false })).get(productId) ?? null
}

type InquiryTerms = Pick<AirbnbInquiry, 'checkInDate' | 'checkOutDate' | 'adults' | 'children' | 'infants' | 'pets' | 'respondBy'>

async function inquiryRecord(db: DbClient, thread: GuestRequest, inquiry: InquiryTerms): Promise<ConversationRecord & { replyBy: string }> {
  const home = await channelHome(db, thread)
  return {
    image: await homePicture(db, thread.organization_id, home.product_id), homeName: home.name,
    checkIn: inquiry.checkInDate, checkOut: inquiry.checkOutDate,
    guests: [stayParty(inquiry), ...(inquiry.pets ? [`${inquiry.pets} pet${inquiry.pets === 1 ? '' : 's'}`] : [])].join(', '),
    replyBy: formatTimestamp(inquiry.respondBy, 'en-US', home.timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  }
}

/**
 * What a guest conversation is about now, under its message alert: the stay
 * it belongs to, or, while no booking exists, the Airbnb inquiry it began as
 * (the latest one the conversation recorded). Other conversations have none.
 */
async function conversationRecord(db: DbClient, thread: GuestRequest): Promise<ConversationRecord | null> {
  if (thread.kind !== 'booking') return null
  const stay = await queryFirst<{ product_id: string; product_name: string; adults: number | null; children: number | null; infants: number | null; starts_at: string; ends_at: string; timezone: string; nights: number }>(db,
    `SELECT b.product_id, p.name AS product_name, b.adults, b.children, b.infants, b.starts_at, b.ends_at, b.timezone, b.product_session_id IS NULL AS nights
      FROM bookings b JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      WHERE b.organization_id = ? AND b.id = (SELECT booking_id FROM conversations WHERE id = ?)`, [thread.organization_id, thread.id])
  if (stay && stay.nights !== 1) return null
  if (stay) {
    if (stay.adults === null || stay.children === null || stay.infants === null) throw new Error(`The stay of conversation ${thread.id} has no party breakdown`)
    return { image: await homePicture(db, thread.organization_id, stay.product_id), homeName: stay.product_name,
      checkIn: bookingDay(stay.starts_at, stay.timezone), checkOut: bookingDay(stay.ends_at, stay.timezone), guests: stayParty({ adults: stay.adults, children: stay.children, infants: stay.infants }), replyBy: null }
  }
  if (!thread.payload.participant) return null
  // The inquiry is the conversation's own: the dates and party the guest asked about before booking.
  if (thread.kind !== 'booking' || !thread.payload.inquiry) return null
  const payload = z.object({ check_in_date: z.string(), check_out_date: z.string(), adults: z.number().int(), children: z.number().int(), infants: z.number().int(), pets: z.number().int(), respond_by: z.string() }).parse(thread.payload.inquiry)
  return inquiryRecord(db, thread, { checkInDate: payload.check_in_date, checkOutDate: payload.check_out_date, adults: payload.adults, children: payload.children,
    infants: payload.infants, pets: payload.pets, respondBy: payload.respond_by })
}

/** An Airbnb guest asked about dates: the owners, and the members who look after the home, are told the guest's words, the request and Airbnb's deadline. */
/** `messageId` is the guest's message that asked, which carries the inquiry. */
export async function notifyAirbnbInquiry(env: NotificationEnv, db: DbClient, input: { threadId: string; messageId: string; inquiry: AirbnbInquiry }) {
  const thread = await getGuestRequest(db, input.threadId)
  if (!thread) throw new Error(`Inquiry conversation ${input.threadId} does not exist`)
  if (thread.blocked_at !== null) return
  const asked = await getMessage(db, input.messageId)
  if (!asked || asked.conversation_id !== thread.id || asked.author_kind !== 'guest' || !asked.body?.trim()) throw new HTTPError({ statusCode: 500, message: 'The inquiry conversation has no message from the guest', data: { code: 'CHANNEL_INQUIRY_MESSAGE_MISSING', field: 'conversation_id', conversation_id: thread.id } })
  const [home, record, replyUrl, photos] = await Promise.all([
    channelHome(db, thread),
    inquiryRecord(db, thread, input.inquiry),
    buildOwnerThreadInboxUrl(env, db, { organizationId: thread.organization_id, threadId: thread.id }),
    listMessagePhotos(db, 'message', [asked.id]).then(found => found.get(asked.id) ?? []),
  ])
  const message = inquiryReceivedMessage({
    guestName: input.inquiry.guestName, message: asked.body.trim(), translation: airbnbTranslation(asked), record, replyUrl,
    photos: photos.map(photo => ({ imageUrl: photo.url, alt: photo.alt ?? `Photo from ${input.inquiry.guestName}` })),
    organizationName: organizationName({ organizationId: thread.organization_id, organizationName: home.organization_name }),
  })
  await notifyOwner(env, db, {
    organizationId: thread.organization_id, organizationName: message.organizationName, locationId: thread.location_id,
    template: 'channel_inquiry', title: message.title, payload: { request_id: thread.id, live_feed_event_id: input.inquiry.id, deep_link: replyUrl },
    source: { conversationId: thread.id, messageId: asked.id }, message, whatsappTemplate: 'guest_thread_reply_whatsapp',
  })
}

export interface TeamMessageNotificationInput {
  organizationId: string
  threadId: string
  /** The team message; every delivery receipt is its. */
  messageId: string
  senderName: string
  /** The message's words, or what it sent when it has none. */
  messagePreview: string
  /** The conversation's other members, as users. */
  recipientUserIds: string[]
}

/** Team participants use the ordinary channel preferences and recorded delivery paths. */
export async function notifyTeamMessage(env: NotificationEnv, db: DbClient, input: TeamMessageNotificationInput): Promise<void> {
  if (input.recipientUserIds.length === 0) return
  const recipientIds = new Set(input.recipientUserIds)
  const members = await queryAll<{ id: string; userId: string }>(db,
    'SELECT id, userId FROM member WHERE organizationId = ?', [input.organizationId])
  const organization = await queryFirst<{ name: string }>(db,
    'SELECT name FROM organization WHERE id = ?', [input.organizationId])
  if (!organization) throw new HTTPError({ statusCode: 500, message: 'The team conversation organization is missing', data: { code: 'TEAM_ORGANIZATION_MISSING', field: 'organization_id' } })
  const replyUrl = await dashboardPathUrl(env, db, input.organizationId, `/messages/team/${encodeURIComponent(input.threadId)}?view=team`)
  const message = { ...messageReceived({ sender: { kind: 'person', name: input.senderName, email: null }, conversationLabel: 'Team', about: null, messagePreview: input.messagePreview, body: input.messagePreview, photos: [], history: [], translation: null, record: null, organizationName: organization.name, replyUrl }),
    organizationLogoUrl: await organizationLogo(db, input.organizationId) }
  const recipients = (await resolveOwnerRecipients(env, db, {
    organizationId: input.organizationId, category: message.category, emailPurpose: message.emailPurpose,
    memberIds: members.filter(member => recipientIds.has(member.userId)).map(member => member.id),
  })).filter(recipient => recipientIds.has(recipient.userId))
  // The caller publishes one event after all initial notification receipts are saved.
  const context: DeliveryAnchor = { conversationId: input.threadId, subject: { messageId: input.messageId }, publishWithMessage: true }
  const results = await Promise.allSettled(recipients.flatMap(recipient => memberNotificationSends(env, db, recipient, {
    organizationId: input.organizationId, organizationName: organization.name,
    context, template: 'team_message', pushTemplate: 'team_message',
    whatsappTemplate: 'guest_thread_reply_whatsapp', payload: { team_thread_id: input.threadId }, message,
    target: { kind: 'team', conversation_id: input.threadId },
  })))
  raiseUnrecordedOwnerAlertFailures('notifyTeamMessage', `team thread ${input.threadId}`, results.map(result => ({ result, task: 'teamMessage' })))
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
  const entry = await queryFirst<{ id: string }>(db, 'SELECT id FROM activity_entries WHERE dedupe_key = ? AND organization_id = ?', [eventKey, opts.organizationId])
  if (!entry) throw new Error('Invitation delivery has no organization receipt')

  const rendered = await renderNotificationEmail(organizationInviteMessage({
    organizationName: opts.organizationName,
    inviterName: opts.inviterName,
    role: opts.role,
    inviteUrl,
    expires: formatTimestamp(opts.expiresAt, 'en-US', 'UTC', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  }), { platformDomain })

  await sendEmailNotification(env, db, {
    organizationId: opts.organizationId,
    to: opts.email,
    template: 'organization_invited',
    title: `You're invited to join ${opts.organizationName}`,
    delivery: { conversationId: null, subject: { activityEntryId: entry.id }, purpose: 'status_update', idempotencyKey: `organization-invitation-email:${opts.invitationId}:${opts.expiresAt}` },
    payload: {
      invitation_id: opts.invitationId,
      role: opts.role,
      organization_name: opts.organizationName,
      deep_link: inviteUrl,
    },
    email: {
      subject: `You're invited to join ${opts.organizationName} on KrabiClaw`,
      ...rendered,
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
      preferencesUrl: entry.audience === 'guest' && entry.message.emailPurpose === 'transactional'
        ? null
        : `${root}/dashboard/account/profile/notifications`,
      unsubscribeUrl: entry.message.emailPurpose === 'transactional'
        ? null
        : `${root}/unsubscribe?user=preview&category=preview&token=preview`,
    })

    let whatsapp: CatalogPreviewEntry['whatsapp'] = null
    if (entry.whatsappTemplate) {
      const { vars } = toWhatsAppVars(entry.message, entry.whatsappTemplate)
      // A sample missing a fact the template's slot needs is refused at send,
      // and the preview shows that refusal rather than a message it would not send.
      let text: string
      try {
        text = buildWhatsAppTemplatePayload(entry.whatsappTemplate, vars).components
          .flatMap(component => component.parameters.map(parameter => parameter.text))
          .join('\n')
      } catch (error) {
        if (!(error instanceof WhatsAppTemplateRefusal)) throw error
        text = `Not sent — ${error.message}`
      }
      whatsapp = { template: entry.whatsappTemplate, text }
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
  if (record.unit !== 'slot' || !record.product_name.trim()) throw new Error('Booking cancellation delivery requires its canonical offering')
  if (request.payload.guest.name === null || request.payload.guest.email === null) throw new Error(`Booking ${record.id} was cancelled through its guest token without the guest's name and email`)
  await publishConversationEvent(env, db, { conversationId: request.id, type: 'MESSAGE_CREATE' })
  // The cancellation's one message, which cancelBookingRequest wrote under this key.
  const cancellation = await findMessageByDedupeKey(db, `booking:${record.id}:guest-cancel`)
  if (!cancellation || cancellation.conversation_id !== request.id) throw new Error(`Booking ${record.id} was cancelled without its cancellation message`)

  const organization = await queryFirst<{ name: string | null; vertical: string | null }>(db, 'SELECT name, vertical FROM organization WHERE id = ? LIMIT 1', [organizationId])
  // The guest's note is their own message in the conversation, its one source.
  const note = await queryFirst<{ body: string | null }>(db, 'SELECT body FROM messages WHERE conversation_id = ? AND event_name = ?', [request.id, GUEST_NOTE_EVENT])
  await notifyBookingCancelled(env, db, {
    organizationId: request.organization_id, organizationName: organization?.name, vertical: organization?.vertical ?? null,
    locale: request.payload.guest.locale,
    locationId: record.location_id, bookingId: request.id, guestName: request.payload.guest.name,
    email: request.payload.guest.email, guestPhone: request.payload.guest.phone,
    productId: record.product_id, productKind: record.product_kind, productTitle: record.product_name,
    startsAt: record.starts_at, timezone: record.timezone, partySize: record.party_size, partySizeIsMinimum: record.party_size_is_minimum,
    notes: note?.body ?? null, wasConfirmed: cancelled.wasConfirmed, cancellationMessageId: cancellation.id,
  })
}

/**
 * Tell the people a task is now theirs, or that its window starts today, by
 * their own Email, WhatsApp and Push for the Tasks category, each send
 * recorded on the task. The task opens on Today.
 */
async function notifyTaskPeople(env: NotificationEnv, db: DbClient, input: { organizationId: string; taskId: string; recipientUserIds: string[]; actorUserId: string | null } & ({ kind: 'assigned'; eventKey: string } | { kind: 'starting'; day: string })): Promise<void> {
  const recipientIds = new Set(input.recipientUserIds)
  if (!recipientIds.size) return
  const { describeTaskForAlert } = await import('~/server/domain/tasks')
  const organization = await queryFirst<{ name: string }>(db, 'SELECT name FROM organization WHERE id = ?', [input.organizationId])
  if (!organization) throw new Error(`Task ${input.taskId} names a missing organization`)
  const actor = input.actorUserId ? await queryFirst<{ name: string }>(db, 'SELECT name FROM user WHERE id = ?', [input.actorUserId]) : null
  const members = await queryAll<{ id: string; userId: string }>(db, 'SELECT id, userId FROM member WHERE organizationId = ?', [input.organizationId])
  const taskUrl = await dashboardPathUrl(env, db, input.organizationId, `?task=${encodeURIComponent(input.taskId)}`)
  const organizationLogoUrl = await organizationLogo(db, input.organizationId)
  const recipients = (await resolveOwnerRecipients(env, db, {
    organizationId: input.organizationId, category: 'tasks', emailPurpose: 'transactional',
    memberIds: members.filter(member => recipientIds.has(member.userId)).map(member => member.id),
  })).filter(recipient => recipientIds.has(recipient.userId))
  const results = await Promise.allSettled([...recipientIds].map(async (userId) => {
    const task = await describeTaskForAlert(db, input.organizationId, input.taskId, userId)
    const message = { ...taskAlertMessage({ kind: input.kind, actorName: actor?.name ?? null, task, organizationName: organization.name, taskUrl }), organizationLogoUrl }
    const recipient = recipients.find(item => item.userId === userId)
    if (!recipient) return
    const sends = memberNotificationSends(env, db, recipient, {
      organizationId: input.organizationId, organizationName: organization.name, locationId: task.locationId,
      // An assignment's sends are keyed by its version; a start's by its day, which taskStartingSent reads.
      context: { conversationId: null, subject: { taskId: input.taskId } }, eventKey: input.kind === 'assigned' ? `${input.eventKey}:${userId}` : undefined,
      template: input.kind === 'assigned' ? 'task_assigned' : `task_starting:${input.day}`, pushTemplate: input.kind === 'assigned' ? 'task_assigned' : `task_starting:${input.day}`,
      whatsappTemplate: 'guest_thread_reply_whatsapp', payload: { task_id: input.taskId, deep_link: taskUrl }, message,
      target: { kind: 'task', task_id: input.taskId },
    })
    const outcomes = await Promise.allSettled(sends)
    raiseUnrecordedOwnerAlertFailures('notifyTaskPeople', `task ${input.taskId}`, outcomes.map(result => ({ result, task: 'taskAlert' })))
  }))
  raiseUnrecordedOwnerAlertFailures('notifyTaskPeople', `task ${input.taskId}`, results.map(result => ({ result, task: 'taskAlert' })))
}

export async function notifyTaskAssigned(env: NotificationEnv, db: DbClient, input: { organizationId: string; taskId: string; actorUserId: string | null; recipientUserIds: string[] }): Promise<void> {
  const version = await queryFirst<{ version: number }>(db, 'SELECT version FROM tasks WHERE organization_id = ? AND id = ?', [input.organizationId, input.taskId])
  if (!version) throw new Error(`Task ${input.taskId} disappeared before its assignment alert`)
  await notifyTaskPeople(env, db, { ...input, kind: 'assigned', eventKey: `task-assigned:${input.taskId}:${version.version}` })
}

/** A job an owner or admin keeps for themselves starts today: the task alert, once per day. The organization's jobs wake sends it. */
export async function notifyTaskStarting(env: NotificationEnv, db: DbClient, input: { organizationId: string; taskId: string; day: string; recipientUserIds: string[] }): Promise<void> {
  await notifyTaskPeople(env, db, { organizationId: input.organizationId, taskId: input.taskId, recipientUserIds: input.recipientUserIds, kind: 'starting', actorUserId: null, day: input.day })
}

/** Whether a task's start alert for this day already went out on some channel: its sends are keyed by task, alert and day. */
export async function taskStartingSent(db: DbClient, taskId: string, day: string): Promise<boolean> {
  // D1 refuses a GLOB pattern this long, so the key's parts are matched by position.
  const prefix = `${taskId}:owner_alert:`
  return Boolean(await queryFirst(db, 'SELECT 1 FROM guest_thread_deliveries WHERE task_id = ? AND substr(id, 1, length(?)) = ? AND instr(id, ?) > 0',
    [taskId, prefix, prefix, `:task_starting:${day}:`]))
}

