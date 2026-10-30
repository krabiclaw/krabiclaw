import { getPublicConsultationSettings } from '~/server/utils/professional-services'
import { boundedOccurrence, isCanonicalEventId, isKnownBot } from '~/server/utils/pageview-tracking'
import { readBody } from 'nitro/h3'
import { queryAll, queryFirst } from '~/server/db'
import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { HOUR_MS, getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { recordOrganizationConversionEvent, type ConversionEntityType, type ConversionStage } from '~/server/utils/organization-conversions'
import { BROWSER_INTERACTION_EVENT_NAMES, CONVERSION_EVENT_CATALOG, type OrganizationConversionEventName } from '~/utils/organization-conversion-events'
import { normalizeVertical } from '~/utils/vertical-copy'
import { dialsSameNumber } from '~/utils/phone'
import { PUBLIC_PRODUCT_SQL } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'

// Only public interactions arrive here; every outcome is produced by the server, and signed-in
// product-usage events have their own authenticated endpoint.
const VALID_EVENTS = new Set<string>(BROWSER_INTERACTION_EVENT_NAMES.filter(name => CONVERSION_EVENT_CATALOG[name].origin === 'public'))

function destinationHost(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'organizationId required' }, { status: 400 })
  const db = cloudflareEnv(event).db
  if (!db) return jsonResponse({ error: 'Database unavailable' }, { status: 503 })
  if (isKnownBot((event.req.headers.get('user-agent') || '').slice(0, 1024))) return jsonResponse({ ok: true, ignored: true })
  let body: ApiRecord
  try { body = await readBody(event) } catch { return jsonResponse({ error: 'Invalid request body' }, { status: 400 }) }

  const eventName = cleanString(body.event_name, 80)
  // The interaction's own identity, chosen by the browser when it happened: the same one delivered
  // twice is one event, two interactions are two.
  const eventId = body.event_id === undefined ? undefined : body.event_id
  if (eventId !== undefined && !isCanonicalEventId(eventId)) return jsonResponse({ error: 'event_id must be a UUID' }, { status: 400 })
  const pageEventId = body.page_event_id === undefined ? null : body.page_event_id
  if (pageEventId !== null && !isCanonicalEventId(pageEventId)) return jsonResponse({ error: 'page_event_id must be a UUID' }, { status: 400 })
  if (!VALID_EVENTS.has(eventName)) return jsonResponse({ error: 'Invalid event_name' }, { status: 400 })
  const organization = await queryFirst<{ id: string; vertical: string | null }>(db,
    `SELECT id, vertical FROM organization WHERE id = ? AND status = 'active' AND onboarding_status = 'active' LIMIT 1`, [organizationId])
  if (!organization || !normalizeVertical(organization.vertical)) return jsonResponse({ error: 'Organization not found' }, { status: 404 })

  const ipHash = await hashClientIp(getClientIp(event))
  const hour = new Date().toISOString().slice(0, 13)
  if (!await incrementHourlyRateLimit(db, `rate:conversion:${organizationId}:ip:${ipHash}:${hour}`, import.meta.dev ? 1000 : 120, HOUR_MS)) {
    return jsonResponse({ error: 'Too many events. Please try again later.' }, { status: 429 })
  }

  let stage: ConversionStage
  let entityType: ConversionEntityType | null = null
  let entityId: string | null = null
  let locationId: string | null = null
  let pageType: string | null = null
  let pagePath: string | null = null
  let ctaDestination: string | null = null
  let metadata: ApiRecord | null = null
  let variantId: string | null = null

  if (eventName === 'consultation_cta_click') {
    if (body.stage !== 'schedule_navigation' && body.stage !== 'external_booking_handoff') return jsonResponse({ error: 'Invalid consultation stage' }, { status: 400 })
    stage = body.stage
    pageType = cleanString(body.page_type, 80) || null
    pagePath = cleanString(body.page_path, 300) || null
    if (pagePath && (!pagePath.startsWith('/') || pagePath.includes('?') || pagePath.includes('#'))) return jsonResponse({ error: 'Invalid page_path' }, { status: 400 })
    const pageId = cleanString(body.page_id, 120)
    if (pageId) {
      const page = await queryFirst<{ id: string }>(db, "SELECT id FROM content_documents WHERE kind = 'page' AND id = ? AND organization_id = ? LIMIT 1", [pageId, organizationId])
      if (!page) return jsonResponse({ error: 'Page not found' }, { status: 404 })
      entityType = 'content_document'; entityId = page.id
    }
    if (stage === 'external_booking_handoff') {
      const consultation = await getPublicConsultationSettings(db, organizationId)
      const host = consultation.mode === 'external_url' && consultation.external_url ? destinationHost(consultation.external_url) : null
      if (!host) return jsonResponse({ error: 'Consultation destination is unavailable' }, { status: 404 })
      ctaDestination = host
      metadata = { destination_hostname: host }
    } else {
      ctaDestination = '/schedule'
    }
  } else if (eventName === 'product_order_external_click') {
    stage = 'external_handoff'
    if (!Object.hasOwn(body, 'location_id') || (body.location_id !== null && (typeof body.location_id !== 'string' || !body.location_id.trim()))) return jsonResponse({ error: 'Supply location_id, or explicit null for an online offering' }, { status: 400 })
    locationId = cleanString(body.location_id, 120) || null
    entityId = cleanString(body.product_id, 120) || null
    if (!entityId) return jsonResponse({ error: 'product_id is required' }, { status: 400 })
    const product = await queryFirst<{ id: string; order_url: string }>(db, `
      SELECT p.id, p.order_url FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id AND pub.published = 1
      WHERE p.organization_id = ? AND p.id = ? AND p.active = 1 AND p.order_url IS NOT NULL
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM product_locations pl JOIN business_locations bl ON bl.id = pl.location_id AND bl.organization_id = pl.organization_id
          WHERE pl.product_id = p.id AND pl.organization_id = p.organization_id AND pl.location_id = ?
            AND pl.published = 1 AND pl.active = 1 AND bl.status = 'active'
        )) LIMIT 1`, [organizationId, entityId, locationId, locationId])
    if (!product || !destinationHost(product.order_url)) return jsonResponse({ error: 'Product not found' }, { status: 404 })
    const destinationHostname = new URL(product.order_url).hostname.toLowerCase()
    entityType = 'product'; ctaDestination = destinationHostname; pageType = 'product'; metadata = { product_id: product.id, destination_hostname: destinationHostname }
  } else if (eventName === 'checkout_start' && !body.product_id) {
    stage = 'started'
    locationId = cleanString(body.location_id, 120) || null
    const location = locationId ? await queryFirst<{ id: string }>(db,
      "SELECT id FROM business_locations WHERE id = ? AND organization_id = ? AND status = 'active' LIMIT 1", [locationId, organizationId]) : null
    if (!location) return jsonResponse({ error: 'Reservation location not found' }, { status: 404 })
    pageType = 'reservations'
  } else if (eventName === 'product_view' || eventName === 'checkout_start') {
    stage = eventName === 'product_view' ? 'viewed' : 'started'
    locationId = cleanString(body.location_id, 120) || null
    entityId = cleanString(body.product_id, 120) || null
    if (!entityId) return jsonResponse({ error: 'product_id is required' }, { status: 400 })
    // A view may precede location selection or observe a published paused
    // offering. Checkout requires an active offering at its actual scope.
    const product = await queryFirst<{ id: string }>(db, `
      SELECT p.id FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id AND pub.organization_id = ? AND pub.published = 1
      WHERE p.id = ? AND ${PUBLIC_PRODUCT_SQL}${eventName === 'checkout_start' ? ' AND p.active = 1' : ''} AND ${locationId
        ? `EXISTS (SELECT 1 FROM product_locations pl JOIN business_locations bl ON bl.id = pl.location_id AND bl.organization_id = pl.organization_id
             WHERE pl.product_id = p.id AND pl.organization_id = p.organization_id AND pl.location_id = ? AND pl.published = 1${eventName === 'checkout_start' ? ' AND pl.active = 1' : ''} AND bl.status = 'active')`
        : `(p.order_url IS NOT NULL OR EXISTS (SELECT 1 FROM product_booking_configs cfg WHERE cfg.product_id = p.id AND cfg.organization_id = p.organization_id AND cfg.held_online = 1)
            ${eventName === 'product_view' ? `OR EXISTS (SELECT 1 FROM product_locations pl JOIN business_locations bl ON bl.id = pl.location_id AND bl.organization_id = pl.organization_id
              WHERE pl.product_id = p.id AND pl.organization_id = p.organization_id AND pl.published = 1 AND bl.status = 'active')` : ''})`}
      LIMIT 1`, [organizationId, entityId, ...(locationId ? [locationId] : [])])
    if (!product) return jsonResponse({ error: 'Product not found' }, { status: 404 })
    entityType = 'product'; pageType = 'product'
    const requestedVariant = cleanString(body.variant_id, 120)
    if (requestedVariant) {
      const variant = await queryFirst<{ id: string }>(db, 'SELECT id FROM product_variants WHERE id = ? AND product_id = ? AND organization_id = ? AND active = 1 LIMIT 1', [requestedVariant, product.id, organizationId])
      if (!variant) return jsonResponse({ error: 'Variant not found' }, { status: 404 })
      variantId = variant.id
    }
  } else if (eventName === 'link_click') {
    stage = 'external_handoff'
    entityId = cleanString(body.link_item_id, 120) || null
    if (!entityId) return jsonResponse({ error: 'link_item_id is required' }, { status: 400 })
    const link = await queryFirst<{ id: string; label: string; destination: string; sort_order: number; page_path: string }>(db, `SELECT b.id, (b.data_json ->> '$.label') AS label, (source.data_json ->> '$.url') AS destination, source.position AS sort_order, d.path AS page_path
      FROM content_blocks b JOIN content_documents d ON d.id = b.document_id
      JOIN content_documents root ON root.id = COALESCE(d.root_id,d.id)
      JOIN content_blocks source ON source.id = COALESCE(b.source_block_id,b.id)
      WHERE b.id = ? AND d.organization_id = ? AND b.type = 'cta' AND root.kind = 'page' AND root.row_role = 'root'
        AND (root.metadata_json ->> '$.recipe') = 'links' AND (source.data_json ->> '$.status') = 'active' LIMIT 1`, [entityId, organizationId])
    const host = link ? destinationHost(link.destination) : null
    if (!link || !host) return jsonResponse({ error: 'Link item not found' }, { status: 404 })
    entityType = 'content_block'; ctaDestination = host; pageType = 'links'; pagePath = link.page_path
    metadata = { link_label: link.label, position: Number(link.sort_order) + 1, destination_hostname: host }
  } else if (eventName === 'donation_click') {
    stage = 'external_handoff'
    const documentId = cleanString(body.document_id, 120)
    const tierLabel = cleanString(body.tier_label, 100)
    const tierAmount = body.tier_amount == null ? null : Number(body.tier_amount)
    if (!documentId || !tierLabel || (tierAmount !== null && (!Number.isFinite(tierAmount) || tierAmount <= 0))) return jsonResponse({ error: 'Valid document_id and donation choice are required' }, { status: 400 })
    const page = await queryFirst<{ id: string; page_id: string; path: string }>(db, `
      SELECT v.id, root.id AS page_id, v.path
        FROM content_documents v JOIN content_documents root ON root.id = COALESCE(v.root_id,v.id)
       WHERE v.id = ? AND v.organization_id = ? AND root.kind = 'page' AND root.row_role = 'root' AND (root.metadata_json ->> '$.recipe') = 'donate'
       LIMIT 1
    `, [documentId, organizationId])
    if (!page) return jsonResponse({ error: 'Donation page not found' }, { status: 404 })
    const blocks = await queryAll<{ data_json: string }>(db, `SELECT cb.data_json FROM content_documents cd JOIN content_blocks cb ON cb.document_id = cd.id WHERE cd.id = ? AND cb.type = 'donation_choices'`, [documentId])
    // data_json is this tenant's own stored block. Unparseable means the row is
    // corrupt, and dropping it turned that corruption into "Donation page not
    // found" — a 404 that sent the reader looking for a page that exists.
    const choices = blocks.flatMap((row) => {
      const data = JSON.parse(row.data_json) as ApiRecord
      const host = typeof data.destination === 'string' ? destinationHost(data.destination) : null
      const tiers = Array.isArray(data.tiers) ? data.tiers : []
      return host ? [{ host, tiers }] : []
    })
    const choice = choices.find(({ tiers }) => tierLabel === 'Custom Amount'
      ? tierAmount === null
      : tiers.some((candidate: unknown) => {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
          const tier = candidate as ApiRecord
          return tier.title === tierLabel && Number(tier.amount) === tierAmount
        }))
    if (!choice) return jsonResponse({ error: 'Donation choice is not published' }, { status: 400 })
    entityType = 'content_document'; entityId = page.id; pageType = 'donate'; pagePath = page.path; ctaDestination = choice.host
    metadata = { tier_label: tierLabel, ...(tierAmount === null ? {} : { tier_amount: tierAmount }), destination_hostname: choice.host }
  } else if (eventName === 'announcement_view') {
    stage = 'viewed'
    pagePath = cleanString(body.page_path, 300) || null
    if (pagePath && (!pagePath.startsWith('/') || pagePath.includes('?') || pagePath.includes('#'))) return jsonResponse({ error: 'Invalid page_path' }, { status: 400 })
  } else if (eventName === 'announcement_cta_click') {
    stage = 'external_handoff'
    pagePath = cleanString(body.page_path, 300) || null
    if (pagePath && (!pagePath.startsWith('/') || pagePath.includes('?') || pagePath.includes('#'))) return jsonResponse({ error: 'Invalid page_path' }, { status: 400 })
    // The destination is this organization's currently configured, currently enabled
    // announcement CTA, never whatever the client claims it followed.
    const announcement = await queryFirst<{ cta_url: string | null, enabled: number | null }>(db, `
      SELECT json_extract(settings_json, '$.config.announcement.cta_url') AS cta_url,
             json_extract(settings_json, '$.config.announcement.enabled') AS enabled
        FROM organization WHERE id = ? LIMIT 1
    `, [organizationId])
    if (!announcement || announcement.enabled === 0 || !announcement.cta_url) return jsonResponse({ error: 'Announcement CTA is unavailable' }, { status: 404 })
    const host = destinationHost(announcement.cta_url)
    if (!host) return jsonResponse({ error: 'Announcement CTA is unavailable' }, { status: 404 })
    ctaDestination = host
    metadata = { destination_hostname: host }
  } else if (eventName === 'phone_click') {
    stage = 'external_handoff'
    pagePath = cleanString(body.page_path, 300) || null
    if (pagePath && (!pagePath.startsWith('/') || pagePath.includes('?') || pagePath.includes('#'))) return jsonResponse({ error: 'Invalid page_path' }, { status: 400 })
    const dialed = cleanString(body.phone, 40)
    if (!dialed) return jsonResponse({ error: 'phone is required' }, { status: 400 })
    // A call counts only to the business's own number, the one a live location lists; a page may
    // also link to someone else's number, and that call is not this business's lead. A number two
    // locations share names neither of them.
    const locations = await queryAll<{ id: string; phone: string }>(db,
      "SELECT id, phone FROM business_locations WHERE organization_id = ? AND status = 'active' AND phone IS NOT NULL", [organizationId])
    const matches = locations.filter(candidate => dialsSameNumber(candidate.phone, dialed))
    if (matches.length === 0) return jsonResponse({ ok: true, ignored: true })
    locationId = matches.length === 1 ? matches[0]!.id : null; ctaDestination = 'tel'
  } else {
    return jsonResponse({ error: 'Submission conversions are server-produced' }, { status: 400 })
  }

  const result = await recordOrganizationConversionEvent(db, event.req, {
    organizationId: organization.id, eventName: eventName as OrganizationConversionEventName,
    stage, locationId, entityType, entityId, pageType, pagePath, ctaDestination, metadata, surface: 'website',
    id: eventId, originEventId: pageEventId, variantId,
    occurredAt: boundedOccurrence(body.occurred_at, new Date().toISOString()),
  })
  return jsonResponse({ success: true, id: result.id, recorded: result.created }, { status: result.created ? 201 : 200 })
})
