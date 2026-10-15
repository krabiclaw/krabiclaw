import { getGuestRequest, getThreadOperationalRecord } from '~/server/domain/requests'
import { canRetryGuestReservationRefund } from '~/server/domain/payments/visit-refund'
import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { hashReservationCancelToken, readBearerToken } from '~/server/utils/reservation-cancel-token'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { loadExactPublicLocalizations, projectExactLocalizedResource } from '~/server/utils/public-localization'
import { getProduct } from '~/server/utils/product-management'
import { productPolicySummarySource, renderBookingPolicySummary } from '~/server/utils/reservations'
import type { BookingPolicySummarySource } from '~/server/utils/booking-policy-summary'
import type { ProductKind } from '~/shared/product-details'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

/**
 * What a guest's cancellation link refers to.
 *
 * One route for both kinds: a booking and a reservation differ in what holds
 * the seats, not in what the guest is shown, and the thread's `kind` already
 * says which it is. The when and the party size are read from the operational
 * record, never from the thread — the thread stopped carrying a copy of them
 * precisely so the two could not disagree.
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
    SELECT r.id FROM requests r
     WHERE r.id = ? AND r.organization_id = ? AND r.kind IN ('reservation', 'booking')
       AND json_extract(r.payload_json, '$.cancellation.token_hash') = ?
       AND json_extract(r.payload_json, '$.cancellation.expires_at') > ?
     LIMIT 1
  `, [requestId, organizationId, tokenHash, new Date().toISOString()])
  if (!readable) return jsonResponse({ error: 'Booking not found' }, { status: 404 })

  const request = await getGuestRequest(db, requestId, organizationId)
  const record = request ? await getThreadOperationalRecord(db, request.id) : null
  if (!request || request.kind === 'contact' || request.kind === 'stay' || !record || record.organization_id !== organizationId) {
    return jsonResponse({ error: 'Booking not found' }, { status: 404 })
  }

  const sourceLocale = await getSourceLocale(db, organizationId)
  const locale = assertExactCanonicalLocale(getQuery(event).locale ?? sourceLocale)
  await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  const [localizations, canonicalLocation] = await Promise.all([
    locale === sourceLocale ? [] : loadExactPublicLocalizations(env, db, organizationId, locale),
    record.location_id ? queryFirst<{ id: string; title: string; slug: string }>(db, 'SELECT id, title, slug FROM business_locations WHERE id = ? AND organization_id = ?', [record.location_id, organizationId]) : null,
  ])
  if (record.location_id && !canonicalLocation) return jsonResponse({ error: 'Location not found' }, { status: 404 })
  const locationTranslation = localizations.find(item => item.resourceType === 'business_location' && item.resourceId === record.location_id)
  const location = locationTranslation && canonicalLocation
    ? projectExactLocalizedResource('business_location', canonicalLocation, locationTranslation)
    : canonicalLocation
  let productName = record.product_name
  let productKind: ProductKind | null = null
  let policy: BookingPolicySummarySource | null = null
  if (record.kind === 'booking' && record.product_id) {
    const canonical = await getProduct(db, organizationId, record.product_id)
    const translation = localizations.find(item => item.resourceType === 'product' && item.resourceId === record.product_id)
    const product = translation ? projectExactLocalizedResource('product', canonical, translation) : canonical
    productName = product.name
    productKind = product.kind
    policy = productPolicySummarySource(locale === sourceLocale || translation ? product.details : {})
  } else if (record.kind === 'reservation') {
    const saved = await queryFirst<{ policy_json: string | null }>(db, 'SELECT policy_json FROM reservations WHERE id = ? AND organization_id = ?', [record.id, organizationId])
    if (!saved) return jsonResponse({ error: 'Booking not found' }, { status: 404 })
    policy = saved.policy_json ? JSON.parse(saved.policy_json) as BookingPolicySummarySource : null
    if (policy && locale !== sourceLocale) {
      const translated = locationTranslation?.values.reservation as { policy?: { additional_notes_html?: string } } | undefined
      policy = { ...policy, additional_notes_html: translated?.policy?.additional_notes_html ?? null }
    }
  }

  return jsonResponse({
    success: true,
    booking: {
      kind: record.kind,
      name: request.payload.guest.name,
      starts_at: record.starts_at,
      timezone: record.timezone,
      guests: `${record.party_size}${request.payload.party_size_is_minimum ? '+' : ''}`,
      status: record.status,
      can_retry_cancellation: record.kind === 'reservation' && await canRetryGuestReservationRefund(db, { organizationId, reservationId: record.id, requestId: request.id }),
      locale,
      product_id: record.product_id,
      product_kind: productKind,
      product_name: productName,
      location_id: record.location_id,
      location_name: location?.title ?? null,
      location_slug: location?.slug ?? null,
      policy_summary: policy ? renderBookingPolicySummary(policy, locale, productKind) : null,
    },
  }, { headers: { 'cache-control': 'private, no-store' } })
})
