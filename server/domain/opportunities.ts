import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { getOrganizationEntitlements } from '~/server/utils/billing-access'
import { BOOKING_RECORDS_SQL, bookedRecordWindow } from '~/server/domain/requests'
import { firstExperienceSetupPath, firstHomeSetupPath, firstPracticeAreaPath, guestConversationPath, productEditorPath, productPaymentPath } from '~/server/utils/dashboard-links'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { addLocalDays, formatCalendarRange, formatTimestamp, localDateAt } from '~/utils/timezone'
import { PRODUCT_DETAIL_FIELDS, type ProductKind } from '~/shared/product-details'
import { platformLocale } from '~/shared/platform-locales'
import { stayGuestFirstName } from '~/shared/bookings'
import { UPCOMING_RESERVATION_DAYS } from '~/shared/dashboard-today'

/*
  What Today suggests, read from what the business has already stored: setup it
  has not finished (payments, a domain, a first offering, Google Ads, a price,
  taking payment, a social account), and the welcome each booked guest who has
  not heard from the business since booking is due. Nothing here is recorded:
  each one goes away when the write that finishes it lands.
*/

/** A suggestion as the insight face of the `.tc` card draws it. */
export interface OpportunityView {
  id: string
  /** What part of the business: "Payments", "Catalog". */
  status_line: string
  title: string
  detail: string
  icon: string
  /** Where the owner does it in the dashboard. */
  path: string
  product_id: string | null
  location_id: string | null
  /** The guest conversation a welcome is sent in; null for every setup item. */
  conversation_id: string | null
  /** The welcome it pre-writes from the business's own records, for the owner to review and send. */
  message: string | null
}

/** The offering a business of each vertical starts its catalog with, and where it adds the first one. */
const FIRST_OFFERING = {
  lodging: { kind: 'stay', title: 'Add your first home', detail: 'Start your listing.', path: firstHomeSetupPath },
  experience: { kind: 'experience', title: 'Add your first experience', detail: 'Give guests something to book.', path: firstExperienceSetupPath },
  restaurant: { kind: 'dish', title: 'Add your first dish', detail: 'Start your menu.', path: (slug: string) => `${productEditorPath(slug, 'new')}?kind=dish` },
  service: { kind: 'service', title: 'Add your first practice area', detail: 'Start with the name clients will see.', path: firstPracticeAreaPath },
} as const

const SOCIAL_PROVIDERS = d1JsonStringSet(['instagram', 'facebook', 'discord'])

interface OrganizationFacts {
  slug: string; vertical: string; status: string; stripe_status: string | null; payments_ready: number | null
  google_ads: number; social: number; custom_domain: number; has_offering: number
}
/** An experience or consultation, with its highest current one-time price: null has none, 0 is free. */
interface BookedOffering { id: string; name: string; online_payment_required: number | null; top_price: number | null }

/**
 * Today's suggestions for the business: its unfinished setup in a fixed order,
 * then each booked guest's welcome. Read in one D1 batch beside the plan.
 */
export async function listOpportunities(db: DbClient, principal: MemberAccessPrincipal, input: { now?: Date; locationId?: string } = {}): Promise<{ opportunities: OpportunityView[] }> {
  // Suggestions are the owner's decisions about the business; a member is given the tasks they lead to.
  await assertRoleAllows({ ...principal, permissions: { task: ['assign'] } })
  const now = input.now ?? new Date(), at = now.toISOString(), organizationId = principal.organizationId, locationId = input.locationId
  const firstKinds = JSON.stringify(Object.fromEntries(Object.entries(FIRST_OFFERING).map(([vertical, offering]) => [vertical, offering.kind])))
  const [[facts, booked, welcomeRows], entitlements] = await Promise.all([
    executeBatch(db, [
      { query: `SELECT o.slug, o.vertical, o.status, s.status AS stripe_status, s.status = 'ready' AND s.card_payments_status = 'active' AS payments_ready,
          EXISTS (SELECT 1 FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'google_ads' AND i.status IS NOT 'setting_up') AS google_ads,
          EXISTS (SELECT 1 FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider IN (SELECT value FROM json_each(?)) AND i.status IS NOT 'setting_up') AS social,
          EXISTS (SELECT 1 FROM organization_domains d WHERE d.organization_id = o.id AND d.type = 'custom' AND d.status <> 'deleted') AS custom_domain,
          EXISTS (SELECT 1 FROM products p WHERE p.organization_id = o.id AND p.active = 1 AND p.kind = json_extract(?, '$.' || o.vertical)) AS has_offering
        FROM organization o LEFT JOIN stripe_connected_accounts s ON s.organization_id = o.id WHERE o.id = ?`, params: [SOCIAL_PROVIDERS, firstKinds, organizationId] },
      { query: `SELECT p.id, p.name, c.online_payment_required,
          (SELECT MAX(pr.unit_amount) FROM product_variants v JOIN prices pr ON pr.organization_id = v.organization_id AND pr.product_variant_id = v.id
            WHERE v.organization_id = p.organization_id AND v.product_id = p.id AND v.active = 1 AND pr.active = 1 AND pr.type = 'one_time'
              AND (pr.valid_from_at IS NULL OR pr.valid_from_at <= ?) AND (pr.valid_until_at IS NULL OR pr.valid_until_at > ?)
              ${locationId ? 'AND (pr.location_id IS NULL OR pr.location_id = ?)' : ''}) AS top_price
        FROM products p JOIN organization o ON o.id = p.organization_id AND o.vertical = p.kind
        LEFT JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
        WHERE p.organization_id = ? AND p.active = 1 AND p.kind IN ('experience', 'service')
          ${locationId ? 'AND EXISTS (SELECT 1 FROM product_locations l WHERE l.organization_id = p.organization_id AND l.product_id = p.id AND l.location_id = ?)' : ''}
        ORDER BY p.created_at, p.id`, params: [at, at, ...(locationId ? [locationId] : []), organizationId, ...(locationId ? [locationId] : [])] },
      bookingWelcomesQuery(organizationId, { now, locationId }),
    ]),
    getOrganizationEntitlements(principal.env, organizationId, now),
  ])
  const organization = facts!.results[0] as OrganizationFacts | undefined
  if (!organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  const slug = organization.slug, base = `/dashboard/${encodeURIComponent(slug)}`
  const offerings = booked!.results as BookedOffering[]
  const items: OpportunityView[] = []
  const offer = (operation: string, subjectId: string, statusLine: string, title: string, detail: string, path: string, icon: string, productId: string | null = null) =>
    items.push({ id: `${operation}:${subjectId}`, status_line: statusLine, title, detail, icon, path, product_id: productId, location_id: locationId ?? null, conversation_id: null, message: null })

  // Stripe is reviewing an account that is waiting on it; there is nothing for the owner to do yet.
  if (!organization.payments_ready && organization.stripe_status !== 'pending_review') {
    offer('payments.connect', organizationId, 'Payments', organization.stripe_status ? 'Finish setting up payments' : 'Set up payments', 'Connect with Stripe.', `${base}/payments/payout-method`, 'i-lucide-credit-card')
  }
  if (organization.status === 'inactive' && !organization.custom_domain) {
    offer('domain.connect', organizationId, 'Website', 'Connect a custom domain', 'Use your own website address.', `${base}/website/preferences/domains`, 'i-lucide-globe')
  }
  const first = FIRST_OFFERING[organization.vertical as keyof typeof FIRST_OFFERING]
  if (first && !organization.has_offering) offer('product.create', organizationId, 'Catalog', first.title, first.detail, first.path(slug), 'i-lucide-list-checks')
  if (!organization.google_ads) {
    offer('google_ads.connect', organizationId, 'Marketing', 'Connect Google Ads', 'Connect the existing Google Ads integration to measure which articles your ads bring customers to.', `${base}/integrations`, 'i-logos-google-ads')
  }
  // An experience without a price cannot be booked; a consultation may be free.
  if (organization.vertical === 'experience') for (const product of offerings.filter(product => product.top_price === null)) {
    offer('product.readiness', product.id, 'Catalog', `Set a booking price for “${product.name}”`, 'This offering needs a price before guests can book it on your site.', `${productEditorPath(slug, product.id)}/price`, 'i-lucide-list-checks', product.id)
  }
  if (organization.payments_ready) for (const product of offerings.filter(product => product.online_payment_required === 0 && (product.top_price ?? 0) > 0)) {
    const service = organization.vertical === 'service'
    offer('product.payment', product.id, 'Payments', `Take payment when ${service ? 'clients' : 'guests'} book “${product.name}”`,
      `Payments are ready, but this offering does not require advance payment. Enable it for a priced offering to collect before ${service ? 'confirming a consultation' : 'reserving places'}.`,
      productPaymentPath(slug, product.id), 'i-lucide-credit-card', product.id)
  }
  if (entitlements.managed_service !== true) {
    offer('social.connect', organizationId, 'Social', 'Enable social publishing', 'Connected social publishing needs a plan that includes it. You can prepare content now.', `${base}/billing`, 'i-lucide-link')
  } else if (!organization.social) {
    offer('social.connect', organizationId, 'Social', 'Connect your social account', 'Connect the account where customers follow you, so posts can be published and their outcomes tracked here.', `${base}/integrations`, 'i-lucide-link')
  }

  for (const welcome of bookingWelcomes(welcomeRows!.results as WelcomeRow[], now)) {
    items.push({
      id: `booking.welcome:${welcome.requestId}`, status_line: 'Messages',
      title: welcome.kind === 'stay' ? 'Share info about your place' : 'Share how to prepare',
      detail: `Help ${welcome.guestFirstName ?? `your ${welcome.kind === 'stay' ? 'guest' : resolveBookingPresentation(welcome.productKind, organization.vertical).counterpartyNoun}`} get ready`,
      icon: 'i-lucide-messages-square', path: guestConversationPath(slug, welcome.requestId),
      product_id: welcome.productId, location_id: welcome.locationId, conversation_id: welcome.requestId, message: welcome.message,
    })
  }
  return { opportunities: items }
}

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

export interface WelcomeRow {
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
 * The confirmed booked visits around now a welcome may apply to, or the one
 * conversation named: any record whose offering has host-authored preparation.
 * `bookingWelcomes` keeps the ones still upcoming.
 */
export function bookingWelcomesQuery(organizationId: string, input: { now: Date; requestId?: string; locationId?: string }): BatchQuery {
  const until = new Date(input.now.getTime() + UPCOMING_RESERVATION_DAYS * 86_400_000).toISOString()
  const only = (column: string, value: string | undefined) => value === undefined ? '' : `AND ${column} = ?`
  return {
    query: `
    SELECT br.unit, br.product_kind, br.id AS record_id, r.id AS request_id, br.status, br.starts_at, br.ends_at, br.timezone,
      br.product_id, br.product_name, br.location_id, json_extract(r.payload_json, '$.guest.name') AS guest_name,
      p.details_json, c.directions, c.wifi_network, c.wifi_password, c.house_manual
    FROM ${BOOKING_RECORDS_SQL} br
    JOIN conversations r ON r.booking_id = br.id AND r.kind = 'booking' AND r.organization_id = br.organization_id
    JOIN products p ON p.id = br.product_id AND p.organization_id = br.organization_id
    LEFT JOIN product_stay_configs c ON br.unit = 'nights' AND c.organization_id = br.organization_id AND c.product_id = br.product_id
    WHERE br.organization_id = ? AND br.status = 'confirmed' AND br.starts_at BETWEEN ? AND ?
      AND (json_extract(p.details_json, '$.preparation') IS NOT NULL OR json_array_length(p.details_json, '$.what_to_bring') > 0
        OR COALESCE(c.directions, c.wifi_network, c.wifi_password, c.house_manual) IS NOT NULL)
      AND r.blocked_at IS NULL
      -- The client has had no business message in this conversation since they booked.
      AND NOT EXISTS (SELECT 1 FROM messages e WHERE e.conversation_id = r.id AND e.author_kind = 'member' AND e.occurred_at >= br.created_at)
      ${only('r.id', input.requestId)} ${only('br.location_id', input.locationId)}
    ORDER BY br.starts_at, br.id`,
    params: [organizationId, new Date(input.now.getTime() - 2 * 86_400_000).toISOString(), until, ...[input.requestId, input.locationId].filter((value): value is string => value !== undefined)],
  }
}

/** The welcomes due now among `bookingWelcomesQuery`'s rows. */
export function bookingWelcomes(rows: WelcomeRow[], now: Date): BookingWelcome[] {
  const instant = now.toISOString()
  return rows.flatMap((row) => {
    // A stay is upcoming in its home's own calendar until its guests arrive; anything else until it starts.
    const arrival = bookedRecordWindow({ id: row.record_id, ...row }).start
    if (row.unit === 'nights') {
      const today = localDateAt(now, row.timezone)
      if (arrival.date < today || arrival.date > addLocalDays(today, UPCOMING_RESERVATION_DAYS)) return []
      if (arrival.instant !== null && arrival.instant <= instant) return []
    } else if (row.starts_at <= instant) return []
    const message = welcomeMessage(row)
    if (message === null) return []
    return [{ requestId: row.request_id, kind: row.unit === 'nights' ? 'stay' as const : 'booking' as const, productKind: row.product_kind, recordId: row.record_id, status: row.status, startsAt: row.unit === 'nights' ? arrival.date : row.starts_at, timezone: row.timezone,
      productId: row.product_id, locationId: row.location_id, guestFirstName: stayGuestFirstName(row.guest_name), message }]
  })
}
