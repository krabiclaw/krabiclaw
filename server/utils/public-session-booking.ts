import type { CloudflareEnv } from '~/server/utils/auth'
import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { bookableSessions, slotCalendars, slotReadQueries, type SlotCalendar, type SlotRead } from '~/server/utils/availability'
import { listOrganizationProducts } from '~/server/utils/product-management'
import type { PublicProduct } from '~/server/types/products'
import { readPublicStayCalendar } from '~/server/domain/stays'
import { isCurrencyCode } from '~/shared/currencies'
import { AVAILABILITY_PAGE_DAYS } from '~/shared/bookings'
import { addLocalDays, isValidCalendarDate, isValidTimezone, localDateAt } from '~/utils/timezone'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'

type AvailabilityInput = { location_id?: unknown; from?: unknown; to?: unknown; time_zone?: unknown }
type SlotProduct = { id: string; name: string; slug: string }

function publicOffering(product: PublicProduct | null, organizationId: string): product is PublicProduct {
  return Boolean(product?.active && product.publications.some(publication => publication.organization_id === organizationId && publication.published))
}

/** The request as the slot read needs it: which scope, which days, in whose clock. */
function availabilityRequest(input: AvailabilityInput, now: Date) {
  const requested = input.location_id
  if (requested !== undefined && typeof requested !== 'string') throw new HTTPError({ statusCode: 422, statusMessage: 'Invalid location_id' })
  if ((input.from !== undefined || input.to !== undefined)
    && (!isValidCalendarDate(input.from) || !isValidCalendarDate(input.to) || input.to <= input.from)) {
    throw new HTTPError({ statusCode: 422, statusMessage: 'Request calendar dates with from and an exclusive to after it' })
  }
  if (input.time_zone !== undefined && (typeof input.time_zone !== 'string' || !isValidTimezone(input.time_zone))) throw new HTTPError({ statusCode: 422, statusMessage: 'Invalid time_zone' })
  const from = typeof input.from === 'string' ? input.from : undefined
  const to = typeof input.to === 'string' ? input.to : undefined
  // Each session's day is read in the guest's clock, else its own; the read spans every clock's days.
  const first = from ?? localDateAt(now, 'UTC')
  const fromInstant = `${addLocalDays(first, -1)}T00:00:00.000Z`
  return {
    requested, from, to, timeZone: input.time_zone as string | undefined,
    locationId: requested === undefined ? undefined : requested === 'online' ? null : requested,
    fromInstant: fromInstant > now.toISOString() ? fromInstant : now.toISOString(),
    toInstant: `${addLocalDays(to ?? addLocalDays(first, AVAILABILITY_PAGE_DAYS + 1), 1)}T00:00:00.000Z`,
  }
}

type AvailabilityRequest = ReturnType<typeof availabilityRequest>

function slotRead(organizationId: string, products: BatchQuery, request: AvailabilityRequest, now: Date, scope: SlotRead['scope']): SlotRead {
  return { organization: { query: '?', params: [organizationId] }, products, locationId: request.locationId, fromInstant: request.fromInstant, toInstant: request.toInstant, scope, now: now.toISOString() }
}

/** The bookable times in the requested days, as a guest sees them. */
async function publicSessions(calendar: SlotCalendar, product: SlotProduct, request: AvailabilityRequest, now: Date) {
  const { schedule } = calendar
  const zones = [...schedule.locations.values()].map(location => location.timezone)
  if (schedule.config.held_online && schedule.provider && typeof request.locationId !== 'string') zones.push(schedule.provider.timezone)
  if (request.requested !== undefined && (request.requested === 'online' ? zones.length === 0 : !schedule.locations.has(request.requested))) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'This product is not on sale at that location' })
  }
  const sessions = bookableSessions(schedule, (await calendar.places()).sessions, now.toISOString()).filter((session) => {
    const zone = request.timeZone ?? session.timezone
    const from = request.from ?? localDateAt(now, zone)
    const day = localDateAt(new Date(session.starts_at), zone)
    return day >= from && day < (request.to ?? addLocalDays(from, AVAILABILITY_PAGE_DAYS))
  })
  return {
    unit: 'slot' as const, product,
    timezone: zones.length === 1 ? zones[0]! : null,
    sessions: sessions.map(({ id, starts_at, ends_at, location_id, timezone, remaining, is_full, created_at }) =>
      ({ id, starts_at, ends_at, location_id, timezone, remaining, is_full, created_at })),
  }
}

/**
 * A product's availability by its slug, read in one batch: the product, then
 * a home's nights or an offering's slots. A published, active offering shows
 * its times; publishing is where its readiness to sell was checked.
 */
export async function readPublicProductAvailability(db: DbClient, organizationId: string, slug: string, env: CloudflareEnv, input: AvailabilityInput) {
  const now = new Date()
  const request = availabilityRequest(input, now)
  const read = slotRead(organizationId, { query: "SELECT id FROM products WHERE organization_id=? AND slug=? AND kind<>'stay'", params: [organizationId, slug] }, request, now, 'bookable')
  const [productResult, ...slotResults] = await executeBatch(db, [{
    query: `SELECT p.id, p.kind, p.name, p.slug, p.active, p.order_url,
        EXISTS (SELECT 1 FROM product_publications pub WHERE pub.organization_id=p.organization_id AND pub.product_id=p.id AND pub.published=1) AS published
      FROM products p WHERE p.organization_id=? AND p.slug=?`,
    params: [organizationId, slug],
  }, ...slotReadQueries(read)], { operation: 'Read public availability' })
  const product = productResult?.results[0] as { id: string; kind: string; name: string; slug: string; active: number; order_url: string | null; published: number } | undefined
  if (!product) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  if (product.kind === 'stay') return { unit: 'nights' as const, ...await readPublicStayCalendar(db, organizationId, product.id, { from: input.from, to: input.to }) }
  if (!product.active || !product.published) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  const identity = { id: product.id, name: product.name, slug: product.slug }
  if (product.order_url) return { unit: 'slot' as const, product: identity, timezone: null, sessions: [] }
  const calendar = slotCalendars(env, read, slotResults).get(product.id)
  if (!calendar) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  return publicSessions(calendar, identity, request, now)
}

/**
 * The product page's first render: the same times the availability feed
 * returns. A preview of an experience not yet on sale reads what its saved
 * schedule would offer at a placement that is not published yet.
 */
export async function readPublicBookingSessions(db: DbClient, organizationId: string, product: PublicProduct, env: CloudflareEnv, input: AvailabilityInput, preview = false) {
  if ((!preview && !publicOffering(product, organizationId)) || (!product.booking && !product.order_url)) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  }
  const identity = { id: product.id, name: product.name, slug: product.slug }
  if (product.order_url) return { unit: 'slot' as const, product: identity, timezone: null, sessions: [] }
  const now = new Date()
  const request = availabilityRequest(input, now)
  const read = slotRead(organizationId, { query: 'SELECT ?', params: [product.id] }, request, now, preview ? 'editor' : 'bookable')
  const calendar = slotCalendars(env, read, await executeBatch(db, slotReadQueries(read), { operation: 'Read product sessions' })).get(product.id)
  if (!calendar) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  return publicSessions(calendar, identity, request, now)
}

export async function listPublicOnlineProducts(db: DbClient, organizationId: string, previewAuthorized = false, env?: CloudflareEnv) {
  const organization = await queryFirst<{ default_currency: string }>(db, `SELECT default_currency FROM organization WHERE id = ? AND ${publicTenantVisibilitySql('organization', previewAuthorized)}`, [organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  if (!isCurrencyCode(organization.default_currency)) throw new HTTPError({ statusCode: 409, statusMessage: 'Configure the organization currency before offering consultations' })
  const products = (await listOrganizationProducts(db, { organizationId, publishedOnly: true, env })).filter(product => product.active && (product.booking?.held_online || product.order_url))
  return { products, locations: [], currency: organization.default_currency }
}
