import { HTTPError } from 'nitro'
import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { BOOKING_RECORDS_SQL, bookedRecordWindow, getGuestRequest, getThreadOperationalRecord } from '~/server/domain/requests'
import { isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'
import { assertOrganizationWideAccess, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { readMediaPlacements } from '~/server/utils/media-asset-manager'
import { creationRequestHash } from '~/server/utils/organization-events'
import { isRecord } from '~/server/utils/type-guards'
import { BUSINESS_ACTIVITY_EVENTS, BUSINESS_MEASUREMENT_EVENTS, BUSINESS_OUTCOME_EVENTS, BUSINESS_PROGRESS_OPERATIONS, type ArticleDistribution, type BusinessOutcome, type BusinessOutcomeEvent, type BusinessOutcomePage, type BusinessProgressOperation, type BusinessProgressReference, type RecommendationPublication } from '~/shared/business-outcomes'
import { CONVERSION_EVENT_CATALOG, type ConversionValue, type OrganizationConversionEventName } from '~/utils/organization-conversion-events'
import type { AttributionTouch } from '~/utils/analytics-attribution'
import { resolvePublicTenantOrigin } from '~/server/utils/public-base'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import { articleCollectionOf } from '~/server/utils/content/publishing'
import { getSocialConnections } from '~/server/utils/social-publication'
import { readStripeCheckoutSetup } from '~/server/utils/stripe-connect'
import { experiencePublicationBlocker, getProduct } from '~/server/utils/product-management'
import { readIntegration } from '~/server/utils/organization-integrations'
import { getSessionAvailability } from '~/server/utils/availability'
import { MAX_HOMES_CALENDAR_DAYS, readStayGapCandidates, stayAccessFor } from '~/server/domain/stays'
import { addLocalDays, formatCalendarRange, formatTimestamp, isValidCalendarDate, localDateAt } from '~/utils/timezone'
import { PRODUCT_DETAIL_FIELDS, type ProductKind } from '~/shared/product-details'
import { platformLocale } from '~/shared/platform-locales'
import { stayGuestFirstName } from '~/shared/bookings'
import { UPCOMING_RESERVATION_DAYS } from '~/shared/dashboard-today'

interface OutcomeEntry {
  source_table: BusinessOutcome['source']['table']
  source_id: string
  event_name: BusinessOutcomeEvent
  actor_kind: BusinessOutcome['actor']['kind']
  actor_user_id: string | null
  request_id: string | null
  request_kind: string | null
  channel: string | null
  payload_json: string
  occurred_at: string
}

const ARTICLE_EVENTS_JSON = d1JsonStringSet(['article.created', 'article.updated', 'article.published'])
const ACTIVITY_EVENTS_JSON = d1JsonStringSet(BUSINESS_ACTIVITY_EVENTS)
const MEASUREMENT_EVENTS_JSON = d1JsonStringSet(BUSINESS_MEASUREMENT_EVENTS)

function invalidEvidence(row: OutcomeEntry, message: string): never {
  throw new HTTPError({ statusCode: 500, message, data: { code: 'INVALID_PROGRESS_EVIDENCE', source: row.source_table, id: row.source_id } })
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Existing domain records are read together; neither event storage nor lifecycle state is copied. */
export async function listBusinessOutcomes(
  db: DbClient,
  principal: MemberAccessPrincipal,
  input: { limit?: number; offset?: number } = {},
): Promise<BusinessOutcomePage> {
  await assertOrganizationWideAccess(db, principal)
  const limit = input.limit ?? 50, offset = input.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new HTTPError({ statusCode: 400, message: 'limit must be an integer from 1 to 100 and offset a nonnegative safe integer', data: { code: 'INVALID_PROGRESS_PAGE', field: 'pagination' } })
  }
  const rows = await queryAll<OutcomeEntry>(db, `
    WITH facts AS (
      SELECT 'activity_entries' AS source_table, a.id AS source_id, a.event_name, a.actor_kind, a.actor_user_id,
             a.request_id, r.kind AS request_kind, a.channel, a.payload_json, a.occurred_at
      FROM activity_entries a LEFT JOIN requests r ON r.id = a.request_id AND a.scope_kind = 'request'
      WHERE a.event_name IN (SELECT value FROM json_each(?)) AND (
        (a.scope_kind = 'organization' AND a.organization_id = ? AND a.kind = 'audit') OR
        (a.scope_kind = 'request' AND r.organization_id = ? AND a.kind IN ('message', 'operation'))
      )
      AND COALESCE(json_extract(a.payload_json, '$.metadata.operation'), '') <> 'unchanged'
      -- Captures/refunds have one financial fact, in analytics. A conversation
      -- notification is not a second sale. Failed/pending notifications remain visible.
      AND NOT (a.event_name IN ('payment.payment_captured', 'payment.refund_succeeded') AND EXISTS (
        SELECT 1 FROM analytics_events measured WHERE measured.organization_id = r.organization_id AND measured.kind = 'conversion'
          AND ((a.event_name = 'payment.payment_captured' AND json_extract(measured.payload_json, '$.event_name') = 'payment_paid'
            AND json_extract(measured.payload_json, '$.entity_id') = json_extract(a.payload_json, '$.payment_id'))
            OR (a.event_name = 'payment.refund_succeeded' AND json_extract(measured.payload_json, '$.event_name') = 'payment_refunded'
            AND json_extract(measured.payload_json, '$.entity_id') = json_extract(a.payload_json, '$.native_object_id')))
      ))
      UNION ALL
      SELECT 'post_publications', p.id, 'post.publication', COALESCE(initiator.actor_kind, 'unknown'), initiator.actor_user_id,
             NULL, NULL, p.channel,
             json_object('entityType', 'post_publication', 'entityId', p.id, 'postId', p.post_id, 'state', p.state,
               'providerTargetId', p.provider_target_id, 'providerPostId', p.provider_post_id, 'providerPermalink', p.provider_permalink,
               'errorCode', p.error_code, 'errorMessage', p.error_message, 'revision', p.updated_at, 'payloadHash', p.payload_hash),
             CASE WHEN p.state = 'published' THEN p.published_at ELSE p.updated_at END
      FROM post_publications p LEFT JOIN activity_entries initiator ON initiator.id = p.initiating_activity_id
        AND initiator.organization_id = p.organization_id AND initiator.scope_kind = 'organization'
        AND initiator.event_name = 'post.publication_started'
      WHERE p.organization_id = ?
      UNION ALL
      SELECT 'reviews', review.id, CASE WHEN review.source = 'direct' THEN 'review.submitted' ELSE 'review.recorded' END,
             CASE WHEN review.source = 'direct' THEN 'guest' ELSE 'member' END,
             CASE WHEN review.source = 'direct' THEN review.user_id ELSE review.entered_by_user_id END,
             review_thread.id, review_thread.kind, NULL,
             json_object('entityType', 'review', 'entityId', review.id, 'state', review.status, 'source', review.source,
               'reviewRequestId', review.review_request_id, 'bookingId', review.booking_id, 'publicationAuthorized', review.publication_authorized, 'revision', review.updated_at), review.created_at
      FROM reviews review LEFT JOIN bookings visit ON visit.id = review.booking_id AND visit.organization_id = review.organization_id
        LEFT JOIN requests review_thread ON review_thread.id = visit.request_id AND review_thread.organization_id = review.organization_id
      WHERE review.organization_id = ? AND review.source IN ('direct', 'owner_entered')
      UNION ALL
      SELECT 'analytics_events', measured.id, 'measurement.' || json_extract(measured.payload_json, '$.event_name'),
             'unknown', NULL, NULL, NULL, NULL, measured.payload_json, measured.created_at
      FROM analytics_events measured WHERE measured.organization_id = ? AND measured.kind = 'conversion'
        AND json_extract(measured.payload_json, '$.event_name') IN (SELECT value FROM json_each(?))
        -- A decision's measurement is the same business result as its canonical
        -- operation. Prefer that operation, while measurements without one remain visible.
        AND NOT EXISTS (
          SELECT 1 FROM activity_entries operation JOIN requests request ON request.id = operation.request_id
          WHERE request.organization_id = measured.organization_id AND operation.scope_kind = 'request'
            AND ((json_extract(measured.payload_json, '$.event_name') IN ('booking_confirmed', 'booking_declined', 'booking_cancelled')
              AND operation.event_name = CASE json_extract(measured.payload_json, '$.event_name') WHEN 'booking_confirmed' THEN 'booking.confirm' WHEN 'booking_declined' THEN 'booking.reject' ELSE 'booking.cancel' END
              AND json_extract(operation.payload_json, '$.operational_booking_id') = json_extract(measured.payload_json, '$.entity_id'))
              OR (json_extract(measured.payload_json, '$.event_name') IN ('booking_change_accepted', 'booking_change_declined')
              AND operation.event_name = CASE json_extract(measured.payload_json, '$.event_name') WHEN 'booking_change_accepted' THEN 'booking_change.accepted' ELSE 'booking_change.declined' END
              AND json_extract(operation.payload_json, '$.requestId') = json_extract(measured.payload_json, '$.entity_id')))
        )
    ) SELECT * FROM facts ORDER BY occurred_at DESC, source_table DESC, source_id DESC LIMIT ? OFFSET ?
  `, [ACTIVITY_EVENTS_JSON, principal.organizationId, principal.organizationId, principal.organizationId,
    principal.organizationId, principal.organizationId, MEASUREMENT_EVENTS_JSON, limit + 1, offset])
  const page = rows.slice(0, limit)
  const activityIds = page.filter(row => row.source_table === 'activity_entries').map(row => row.source_id)
  const receipts = activityIds.length ? await queryAll<GuestThreadDeliveryRow>(db, `
    SELECT * FROM guest_thread_deliveries WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, id DESC
  `, [d1JsonStringSet(activityIds)]) : []
  const outcomes = page.map((row): BusinessOutcome => {
    const parsed: unknown = JSON.parse(row.payload_json)
    if (!isRecord(parsed)) invalidEvidence(row, 'Business activity has no object evidence')
    const payload = parsed
    const metadata = isRecord(payload.metadata) ? payload.metadata : {}
    const after = isRecord(payload.afterState) ? payload.afterState : {}
    const message = row.event_name === 'thread.member_reply' || row.event_name === 'thread.scheduled_message'
    const externalSend = message || row.event_name === 'review.requested'
    let subject: BusinessOutcome['subject']
    if (row.source_table === 'analytics_events') {
      const kind = text(payload.entity_type), id = text(payload.entity_id)
      if (!kind || !id) invalidEvidence(row, 'Measured conversion has no canonical subject')
      subject = { kind, id }
    } else if (row.request_id && row.source_table === 'activity_entries') {
      const operationalId = text(payload.operational_booking_id)
      if (operationalId) {
        if (row.request_kind !== 'booking') invalidEvidence(row, 'Operational activity has no valid recorded request kind')
        subject = { kind: 'booking', id: operationalId }
      } else subject = { kind: 'guest_thread', id: row.request_id }
    } else {
      const kind = text(payload.entityType), id = text(payload.entityId)
      if (!kind || !id) invalidEvidence(row, 'Business activity has no canonical subject')
      subject = { kind, id }
    }
    if (message && (!row.request_id || !['web', 'email', 'airbnb', 'whatsapp'].includes(row.channel ?? ''))) {
      invalidEvidence(row, 'Message activity has no supported canonical destination')
    }
    const deliveries = receipts.filter(receipt => receipt.entry_id === row.source_id
      && (!message || receipt.channel === row.channel))
    if (deliveries.some(receipt => receipt.provider === 'channex' && isDeliverySent(receipt) && !receipt.provider_message_id?.trim())) {
      throw new HTTPError({ statusCode: 500, message: 'A successful channel reply has no provider message ID', data: { code: 'CHANNEL_RECEIPT_INVALID', field: 'delivery.provider_message_id' } })
    }
    const accepted = deliveries.some(receipt => receipt.provider !== 'log_only' && isDeliverySent(receipt))
    const storedReply = message && row.channel === 'web'
    const providerStatus = metadata.verification_status
    const noConfirmedChanges = providerStatus === 'unconfirmed' || providerStatus === 'failed'
    const status: BusinessOutcome['verification']['status'] = providerStatus === 'verified' || providerStatus === 'unconfirmed' || providerStatus === 'failed' ? providerStatus : externalSend && !storedReply
      ? accepted ? 'verified' : deliveries.length > 0 && deliveries.every(receipt => receipt.status === 'failed') ? 'failed' : 'unconfirmed'
      : row.source_table === 'post_publications'
        ? payload.state === 'failed' ? 'failed' : 'verified'
        : 'verified'
    const outcome: BusinessOutcome = {
      id: row.source_table === 'activity_entries' ? row.source_id : `${row.source_table}:${row.source_id}`,
      source: { table: row.source_table, id: row.source_id }, event: row.event_name, subject,
      actor: { kind: row.actor_kind, userId: row.actor_user_id }, occurredAt: row.occurred_at,
      state: providerStatus === 'unconfirmed' ? 'unknown' : text(payload.state) ?? text(payload.afterStatus) ?? text(payload.status) ?? text(after.status),
      changedFields: noConfirmedChanges ? [] : Array.isArray(metadata.changed_fields) ? metadata.changed_fields.filter((field): field is string => typeof field === 'string') : [],
      revision: text(payload.revision) ?? text(metadata.revision) ?? text(metadata.current_revision) ?? text(after.revision) ?? text(after.updated_at),
      references: row.request_id && subject.id !== row.request_id ? [{ kind: 'guest_thread', id: row.request_id }] : [],
      verification: {
        status, basis: metadata.verification_basis === 'provider_acceptance' ? 'provider_acceptance' : row.source_table === 'post_publications' ? 'provider_publication'
          : row.source_table === 'analytics_events' ? 'recorded_conversion' : storedReply ? 'stored_web_reply' : externalSend ? 'provider_acceptance' : 'persisted_change',
        receipts: deliveries.map(receipt => ({ id: receipt.id, channel: receipt.channel, provider: receipt.provider, status: receipt.status,
          providerMessageId: receipt.provider_message_id })),
      },
    }
    const details = row.source_table === 'activity_entries' ? {
      ...metadata,
      ...(Object.hasOwn(payload, 'beforeState') ? { beforeState: payload.beforeState } : {}),
      ...(Object.hasOwn(payload, 'afterState') ? { afterState: payload.afterState } : {}),
    } : row.source_table === 'analytics_events' ? metadata : payload
    if (Object.keys(details).length) outcome.details = details
    if (noConfirmedChanges && Array.isArray(metadata.changed_fields)) {
      outcome.requestedFields = metadata.changed_fields.filter((field): field is string => typeof field === 'string')
    }
    const operationId = text(metadata.operation_id)
    if (operationId) outcome.references.push({ kind: 'activity_entry', id: operationId })
    const financialPaymentId = text(payload.payment_id)
    if (financialPaymentId) outcome.references.push({ kind: 'payment', id: financialPaymentId })
    const paymentId = text(metadata.payment_id)
    if (paymentId) outcome.references.push({ kind: 'offline_payment', id: paymentId })
    if (metadata.provider === 'google_ads') {
      outcome.verification.receipts.push({ id: row.source_id, channel: 'google_ads', provider: 'google_ads', status, providerMessageId: text(metadata.provider_request_id) })
    }
    if (row.source_table === 'post_publications') {
      const postId = text(payload.postId)
      if (postId) outcome.references.push({ kind: 'post', id: postId })
      outcome.verification.receipts.push({ id: row.source_id, channel: row.channel!, provider: row.channel!, status: String(payload.state), providerMessageId: text(payload.providerPostId) })
    }
    if (row.source_table === 'analytics_events') {
      const actor = isRecord(payload.actor) ? payload.actor : null
      const kind = actor?.type
      if (actor && text(actor.id) && (kind === 'staff' || kind === 'user' || kind === 'agent')) {
        outcome.actor = { kind: kind === 'staff' ? 'member' : kind, userId: actor.id as string }
      }
      const name = text(payload.event_name) as OrganizationConversionEventName | null
      if (!name || !(name in CONVERSION_EVENT_CATALOG) || typeof payload.stage !== 'string' || typeof payload.surface !== 'string') invalidEvidence(row, 'Measured conversion has invalid event evidence')
      const value = payload.value
      if (value !== null && value !== undefined) {
        if (!isRecord(value) || value.basis !== CONVERSION_EVENT_CATALOG[name].valueBasis
          || !Number.isSafeInteger(value.amount_minor) || !/^[A-Z]{3}$/.test(String(value.currency))
          || (value.collected_minor !== undefined && !Number.isSafeInteger(value.collected_minor))) invalidEvidence(row, 'Measured conversion has invalid monetary evidence')
        outcome.value = value as unknown as ConversionValue
        outcome.moneyOwner = payload.conversion_type === 'subscription' ? 'platform' : 'customer_business'
      }
      const properties = isRecord(payload.properties) ? payload.properties : {}
      outcome.state = payload.stage
      outcome.measurement = {
        stage: payload.stage, surface: payload.surface, conversionType: text(payload.conversion_type),
        attribution: isRecord(payload.attribution) ? payload.attribution as unknown as AttributionTouch : null,
        attributedAt: text(payload.attributed_at), originEventId: text(payload.origin_event_id), assignedMemberId: text(properties.member_id),
      }
    }
    return outcome
  })
  const hasMore = rows.length > limit
  return {
    outcomes, pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    coverage: {
      supportedEvents: BUSINESS_OUTCOME_EVENTS, sources: ['activity_entries', 'post_publications', 'reviews', 'analytics_events'],
      attribution: 'recorded_actor_only', article: 'persisted_change_only', webReply: 'stored_message_only',
      externalReply: 'provider_acceptance_requires_receipt', verification: 'only_the_named_evidence_basis',
      unverified: ['public_visibility', 'operation_completion', 'recipient_notification', 'conversation_resolution', 'business_goal_achievement', 'attendance_or_fulfilment', 'causal_revenue_attribution'],
    },
  }
}

async function recommendationPublications(db: DbClient, organizationId: string, postIds: string[]): Promise<Array<RecommendationPublication & { postId: string }>> {
  if (!postIds.length) return []
  return queryAll(db, `SELECT id, post_id AS postId, channel, state, provider_post_id AS providerPostId,
    published_at AS publishedAt, updated_at AS updatedAt FROM post_publications
    WHERE organization_id = ? AND post_id IN (SELECT value FROM json_each(?)) ORDER BY post_id, channel, id`,
  [organizationId, d1JsonStringSet(postIds)])
}

/** Existing post CTA URLs associate a prepared social post with its article; only provider receipts prove distribution. */
export async function readArticleDistribution(db: DbClient, principal: MemberAccessPrincipal, articleId: string): Promise<ArticleDistribution> {
  await assertOrganizationWideAccess(db, principal)
  const article = await queryFirst<{ slug: string | null; metadata_json: string }>(db,
    "SELECT slug, metadata_json FROM content_documents WHERE id = ? AND organization_id = ? AND kind = 'article' AND row_role = 'root'", [articleId, principal.organizationId])
  if (!article) throw new HTTPError({ statusCode: 404, message: 'Article not found' })
  const origin = await resolvePublicTenantOrigin(db, principal.env, principal.organizationId)
  if (!origin || !article.slug) return { url: null, posts: [] }
  const metadata = JSON.parse(article.metadata_json) as { collection?: unknown }
  const url = new URL(tenantBlogPostPath(article.slug, articleCollectionOf(metadata.collection)), origin).toString()
  const candidates = await queryAll<{ id: string; status: string | null; updatedAt: string; targetUrl: string }>(db,
    `SELECT id, status, updated_at AS updatedAt, json_extract(metadata_json, '$.call_to_action.url') AS targetUrl
      FROM content_documents WHERE organization_id = ? AND kind = 'social_post' AND row_role = 'root'
      AND json_type(metadata_json, '$.call_to_action.url') = 'text' ORDER BY id`, [principal.organizationId])
  const articleUrl = new URL(url)
  const posts = candidates.filter(post => {
    const target = new URL(post.targetUrl)
    return target.origin === articleUrl.origin && target.pathname === articleUrl.pathname
  }).map(({ targetUrl: _targetUrl, ...post }) => post)
  const publications = await recommendationPublications(db, principal.organizationId, posts.map(post => post.id))
  return { url, posts: posts.map(post => ({ ...post, publications: publications.filter(publication => publication.postId === post.id) })) }
}

/** A correction/deferral is about explicit current evidence, never a permanent suppression of a resource. */
/**
 * A booked visit whose client has heard nothing from the business since booking,
 * with the host's own preparation to send them: an experience's or
 * consultation's "Before you arrive" and "What to bring", or a home's
 * directions, wifi and house manual. A home's check-in instructions are not
 * here; every confirmed stay is already sent them the day before arrival. A
 * table has preparation only when its host wrote some.
 */
export interface BookingWelcome {
  requestId: string
  /** A stay at a home, or any other booking. */
  kind: 'booking' | 'stay'
  /** What was booked: an experience, a consultation, a table or a stay's home. */
  productKind: ProductKind
  recordId: string
  status: string
  /** The booked instant, or a stay's check-in day. */
  startsAt: string
  timezone: string
  productId: string
  locationId: string | null
  guestFirstName: string | null
  /** The message the host reviews and sends, written only from the fields above. */
  message: string
}

interface WelcomeRow {
  unit: 'slot' | 'nights'; product_kind: ProductKind; record_id: string; request_id: string; status: string; starts_at: string; ends_at: string
  timezone: string; product_id: string; product_name: string; location_id: string | null; guest_name: string | null
  details_json: string | null; directions: string | null; wifi_network: string | null; wifi_password: string | null; house_manual: string | null
}

const fieldName = (key: 'preparation' | 'what_to_bring') => PRODUCT_DETAIL_FIELDS.find(field => field.key === key)!.name
const stayLabels = () => {
  const locale = platformLocale('en')
  if (!locale) throw new Error('The English platform locale is missing')
  return locale.messages
}
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function welcomeMessage(row: WelcomeRow): string | null {
  const first = stayGuestFirstName(row.guest_name)
  const sections: string[] = []
  if (row.unit === 'slot') {
    const details = JSON.parse(row.details_json ?? '{}') as Record<string, unknown>
    if (filled(details.preparation)) sections.push(`${fieldName('preparation')}:\n${details.preparation.trim()}`)
    const items = Array.isArray(details.what_to_bring) ? details.what_to_bring.filter(filled) : []
    if (items.length) sections.push(`${fieldName('what_to_bring')}:\n${items.map(item => `- ${item.trim()}`).join('\n')}`)
  } else {
    const labels = stayLabels()
    if (filled(row.directions)) sections.push(`${labels['stay.directions']}:\n${row.directions.trim()}`)
    const wifi = [filled(row.wifi_network) ? `${labels['stay.wifi_network']}: ${row.wifi_network.trim()}` : null, filled(row.wifi_password) ? `${labels['stay.wifi_password']}: ${row.wifi_password.trim()}` : null].filter(Boolean)
    if (wifi.length) sections.push(`${labels['stay.wifi_details']}:\n${wifi.join('\n')}`)
    if (filled(row.house_manual)) sections.push(`${labels['stay.house_manual']}:\n${row.house_manual.trim()}`)
  }
  if (!sections.length) return null
  const window = bookedRecordWindow({ id: row.record_id, ...row })
  const when = row.unit === 'nights'
    ? `from ${formatCalendarRange(window.start.date, window.end.date, 'en-US')}`
    : `on ${formatTimestamp(row.starts_at, 'en-US', row.timezone, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`
  const opening = row.unit === 'nights' ? `Looking forward to hosting you at ${row.product_name} ${when}.` : `Looking forward to seeing you for ${row.product_name} ${when}.`
  return [`Hi${first ? ` ${first}` : ''},`, opening, ...sections].join('\n\n')
}

/**
 * The upcoming confirmed booked visits a welcome applies to now, or the one
 * conversation named: any record whose offering has host-authored preparation.
 */
export async function readBookingWelcomes(db: DbClient, organizationId: string, input: { now: Date; requestId?: string; locationId?: string }): Promise<BookingWelcome[]> {
  const now = input.now.toISOString(), until = new Date(input.now.getTime() + UPCOMING_RESERVATION_DAYS * 86_400_000).toISOString()
  const only = (column: string, value: string | undefined) => value === undefined ? '' : `AND ${column} = ?`
  const rows = await queryAll<WelcomeRow>(db, `
    SELECT br.unit, br.product_kind, br.id AS record_id, br.request_id, br.status, br.starts_at, br.ends_at, br.timezone,
      br.product_id, br.product_name, br.location_id, json_extract(r.payload_json, '$.guest.name') AS guest_name,
      p.details_json, c.directions, c.wifi_network, c.wifi_password, c.house_manual
    FROM ${BOOKING_RECORDS_SQL} br
    JOIN requests r ON r.id = br.request_id AND r.organization_id = br.organization_id
    JOIN products p ON p.id = br.product_id AND p.organization_id = br.organization_id
    LEFT JOIN product_stay_configs c ON br.unit = 'nights' AND c.organization_id = br.organization_id AND c.product_id = br.product_id
    WHERE br.organization_id = ? AND br.status = 'confirmed' AND br.starts_at BETWEEN ? AND ?
      AND (json_extract(p.details_json, '$.preparation') IS NOT NULL OR json_array_length(p.details_json, '$.what_to_bring') > 0
        OR COALESCE(c.directions, c.wifi_network, c.wifi_password, c.house_manual) IS NOT NULL)
      AND r.archived_at IS NULL AND r.blocked_at IS NULL
      -- The client has had no business message in this conversation since they booked.
      AND NOT EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = r.id AND e.kind = 'message' AND e.actor_kind = 'member' AND e.occurred_at >= br.created_at)
      ${only('r.id', input.requestId)} ${only('br.location_id', input.locationId)}
    ORDER BY br.starts_at, br.id`,
  [organizationId, new Date(input.now.getTime() - 2 * 86_400_000).toISOString(), until, ...[input.requestId, input.locationId].filter((value): value is string => value !== undefined)])
  return rows.flatMap((row) => {
    // A stay is upcoming in its home's own calendar until its guests arrive; anything else until it starts.
    const arrival = bookedRecordWindow({ id: row.record_id, ...row }).start
    if (row.unit === 'nights') {
      const today = localDateAt(input.now, row.timezone)
      if (arrival.date < today || arrival.date > addLocalDays(today, UPCOMING_RESERVATION_DAYS)) return []
      if (arrival.instant !== null && arrival.instant <= now) return []
    } else if (row.starts_at <= now) return []
    const message = welcomeMessage(row)
    if (message === null) return []
    return [{ requestId: row.request_id, kind: row.unit === 'nights' ? 'stay' as const : 'booking' as const, productKind: row.product_kind, recordId: row.record_id, status: row.status, startsAt: row.unit === 'nights' ? arrival.date : row.starts_at, timezone: row.timezone,
      productId: row.product_id, locationId: row.location_id, guestFirstName: stayGuestFirstName(row.guest_name), message }]
  })
}

export async function readBusinessProgressReference(
  db: DbClient,
  principal: MemberAccessPrincipal,
  input: { operation: BusinessProgressOperation; subjectId: string },
): Promise<BusinessProgressReference> {
  await assertOrganizationWideAccess(db, principal)
  if (typeof input.subjectId !== 'string' || !input.subjectId.trim() || !(BUSINESS_PROGRESS_OPERATIONS as readonly string[]).includes(input.operation)) {
    throw new HTTPError({ statusCode: 400, message: 'An explicit supported operation and subjectId are required', data: { code: 'INVALID_PROGRESS_REFERENCE', field: 'subjectId' } })
  }
  const missing = () => new HTTPError({ statusCode: 404, message: 'Progress subject not found', data: { code: 'PROGRESS_SUBJECT_NOT_FOUND', field: 'subjectId' } })
  const coordinates = (): [string, string, string] => {
    let value: unknown
    try { value = JSON.parse(input.subjectId) } catch (error) { if (error instanceof SyntaxError) throw missing(); throw error }
    if (!Array.isArray(value) || value.length !== 3 || value.some(part => typeof part !== 'string' || !part)) throw missing()
    return value as [string, string, string]
  }
  const result = async (evidence: BusinessProgressReference['evidence'], sources: unknown = evidence): Promise<BusinessProgressReference> => ({
    ...input, evidence, evidenceRevision: await creationRequestHash({ operation: input.operation, subjectId: input.subjectId, sources }),
  })
  if (['article.create', 'post.create', 'social.connect', 'google_ads.connect', 'payments.connect'].includes(input.operation)) {
    if (input.subjectId !== principal.organizationId && input.operation !== 'post.create') throw missing()
    const organization = await queryFirst<{ updated_at: string; slug: string }>(db, 'SELECT updated_at, slug FROM organization WHERE id = ?', [principal.organizationId])
    if (!organization) throw missing()
    if (input.operation === 'social.connect') {
      const social = await getSocialConnections(principal.env, principal.organizationId, { dashboardBase: `/dashboard/${encodeURIComponent(organization.slug)}` })
      const channels = social.channels.map(channel => ({ channel: channel.channel, connected: channel.connected, targetId: channel.target_id,
        revision: channel.connection_revision, problems: channel.problems.map(problem => problem.code) }))
      return result({ kind: 'social_connection', entitled: !channels.some(channel => channel.problems.includes('growth_plan_required')), channels })
    }
    if (input.operation === 'google_ads.connect') {
      const integration = await readIntegration(db, principal.organizationId, 'google_ads')
      return result({ kind: 'google_ads_connection', connected: integration !== null, targetId: integration?.target_id ?? null, revision: integration?.revision ?? null })
    }
    if (input.operation === 'payments.connect') {
      const setup = await readStripeCheckoutSetup(db, principal.organizationId, principal.env)
      return result({ kind: 'payment_setup', missing: setup.missing,
        account: setup.connected ? { status: setup.connected.status, cardPaymentsStatus: setup.connected.cardPaymentsStatus, updatedAt: setup.connected.updatedAt } : null },
      { missing: setup.missing, account: setup.connected ? { id: setup.connected.id, status: setup.connected.status,
        cardPaymentsStatus: setup.connected.cardPaymentsStatus, requirements: setup.connected.requirements, livemode: setup.connected.livemode } : null })
    }
    let availability: unknown = null
    if (input.operation === 'post.create' && input.subjectId !== principal.organizationId) {
      const [kind, resourceId, occurrence] = coordinates()
      if (kind === 'session') {
        const session = await getSessionAvailability(db, principal.env, principal.organizationId, resourceId, occurrence)
        if (session.status !== 'scheduled' || session.starts_at <= new Date().toISOString() || session.remaining === null || session.remaining < 1 || session.is_full) throw missing()
        availability = session
      } else throw missing()
    }
    const kind = input.operation === 'article.create' ? 'article' : 'social_post'
    const [documents, media] = await Promise.all([
      queryAll<{ id: string; kind: string; status: string | null; updatedAt: string }>(db,
        `SELECT id, kind, status, updated_at AS updatedAt FROM content_documents WHERE organization_id = ? AND row_role = 'root' AND kind = ? ORDER BY id`, [principal.organizationId, kind]),
      queryAll<{ id: string; updatedAt: string }>(db, "SELECT id, updated_at AS updatedAt FROM media_assets WHERE organization_id = ? AND status = 'active' ORDER BY id", [principal.organizationId]),
    ])
    const evidence = { kind: 'organization' as const, updatedAt: organization.updated_at, documents, media }
    return result(evidence, availability ? { ...evidence, availability } : evidence)
  }
  if (input.operation === 'post.publish') {
    const post = await queryFirst<{ id: string; status: string | null; updated_at: string } & Record<string, unknown>>(db,
      "SELECT id, title, slug, summary, metadata_json, status, visibility, published_at, updated_at FROM content_documents WHERE id = ? AND organization_id = ? AND kind = 'social_post' AND row_role = 'root'", [input.subjectId, principal.organizationId])
    if (!post) throw missing()
    const [publications, media] = await Promise.all([
      recommendationPublications(db, principal.organizationId, [post.id]),
      readMediaPlacements(db, { organizationId: principal.organizationId, ownerType: 'content_document', ownerIds: [post.id] }),
    ])
    return result({ kind: 'post', status: post.status, updatedAt: post.updated_at, publications }, { post, publications, media: [...media.values()].flat() })
  }
  if (input.operation === 'product.readiness') {
    const product = await getProduct(db, principal.organizationId, input.subjectId)
    const blocker = await experiencePublicationBlocker(db, principal.organizationId, product, principal.env as CloudflareEnv)
    if (!blocker) throw missing()
    const evidence = { kind: 'product_readiness' as const, missing: blocker }
    // A price is missing where the experience is booked, so where that is belongs to the evidence.
    const scope = { online: product.booking?.held_online ?? false, locations: product.locations.filter(entry => entry.published).map(entry => entry.location_id).sort() }
    return result(evidence, blocker === 'host' ? { ...evidence, member: product.booking?.assigned_member_id }
      : blocker === 'variants.prices' ? { ...evidence, scope } : evidence)
  }
  if (input.operation === 'product.payment' || input.operation === 'stay.gap') {
    const interval = input.operation === 'stay.gap' ? coordinates() : null
    if (interval && (!isValidCalendarDate(interval[1]) || !isValidCalendarDate(interval[2]) || interval[2] <= interval[1]
      || (Date.parse(interval[2]) - Date.parse(interval[1])) / 86_400_000 + 2 > MAX_HOMES_CALENDAR_DAYS)) throw missing()
    const productId = interval ? interval[0] : input.subjectId
    const product = await queryFirst<{ id: string; kind: string; updated_at: string }>(db, 'SELECT id, kind, updated_at FROM products WHERE id = ? AND organization_id = ?', [productId, principal.organizationId])
    if (!product) throw missing()
    if (input.operation === 'product.payment') {
      const [configuration, catalog] = await Promise.all([
        queryFirst<{ online_payment_required: number; updated_at: string }>(db,
          'SELECT online_payment_required, updated_at FROM product_booking_configs WHERE product_id = ? AND organization_id = ?', [product.id, principal.organizationId]),
        getProduct(db, principal.organizationId, product.id),
      ])
      return result({ kind: 'product', updatedAt: product.updated_at, paymentRequired: configuration ? configuration.online_payment_required === 1 : null,
        configurationUpdatedAt: configuration?.updated_at ?? null }, { product, configuration, variants: catalog.variants })
    }
    if (product.kind !== 'stay') throw missing()
    const configuration = await queryFirst<{ updated_at: string } & Record<string, unknown>>(db,
      `SELECT c.product_id, c.location_id, b.min_nights, b.calendar_rules, b.updated_at FROM product_stay_configs c
        JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id WHERE c.product_id = ? AND c.organization_id = ?`, [product.id, principal.organizationId])
    if (!configuration) throw missing()
    const from = addLocalDays(interval![1], -1), to = addLocalDays(interval![2], 1)
    if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) throw missing()
    const gap = (await readStayGapCandidates(db, await stayAccessFor(principal), { from, to }))
      .find(gap => gap.productId === product.id && gap.from === interval![1] && gap.to === interval![2])
    if (!gap) throw missing()
    const [overrides, claims, pushes] = await Promise.all([
      queryAll(db, 'SELECT * FROM product_nights WHERE product_id = ? AND organization_id = ? ORDER BY date', [product.id, principal.organizationId]),
      queryAll(db, `SELECT n.date,n.booking_id AS stay_id,n.hold_id,n.calendar_link_id,h.status AS hold_status,h.expires_at,
        CASE WHEN h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 1 ELSE 0 END AS hold_active
        FROM stay_nights n LEFT JOIN payment_checkout_holds h ON h.id=n.hold_id AND h.organization_id=n.organization_id
        WHERE n.product_id = ? AND n.organization_id = ? ORDER BY n.date`, [product.id, principal.organizationId]),
      queryAll(db, 'SELECT * FROM channel_night_pushes WHERE product_id = ? AND organization_id = ? ORDER BY date', [product.id, principal.organizationId]),
    ])
    return result({ kind: 'stay_home', updatedAt: product.updated_at, configurationUpdatedAt: configuration.updated_at }, { product, configuration, overrides, claims, pushes, gap })
  }
  if (input.operation === 'article.update' || input.operation === 'article.publish' || input.operation === 'article.distribute') {
    const document = await queryFirst<{ id: string; status: string | null; updated_at: string } & Record<string, unknown>>(db, `
      SELECT id, title, slug, summary, status, visibility, published_at, seo_keywords, metadata_json, updated_at
      FROM content_documents WHERE id = ? AND organization_id = ? AND kind = 'article' AND row_role = 'root'
    `, [input.subjectId, principal.organizationId])
    if (!document) throw missing()
    const [blocks, categories, activity, documentMedia] = await Promise.all([
      queryAll<{ id: string } & Record<string, unknown>>(db, 'SELECT id, parent_block_id, type, position, level, data_json FROM content_blocks WHERE document_id = ? ORDER BY position, id', [document.id]),
      queryAll(db, 'SELECT category_id FROM article_category_articles WHERE article_id = ? ORDER BY category_id', [document.id]),
      queryFirst<{ id: string }>(db, `SELECT id FROM activity_entries WHERE scope_kind = 'organization' AND organization_id = ? AND kind = 'audit'
        AND event_name IN (SELECT value FROM json_each(?)) AND json_extract(payload_json, '$.entityType') = 'article' AND json_extract(payload_json, '$.entityId') = ?
        ORDER BY occurred_at DESC, id DESC LIMIT 1`, [principal.organizationId, ARTICLE_EVENTS_JSON, document.id]),
      readMediaPlacements(db, { organizationId: principal.organizationId, ownerType: 'content_document', ownerIds: [document.id] }),
    ])
    const blockMedia = await readMediaPlacements(db, { organizationId: principal.organizationId, ownerType: 'content_block', ownerIds: blocks.map(block => block.id) })
    const media = [...documentMedia.values(), ...blockMedia.values()].flat()
    const evidence = {
      kind: 'article' as const, status: document.status, updatedAt: document.updated_at, activityEntryId: activity?.id ?? null,
      media: media.map(item => ({ placementId: item.placement_id, assetId: item.asset_id, assetUpdatedAt: item.updated_at })),
      ...(input.operation === 'article.distribute' ? { distribution: await readArticleDistribution(db, principal, document.id) } : {}),
    }
    return { ...input, evidenceRevision: await creationRequestHash({ operation: input.operation, document, blocks, categories, media, activityEntryId: evidence.activityEntryId, ...(evidence.distribution ? { distribution: evidence.distribution } : {}) }), evidence }
  }
  if (input.operation === 'booking.welcome') {
    const [welcome] = await readBookingWelcomes(db, principal.organizationId, { now: new Date(), requestId: input.subjectId })
    if (!welcome) throw missing()
    return result({ kind: 'booking_welcome', record: { kind: welcome.kind, id: welcome.recordId, status: welcome.status, startsAt: welcome.startsAt }, message: welcome.message })
  }
  const request = await getGuestRequest(db, input.subjectId, principal.organizationId)
  if (!request) throw missing()
  const [commitment, latestGuest, latestReply, latestMember] = await Promise.all([
    getThreadOperationalRecord(db, request.id),
    queryFirst<{ id: string }>(db, `SELECT id FROM activity_entries WHERE request_id = ? AND actor_kind = 'guest' AND kind IN ('submission', 'message') ORDER BY sequence DESC LIMIT 1`, [request.id]),
    queryFirst<{ id: string }>(db, "SELECT id FROM activity_entries WHERE request_id = ? AND actor_kind = 'member' AND kind = 'message' AND event_name = 'thread.member_reply' ORDER BY sequence DESC LIMIT 1", [request.id]),
    queryFirst<{ id: string }>(db, "SELECT id FROM activity_entries WHERE request_id = ? AND actor_kind = 'member' AND kind = 'message' ORDER BY sequence DESC LIMIT 1", [request.id]),
  ])
  const deliveries = latestReply ? await queryAll<GuestThreadDeliveryRow>(db, "SELECT * FROM guest_thread_deliveries WHERE entry_id = ? AND purpose = 'member_reply' ORDER BY id", [latestReply.id]) : []
  const evidence = {
    kind: 'guest_thread' as const, archivedAt: request.archived_at, blockedAt: request.blocked_at,
    latestGuestEntryId: latestGuest?.id ?? null, latestReplyEntryId: latestReply?.id ?? null,
    latestMemberEntryId: latestMember?.id ?? null,
    commitment: commitment ? { kind: commitment.unit === 'nights' ? 'stay' as const : 'booking' as const, id: commitment.id, status: commitment.status, startsAt: commitment.starts_at, endsAt: commitment.ends_at } : null,
  }
  return { ...input, evidenceRevision: await creationRequestHash({ operation: input.operation, evidence, commitment, deliveries }), evidence }
}
