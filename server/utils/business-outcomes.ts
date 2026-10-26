import { HTTPError } from 'nitro'
import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { getGuestRequest, getThreadOperationalRecord } from '~/server/domain/requests'
import { isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'
import { assertOrganizationWideAccess, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { readMediaPlacements } from '~/server/utils/media-asset-manager'
import { creationRequestHash } from '~/server/utils/organization-events'
import { BUSINESS_OUTCOME_EVENTS, type BusinessOutcome, type BusinessOutcomeEvent, type BusinessOutcomePage, type BusinessProgressOperation, type BusinessProgressReference } from '~/shared/business-outcomes'

interface OutcomeEntry {
  id: string
  event_name: BusinessOutcomeEvent
  actor_kind: BusinessOutcome['actor']['kind']
  actor_user_id: string | null
  request_id: string | null
  channel: string | null
  payload_json: string
  occurred_at: string
}

const ARTICLE_EVENTS_JSON = d1JsonStringSet(BUSINESS_OUTCOME_EVENTS.filter(event => event !== 'thread.member_reply'))

/** Derived facts, never a second completion ledger. Staff assignment projections are not exposed by this organization-wide endpoint. */
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
    SELECT a.id, a.event_name, a.actor_kind, a.actor_user_id, a.request_id, a.channel, a.payload_json, a.occurred_at
    FROM activity_entries a LEFT JOIN requests r ON r.id = a.request_id AND a.scope_kind = 'request'
    WHERE (a.scope_kind = 'organization' AND a.organization_id = ? AND a.kind = 'audit' AND a.event_name IN (SELECT value FROM json_each(?)))
      OR (a.scope_kind = 'request' AND r.organization_id = ? AND a.kind = 'message' AND a.actor_kind = 'member' AND a.event_name = 'thread.member_reply')
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT ? OFFSET ?
  `, [principal.organizationId, ARTICLE_EVENTS_JSON, principal.organizationId, limit + 1, offset])
  const page = rows.slice(0, limit)
  const receipts = page.length ? await queryAll<GuestThreadDeliveryRow>(db, `
    SELECT * FROM guest_thread_deliveries WHERE purpose = 'member_reply'
      AND entry_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, id DESC
  `, [d1JsonStringSet(page.filter(row => row.event_name === 'thread.member_reply').map(row => row.id))]) : []
  const outcomes = page.map((row): BusinessOutcome => {
    const reply = row.event_name === 'thread.member_reply'
    const payload = JSON.parse(row.payload_json) as { entityType?: unknown; entityId?: unknown }
    if (!reply && (payload.entityType !== 'article' || typeof payload.entityId !== 'string' || !payload.entityId.trim())) {
      throw new HTTPError({ statusCode: 500, message: 'Article activity has no canonical subject', data: { code: 'INVALID_PROGRESS_EVIDENCE', entry_id: row.id } })
    }
    if (reply && (!row.request_id || !['web', 'email', 'airbnb'].includes(row.channel ?? ''))) {
      throw new HTTPError({ statusCode: 500, message: 'Member reply has no supported canonical destination', data: { code: 'INVALID_PROGRESS_EVIDENCE', entry_id: row.id } })
    }
    const deliveries = receipts.filter(receipt => receipt.entry_id === row.id && receipt.channel === row.channel)
    // log_only deliberately records sent locally; it is not external provider acceptance.
    const accepted = deliveries.some(receipt => receipt.provider !== 'log_only' && isDeliverySent(receipt))
    if (deliveries.some(receipt => receipt.provider === 'channex' && isDeliverySent(receipt) && !receipt.provider_message_id?.trim())) {
      throw new HTTPError({ statusCode: 500, message: 'A successful channel reply has no provider message ID', data: { code: 'CHANNEL_RECEIPT_INVALID', field: 'delivery.provider_message_id' } })
    }
    const stored = !reply || row.channel === 'web'
    return {
      id: row.id, event: row.event_name,
      subject: { kind: reply ? 'guest_thread' : 'article', id: reply ? row.request_id! : payload.entityId as string },
      actor: { kind: row.actor_kind, userId: row.actor_user_id }, occurredAt: row.occurred_at,
      verification: {
        status: stored || accepted ? 'verified' : deliveries.length > 0 && deliveries.every(receipt => receipt.status === 'failed') ? 'failed' : 'unconfirmed',
        basis: !reply ? 'persisted_change' : row.channel === 'web' ? 'stored_web_reply' : 'provider_acceptance',
        receipts: deliveries.map(receipt => ({ id: receipt.id, channel: receipt.channel, provider: receipt.provider, status: receipt.status, providerMessageId: receipt.provider_message_id })),
      },
    }
  })
  const hasMore = rows.length > limit
  return {
    outcomes, pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
    coverage: {
      supportedEvents: BUSINESS_OUTCOME_EVENTS, attribution: 'recorded_actor_only', article: 'persisted_change_only',
      webReply: 'stored_message_only', externalReply: 'provider_acceptance_requires_receipt',
      unverified: ['public_visibility', 'operation_completion', 'recipient_notification', 'conversation_resolution', 'business_goal_achievement'],
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
  const [commitment, latestGuest, latestReply] = await Promise.all([
    getThreadOperationalRecord(db, request.id),
    queryFirst<{ id: string }>(db, `SELECT id FROM activity_entries WHERE request_id = ? AND actor_kind = 'guest' AND kind IN ('submission', 'message') ORDER BY sequence DESC LIMIT 1`, [request.id]),
    queryFirst<{ id: string }>(db, "SELECT id FROM activity_entries WHERE request_id = ? AND actor_kind = 'member' AND kind = 'message' AND event_name = 'thread.member_reply' ORDER BY sequence DESC LIMIT 1", [request.id]),
  ])
  const deliveries = latestReply ? await queryAll<GuestThreadDeliveryRow>(db, "SELECT * FROM guest_thread_deliveries WHERE entry_id = ? AND purpose = 'member_reply' ORDER BY id", [latestReply.id]) : []
  const evidence = {
    kind: 'guest_thread' as const, conversationState: request.conversation_state, archivedAt: request.archived_at, blockedAt: request.blocked_at,
    latestGuestEntryId: latestGuest?.id ?? null, latestReplyEntryId: latestReply?.id ?? null,
    commitment: commitment ? { kind: commitment.kind, id: commitment.id, status: commitment.status, startsAt: commitment.starts_at, endsAt: commitment.ends_at } : null,
  }
  return { ...input, evidenceRevision: await creationRequestHash({ operation: input.operation, evidence, commitment, deliveries }), evidence }
}
