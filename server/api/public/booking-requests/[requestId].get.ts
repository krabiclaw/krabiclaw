import { getGuestRequest, getThreadOperationalRecord } from '~/server/domain/requests'
import { canRetryGuestVisitRefund } from '~/server/domain/payments/visit-refund'
import { paidOnline } from '~/server/domain/payments'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { hashReservationCancelToken, readBearerToken } from '~/server/utils/reservation-cancel-token'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguage } from '~/server/utils/localization'
import { loadExactPublicLocalizations, projectExactLocalizedResource } from '~/server/utils/public-localization'
import { getProduct } from '~/server/utils/product-management'
import { formatBookingPolicySummary, parseBookingPolicy } from '~/server/utils/booking-policy-summary'
import { freeCancellationUntil } from '~/shared/availability-settings'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { buildBuyerRequestActivityUrl } from '~/server/utils/dashboard-notification-links'

/**
 * What a guest's cancellation link refers to.
 *
 * A class, a consultation or a table: the when and the party size are read
 * from the booking, never from the thread — the thread stopped carrying a copy
 * of them precisely so the two could not disagree — and the terms are the
 * ones frozen on the booking when it was made.
 */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const requestId = getRouterParam(event, 'requestId')
  const token = readBearerToken(event.req.headers.get('authorization'))
  if (!organizationId || !requestId || !token) {
    return jsonResponse({ error: 'Missing required parameters' }, { status: 400 })
  }

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const tokenHash = await hashReservationCancelToken(token)
  // Reading the receipt remains valid after spending the cancellation token.
  // Cancellation writes still enforce the token's single-use boundary.
  const readable = await queryFirst<{ id: string }>(db, `
    SELECT r.id FROM conversations r
     WHERE r.id = ? AND r.organization_id = ? AND r.kind = 'booking'
       AND json_extract(r.payload_json, '$.cancellation.token_hash') = ?
       AND json_extract(r.payload_json, '$.cancellation.expires_at') > ?
     LIMIT 1
  `, [requestId, organizationId, tokenHash, new Date().toISOString()])
  if (!readable) return jsonResponse({ error: 'Booking not found' }, { status: 404 })

  const request = await getGuestRequest(db, requestId, organizationId)
  const record = request ? await getThreadOperationalRecord(db, request.id) : null
  if (!request || request.kind !== 'booking' || !record || record.unit !== 'slot' || record.organization_id !== organizationId) {
    return jsonResponse({ error: 'Booking not found' }, { status: 404 })
  }

  const sourceLocale = await getSourceLocale(db, organizationId)
  const locale = assertExactCanonicalLocale(getQuery(event).locale ?? sourceLocale)
  await assertPublicOrganizationLanguage(db, organizationId, locale)
  const [localizations, canonicalLocation] = await Promise.all([
    locale === sourceLocale ? [] : loadExactPublicLocalizations(env, db, organizationId, locale),
    record.location_id ? queryFirst<{ id: string; title: string; slug: string }>(db, 'SELECT id, title, slug FROM business_locations WHERE id = ? AND organization_id = ?', [record.location_id, organizationId]) : null,
  ])
  if (record.location_id && !canonicalLocation) return jsonResponse({ error: 'Location not found' }, { status: 404 })
  const locationTranslation = localizations.find(item => item.resourceType === 'business_location' && item.resourceId === record.location_id)
  const location = locationTranslation && canonicalLocation
    ? projectExactLocalizedResource('business_location', canonicalLocation, locationTranslation)
    : canonicalLocation
  const canonical = await getProduct(db, organizationId, record.product_id)
  const translation = localizations.find(item => item.resourceType === 'product' && item.resourceId === record.product_id)
  const product = translation ? projectExactLocalizedResource('product', canonical, translation) : canonical
  const saved = await queryFirst<{ policy_json: string }>(db, 'SELECT policy_json FROM bookings WHERE id = ? AND organization_id = ?', [record.id, organizationId])
  if (!saved) return jsonResponse({ error: 'Booking not found' }, { status: 404 })

  // The receipt leads with what was booked, pictured as its page pictures it: a table by its place, anything else by its own photo.
  const [ownerType, ownerId] = product.kind === 'table' && record.location_id ? ['business_location', record.location_id] as const : ['product', record.product_id] as const
  const picture = (await loadOwnerPictures(db, organizationId, ownerType, [ownerId])).get(ownerId) ?? null

  const paid = await paidOnline(db, organizationId, record.id)

  return jsonResponse({
    success: true,
    booking: {
      kind: 'booking',
      name: request.payload.guest.name,
      email: request.payload.guest.email,
      starts_at: record.starts_at,
      timezone: record.timezone,
      guests: `${record.party_size}${record.party_size_is_minimum ? '+' : ''}`,
      status: record.status,
      can_retry_cancellation: await canRetryGuestVisitRefund(db, { organizationId, bookingId: record.id, requestId: request.id }),
      refund_on_cancel: paid !== null && new Date().toISOString() <= freeCancellationUntil(record.starts_at, record.advance_notice_minutes),
      // The guest's own cancellation closes at the offering's advance notice; null is no notice.
      advance_notice_minutes: record.advance_notice_minutes,
      locale,
      product_id: record.product_id,
      product_kind: product.kind,
      product_name: product.name,
      location_id: record.location_id,
      location_name: location?.title ?? null,
      location_slug: location?.slug ?? null,
      policy_summary: formatBookingPolicySummary(parseBookingPolicy(saved.policy_json), locale, product.kind),
      paid,
      image_url: picture?.imageUrl ?? null,
      manage_url: await buildBuyerRequestActivityUrl(env, db, { organizationId, threadId: request.id }),
    },
  }, { headers: { 'cache-control': 'private, no-store' } })
})
