import type { Product } from '~/server/types/products'
import type { CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import type { ProductEditorContext } from '~/server/utils/dashboard-editor-resources'
import { prepareDashboardLocations } from '~/server/utils/dashboard-context'
import { prepareCollectionList } from '~/server/utils/product-management'
import { BATCH_VIEWER, isOrganizationWideRole, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import { PRODUCT_KIND_LABELS, productDetailFields } from '~/shared/product-details'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, selectPrice } from '~/shared/prices'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { agreementLabel } from '~/shared/agreements'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { HTTPError } from 'nitro'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import type { BatchQuery } from '~/server/db'

export function prepareDashboardOffering(organizationId: string | { sql: string }, productId: string) {
  const organization = typeof organizationId === 'string' ? '?' : organizationId.sql
  const params = typeof organizationId === 'string' ? [organizationId] : []
  const assignment = (action: 'read' | 'update') => ({ user: BATCH_VIEWER.user, unrestricted: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: [action] })) })
  const locationPlan = prepareDashboardLocations(organizationId, assignment('read'), true)
  const collectionPlan = prepareCollectionList({ organizationId, assignedUserId: assignment('update'),
    collectionIds: { query: `SELECT collection_id FROM collection_products WHERE organization_id = ${organization} AND product_id = ?`, params: [...params, productId] } })
  const readMembers = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ members: ['read'] }))
  const queries: BatchQuery[] = [...locationPlan.queries, ...collectionPlan.queries, {
    query: `SELECT ${MEMBER_NAME_SQL} AS name FROM member m JOIN user u ON u.id = m.userId
      LEFT JOIN member_scheduling ms ON ms.member_id = m.id AND ms.organization_id = m.organizationId
      WHERE m.organizationId = ${organization} AND m.id IN (SELECT assigned_member_id FROM product_booking_configs WHERE organization_id = m.organizationId AND product_id = ?) AND (${readMembers} OR m.userId = ${BATCH_VIEWER.user})`,
    params: [...params, productId],
  }]
  return { queries, async read(rows: D1Result[], product: Product, locationId: string | null, context: Pick<ProductEditorContext, 'env' | 'organization'>) {
    const { env, organization } = context
    const principal = memberAccessPrincipal(organization, { env })
    const manages = await roleAllows({ ...principal, permissions: { products: ['update'] } })
    const wide = isOrganizationWideRole(organization.role)
    const currency = organization.default_currency
    if (!isCurrencyCode(currency)) throw new Error('Unsupported organization currency')
    const missing = (message: string): never => { throw new HTTPError({ statusCode: 404, message }) }
    const { locations } = locationPlan.read(rows.slice(0, locationPlan.queries.length), context.organization.id)
    const collections = collectionPlan.read(rows.slice(locationPlan.queries.length, -1))
    const assigned = (rows.at(-1)!.results as { name: string }[])[0]?.name ?? null
    if (product.kind === 'stay') return { locations, collections, offering: null, assigned_member_name: assigned }
    const location = locationId ? locations.find(place => place.id === locationId && product.locations.some(binding => binding.location_id === place.id)) ?? missing('Offering not found at this location') : null
    const service = product.kind === 'service'
    const dish = product.kind === 'dish'
    const experience = product.kind === 'experience'
    const booking = product.booking
    const copy = getVerticalCopy(service ? 'service' : experience ? 'experience' : organization.vertical)
    const published = product.publications.some(row => row.organization_id === organization.id && row.published)
    const description = dish ? 'Description' : service ? 'Short description' : 'What you’ll do'
    const placeLabel = service ? 'Offices' : experience ? 'Venues' : 'Locations'
    const bookingLabel = service ? 'Consultations' : experience ? 'Bookings' : 'Scheduling'
    const priceLabel = location ? `Price at ${location.title}` : service ? 'Consultation pricing' : 'Price'
    const title = dish ? 'Dish editor' : service ? 'Legal Services editor' : experience ? 'Experience editor' : 'Table editor'
    const web = `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(productId)}`
    const webParams = new URLSearchParams()
    if (locationId) webParams.set('location_id', locationId)
    if (product.kind === 'dish') webParams.set('kind', 'dish')
    const webQuery = webParams.size ? `?${webParams}` : ''
    const params = { product_id: productId, ...(locationId ? { location_id: locationId } : {}) }
    const leaf = (id: string, label: string, summary?: string, options: { view?: string; web?: string; query?: Record<string, string>; readonly?: boolean } = {}): CatalogRow => ({
      id, label, summary, ...(options.readonly ? {} : {
        native: options.view ?? id, query: { ...params, ...options.query },
        to: `${web}/${options.web ?? id}${webQuery}`,
      }),
    })
    const detail = (key: string) => product.details[key as keyof typeof product.details]
    const text = (value: unknown) => Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : ''
    const selection = { currency, location_id: location?.id ?? null }
    const chosenPrice = (variant: typeof product.variants[number]) => selectPrice(variant.prices, selection)
    const locationsUsed = locations.filter(entry => product.locations.some(binding => binding.location_id === entry.id))
    const prices = product.variants.map(variant => {
      const price = chosenPrice(variant)
      const amount = price ? formatMinorAmount(price.unit_amount, currency) : text(detail('pricing_note')) || 'No price set'
      return product.variants.length === 1 ? amount : `${variant.name}: ${amount}`
    }).join('\n') || 'No price set'
    const photo = leaf('photo', 'Media', product.gallery.length || product.image ? 'View media' : 'Add media', { readonly: !wide })
    photo.image = mediaStillUrl(product.image)
    const definitions = productDetailFields(product.kind).filter(definition => !['pricing_note', 'tagline'].includes(definition.key))
    const offering: CatalogScreen = { title, fields: [], rows: [
      ...(wide && !service ? [photo] : []),
      leaf('name', 'Name', product.name),
      leaf('description', description, product.description || 'Nothing written yet'),
      ...(service ? [{ id: 'page', label: 'Page content', summary: product.page?.title ?? 'No page', ...(wide ? {
        to: product.page ? `/dashboard/${organization.slug}/website/pages/${product.page.id}` : `${web}/page`,
        ...(product.page ? { native: 'page', query: { page_id: product.page.id } } : { native: 'create-page', query: params }),
      } : {}) }] : []),
      { ...leaf('price', priceLabel, prices), optional_detail: service && !booking && prices === 'No price set' },
      ...(!dish && (!service || booking) ? [
        ...(booking ? [leaf('assignment', copy.assigneeLabel, assigned ?? 'Unassigned', { web: 'booking/assignment', readonly: !manages })] : []),
        leaf('booking', bookingLabel, booking ? `${booking.duration_minutes} minutes` : 'No booking calendar'),
        ...(booking ? [leaf('agreement', agreementLabel(product.kind), product.agreement?.file_name ?? 'None')] : []),
      ] : []),
      ...(service && !booking && manages ? [{ ...leaf('booking', 'Set up consultations', 'No booking calendar'), optional_detail: true }] : []),
      ...(service && !booking && !product.locations.length && wide ? [{ ...leaf('locations', placeLabel), optional_detail: true }] : []),
      ...definitions.map(definition => leaf(definition.key, definition.name, text(detail(definition.key)) || undefined, { view: 'attribute', web: `attributes/${definition.id}`, query: { field: definition.key } })),
      ...(wide && service ? [photo] : []),
      ...(wide ? [{ ...leaf('collections', dish ? 'Menu sections' : 'Collections', collections.filter(section => product.collections.some(row => row.collection_id === section.id)).map(section => section.name).join(', ')),
        optional_detail: !dish && !product.collections.length }] : []),
      ...(!service || booking || product.locations.length ? [leaf('locations', placeLabel, [...locationsUsed.map(entry => entry.title), ...(booking?.held_online ? ['Online'] : [])].join(', '))] : []),
      { ...leaf('publication', 'Website visibility', published ? 'Published' : 'Hidden'), status: published ? 'success' : 'neutral' },
      leaf('order-url', dish ? 'Ordering link' : service ? 'External consultation link' : 'External booking link', product.order_url ?? undefined),
      ...(manages ? [leaf('kind', 'Type', PRODUCT_KIND_LABELS[product.kind])] : []),
    ] }
    return { locations, collections, offering, assigned_member_name: assigned }
  } }
}
