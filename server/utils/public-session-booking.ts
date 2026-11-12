import type { CloudflareEnv } from '~/server/utils/auth'
import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { bookingWindow, listBookableSessions } from '~/server/utils/availability'
import { getProductBySlug, listOrganizationProducts, productBookingReadiness } from '~/server/utils/product-management'
import type { PublicProduct } from '~/server/types/products'
import { readPublicStayCalendar } from '~/server/domain/stays'
import { isCurrencyCode } from '~/shared/currencies'
import { AVAILABILITY_PAGE_DAYS } from '~/shared/bookings'
import { addLocalDays, isValidCalendarDate, isValidTimezone, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'

type AvailabilityInput = { location_id?: unknown; from?: unknown; to?: unknown; time_zone?: unknown }

function publicOffering(product: PublicProduct | null, organizationId: string): product is PublicProduct {
  return Boolean(product?.active && product.publications.some(publication => publication.organization_id === organizationId && publication.published))
}

export async function readPublicProductAvailability(db: DbClient, organizationId: string, slug: string, env: CloudflareEnv, input: AvailabilityInput) {
  const product = await getProductBySlug(db, organizationId, slug, 'kind-only')
  if (!product) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  if (product.kind === 'stay') return { unit: 'nights' as const, ...await readPublicStayCalendar(db, organizationId, slug, { from: input.from, to: input.to }) }
  if (!publicOffering(product, organizationId)) throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  if (!product.order_url && !(await productBookingReadiness(db, organizationId, product, { env })).ready) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  }
  return readPublicBookingSessions(db, organizationId, product, env, input)
}

export async function readPublicBookingSessions(db: DbClient, organizationId: string, product: PublicProduct, env: CloudflareEnv, input: AvailabilityInput) {
  if (!publicOffering(product, organizationId) || (!product.booking && !product.order_url)) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Product not found' })
  }
  const result = { unit: 'slot' as const, product: { id: product.id, name: product.name, slug: product.slug } }
  if (product.order_url) return { ...result, timezone: null, sessions: [] }
  const requested = input.location_id
  if (requested !== undefined && typeof requested !== 'string') throw new HTTPError({ statusCode: 422, statusMessage: 'Invalid location_id' })
  if ((input.from !== undefined || input.to !== undefined)
    && (!isValidCalendarDate(input.from) || !isValidCalendarDate(input.to) || input.to <= input.from || input.to > addLocalDays(input.from, AVAILABILITY_PAGE_DAYS))) {
    throw new HTTPError({ statusCode: 422, statusMessage: `Request up to ${AVAILABILITY_PAGE_DAYS} days with from and exclusive to dates` })
  }

  const locations = requested === 'online' ? [] : await queryAll<{ id: string | null; timezone: string }>(db, `
    SELECT l.id, l.timezone FROM product_locations pl
      JOIN business_locations l ON l.id = pl.location_id AND l.organization_id = ? AND l.status = 'active'
     WHERE pl.product_id = ? AND pl.active = 1 AND pl.published = 1
       AND (? IS NULL OR l.id = ?)
  `, [organizationId, product.id, requested ?? null, requested ?? null])
  if (product.booking?.held_online && (requested === undefined || requested === 'online')) {
    const provider = await queryFirst<{ id: null; timezone: string }>(db, `
      SELECT NULL AS id, ms.timezone FROM product_booking_configs c
        JOIN member_scheduling ms ON ms.member_id = c.assigned_member_id AND ms.organization_id = c.organization_id
       WHERE c.organization_id = ? AND c.product_id = ? AND ms.timezone IS NOT NULL
    `, [organizationId, product.id])
    if (provider) locations.push(provider)
  }
  if (requested !== undefined && !locations.length) throw new HTTPError({ statusCode: 404, statusMessage: 'This product is not on sale at that location' })

  if (input.time_zone !== undefined && (typeof input.time_zone !== 'string' || !isValidTimezone(input.time_zone))) throw new HTTPError({ statusCode: 422, statusMessage: 'Invalid time_zone' })
  const displayTimezone = input.time_zone as string | undefined
  const now = new Date()
  const sessions = (await Promise.all(locations.map(async ({ id, timezone }) => {
    const dateZone = displayTimezone ?? timezone
    const today = localDateAt(now, dateZone)
    const from = typeof input.from === 'string' ? input.from : today
    const to = typeof input.to === 'string' ? input.to : addLocalDays(from, AVAILABILITY_PAGE_DAYS)
    const window = bookingWindow(timezone, undefined, now.toISOString())
    const midnight = (date: string) => localDateTimeToInstant(date, '00:00', dateZone, 'compatible').toISOString()
    const fromInstant = from <= today ? window.fromInstant : midnight(from)
    const requestedEnd = midnight(to)
    const toInstant = requestedEnd < window.toInstant ? requestedEnd : window.toInstant
    if (fromInstant >= toInstant) return []
    return listBookableSessions(db, { env, organizationId, productId: product.id, locationId: id, fromInstant, toInstant, now: now.toISOString() })
  }))).flat()
  return {
    ...result,
    timezone: locations.length === 1 ? locations[0]!.timezone : null,
    sessions: sessions.map(({ id, starts_at, ends_at, location_id, timezone, remaining, is_full, created_at }) =>
      ({ id, starts_at, ends_at, location_id, timezone, remaining, is_full, created_at })),
  }
}

export async function listPublicOnlineProducts(db: DbClient, organizationId: string, previewAuthorized = false, env?: CloudflareEnv) {
  const organization = await queryFirst<{ default_currency: string }>(db, `SELECT default_currency FROM organization WHERE id = ? AND ${publicTenantVisibilitySql('organization', previewAuthorized)}`, [organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  if (!isCurrencyCode(organization.default_currency)) throw new HTTPError({ statusCode: 409, statusMessage: 'Configure the organization currency before offering consultations' })
  const products = (await listOrganizationProducts(db, { organizationId, publishedOnly: true, env })).filter(product => product.active && (product.booking?.held_online || product.order_url))
  return { products, locations: [], currency: organization.default_currency }
}
