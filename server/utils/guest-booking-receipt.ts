import { HTTPError } from 'nitro'
import { guestRequestMappingQuery, threadOperationalRecordFromRow, threadOperationalRecordQuery, validateGuestRequest } from '~/server/domain/requests'
import { buyerRequestActivityFromRows, buyerRequestActivityQuery } from '~/server/domain/payments/buyer'
import { retryGuestVisitRefundQuery } from '~/server/domain/payments/visit-refund'
import { paidOnlineFromRows, paidOnlineQuery } from '~/server/domain/payments'
import { ownerPicturesFromRows } from '~/server/notifications/hero'
import type { BatchQuery, DbClient } from '~/server/db'
import { buyerRequestActivityUrl } from '~/server/utils/dashboard-notification-links'
import { mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { publicLocalizationsQuery, indexStoredPublicLocalizations, projectExactLocalizedResource, type StoredPublicLocalizationRow } from '~/server/utils/public-localization'
import { hashReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import { withViewer } from '~/server/utils/member-access'
import { formatBookingPolicySummary, parseBookingPolicy } from '~/server/utils/booking-policy-summary'
import { freeCancellationUntil } from '~/shared/availability-settings'
import type { ProductKind } from '~/shared/product-details'

export async function prepareGuestBookingReceipt(tenant: BatchQuery, requestId: string, token: string, requestedLocale?: string) {
  const hash = await hashReservationCancelToken(token)
  const now = new Date().toISOString()
  const viewer = {
    query: `SELECT r.*, b.product_id AS receipt_product_id, b.location_id AS receipt_location_id,
        b.policy_json, p.kind AS product_kind, p.name AS product_name, l.title AS location_title, l.slug AS location_slug
      FROM conversations r JOIN bookings b ON b.id = r.booking_id AND b.organization_id = r.organization_id
      JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      LEFT JOIN business_locations l ON l.id = b.location_id AND l.organization_id = b.organization_id
      WHERE r.id = ? AND r.organization_id = ${tenant.query} AND r.kind = 'booking' AND b.product_session_id IS NOT NULL
        AND json_extract(r.payload_json, '$.cancellation.token_hash') = ?
        AND json_extract(r.payload_json, '$.cancellation.expires_at') > ?`,
    params: [requestId, ...tenant.params ?? [], hash, now],
  }
  const organization = { query: '(SELECT organization_id FROM viewer)' }
  const booking = { query: '(SELECT booking_id FROM viewer)' }
  const conversation = { sql: '(SELECT id FROM viewer)' }
  const photographs = mediaPlacementsQuery({
    organizationId: { sql: organization.query },
    ownerType: { sql: "(SELECT CASE WHEN product_kind = 'table' AND receipt_location_id IS NOT NULL THEN 'business_location' ELSE 'product' END FROM viewer)" },
    owners: { sql: "SELECT CASE WHEN product_kind = 'table' AND receipt_location_id IS NOT NULL THEN receipt_location_id ELSE receipt_product_id END FROM viewer" },
    includeOrganizationFallback: true,
  })
  const queries = [
    viewer,
    ...[
      threadOperationalRecordQuery(conversation),
      guestRequestMappingQuery(conversation, { sql: organization.query }),
      photographs,
      paidOnlineQuery(organization, booking),
      retryGuestVisitRefundQuery(organization, booking, requestId),
      buyerRequestActivityQuery({ organizationId: organization, conversationId: requestId }),
      ...(requestedLocale ? [publicLocalizationsQuery({ sql: organization.query }, requestedLocale)] : []),
    ].map(query => withViewer(viewer, query)),
  ]
  return { queries, read }

  async function read(db: DbClient, env: Parameters<typeof buyerRequestActivityUrl>[0], organizationId: string,
    locale: string, source: boolean, [requestRows, records, mapping, media, payments, refunds, activity, translations]: D1Result[]) {
    const row = requestRows!.results[0] as Record<string, unknown> & {
      organization_id: string; product_kind: ProductKind; product_name: string; policy_json: string;
      location_title: string | null; location_slug: string | null;
    } | undefined
    if (!row || row.organization_id !== organizationId) return null
    const request = await validateGuestRequest(db, row, Boolean(mapping!.results.length))
    const record = threadOperationalRecordFromRow(records!.results[0])
    if (request.kind !== 'booking' || !record || record.unit !== 'slot') return null
    if (record.location_id && (row.location_title === null || row.location_slug === null)) {
      throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
    }

    const localizations = source ? [] : indexStoredPublicLocalizations(translations!.results as StoredPublicLocalizationRow[])
    const product = { id: record.product_id, kind: row.product_kind, name: row.product_name }
    const translatedProduct = localizations.find(item => item.resourceType === 'product' && item.resourceId === product.id)
    const location = record.location_id ? { id: record.location_id, title: row.location_title, slug: row.location_slug } : null
    const translatedLocation = localizations.find(item => item.resourceType === 'business_location' && item.resourceId === location?.id)
    const displayedLocation = translatedLocation && location ? projectExactLocalizedResource('business_location', location, translatedLocation) : location

    const [ownerType, ownerId] = product.kind === 'table' && record.location_id
      ? ['business_location', record.location_id] as const : ['product', record.product_id] as const
    const picture = ownerPicturesFromRows(organizationId, ownerType, [ownerId], media!.results).get(ownerId)
    const paid = paidOnlineFromRows(payments!.results)
    return {
      kind: 'booking' as const,
      name: request.payload.guest.name,
      email: request.payload.guest.email,
      starts_at: record.starts_at,
      timezone: record.timezone,
      guests: `${record.party_size}${record.party_size_is_minimum ? '+' : ''}`,
      status: record.status,
      can_retry_cancellation: Boolean(refunds!.results.length),
      refund_on_cancel: paid !== null && now <= freeCancellationUntil(record.starts_at, record.advance_notice_minutes),
      advance_notice_minutes: record.advance_notice_minutes,
      locale,
      product_id: record.product_id,
      product_kind: product.kind,
      product_name: translatedProduct ? projectExactLocalizedResource('product', product, translatedProduct).name : product.name,
      location_id: record.location_id,
      location_name: displayedLocation?.title ?? null,
      location_slug: displayedLocation?.slug ?? null,
      policy_summary: formatBookingPolicySummary(parseBookingPolicy(row.policy_json), locale, product.kind),
      paid,
      image_url: picture?.imageUrl ?? null,
      manage_url: buyerRequestActivityUrl(env, buyerRequestActivityFromRows(activity!.results), requestId),
    }
  }
}

export type GuestReceiptRead = {
  requestId: string
  locale: string | undefined
  plan: Awaited<ReturnType<typeof prepareGuestBookingReceipt>>
  rows: D1Result[]
}
