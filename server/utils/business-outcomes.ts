import { HTTPError } from 'nitro'
import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { getGuestRequest, getThreadOperationalRecord } from '~/server/domain/requests'
import { isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'
import { assertOrganizationWideAccess, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { readMediaPlacements } from '~/server/utils/media-asset-manager'
import { creationRequestHash } from '~/server/utils/organization-events'
import { isRecord } from '~/server/utils/type-guards'
import { BUSINESS_ACTIVITY_EVENTS, BUSINESS_MEASUREMENT_EVENTS, BUSINESS_OUTCOME_EVENTS, type BusinessOutcome, type BusinessOutcomeEvent, type BusinessOutcomePage, type BusinessProgressOperation, type BusinessProgressReference } from '~/shared/business-outcomes'
import { CONVERSION_EVENT_CATALOG, type ConversionValue, type OrganizationConversionEventName } from '~/utils/organization-conversion-events'
import type { AttributionTouch } from '~/utils/analytics-attribution'

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
        (a.scope_kind = 'request' AND r.organization_id = ? AND a.kind IN ('message', 'operation', 'resolution'))
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
               'reviewRequestId', review.review_request_id, 'bookingId', review.booking_id, 'bookingType', review.booking_type, 'publicationAuthorized', review.publication_authorized, 'revision', review.updated_at), review.created_at
      FROM reviews review LEFT JOIN requests review_thread ON review_thread.id = review.booking_id
        AND review_thread.organization_id = review.organization_id AND review_thread.kind = review.booking_type
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
        if (row.request_kind !== 'booking' && row.request_kind !== 'reservation' && row.request_kind !== 'stay') {
          invalidEvidence(row, 'Operational activity has no valid recorded request kind')
        }
        subject = { kind: row.request_kind, id: operationalId }
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
        ? payload.state === 'published' || payload.state === 'removed' ? 'verified' : payload.state === 'failed' ? 'failed' : 'unconfirmed'
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
        receipts: deliveries.map(receipt => ({ id: receipt.id, channel: receipt.channel, provider: receipt.provider, status: receipt.status, providerMessageId: receipt.provider_message_id })),
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
    if (paymentId) outcome.references.push({ kind: 'stay_payment', id: paymentId })
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

/** A correction/deferral is about explicit current evidence, never a permanent suppression of a resource. */
export async function readBusinessProgressReference(
  db: DbClient,
  principal: MemberAccessPrincipal,
  input: { operation: BusinessProgressOperation; subjectId: string },
): Promise<BusinessProgressReference> {
  await assertOrganizationWideAccess(db, principal)
  if (typeof input.subjectId !== 'string' || !input.subjectId.trim() || !['article.update', 'article.publish', 'guest_thread.reply'].includes(input.operation)) {
    throw new HTTPError({ statusCode: 400, message: 'An explicit supported operation and subjectId are required', data: { code: 'INVALID_PROGRESS_REFERENCE', field: 'subjectId' } })
  }
  const missing = () => new HTTPError({ statusCode: 404, message: 'Progress subject not found', data: { code: 'PROGRESS_SUBJECT_NOT_FOUND', field: 'subjectId' } })
  if (input.operation !== 'guest_thread.reply') {
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
    }
    return { ...input, evidenceRevision: await creationRequestHash({ operation: input.operation, document, blocks, categories, media, activityEntryId: evidence.activityEntryId }), evidence }
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
    kind: 'guest_thread' as const, conversationState: request.conversation_state, archivedAt: request.archived_at, blockedAt: request.blocked_at,
    latestGuestEntryId: latestGuest?.id ?? null, latestReplyEntryId: latestReply?.id ?? null,
    latestMemberEntryId: latestMember?.id ?? null,
    commitment: commitment ? { kind: commitment.kind, id: commitment.id, status: commitment.status, startsAt: commitment.starts_at, endsAt: commitment.ends_at } : null,
  }
  return { ...input, evidenceRevision: await creationRequestHash({ operation: input.operation, evidence, commitment, deliveries }), evidence }
}
