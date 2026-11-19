import type { Product } from '~/server/types/products'
import type { CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import type { requireProductAccess } from '~/server/utils/location-access'
import { prepareDashboardLocations } from '~/server/utils/dashboard-context'
import { prepareCollectionList } from '~/server/utils/product-management'
import { isOrganizationWideRole, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
import { PRODUCT_KIND_LABELS, productDetailFields } from '~/shared/product-details'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, selectPrice } from '~/shared/prices'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { HTTPError } from 'nitro'
import { executeBatch } from '~/server/db'

export async function presentDashboardOffering(
  context: Pick<Awaited<ReturnType<typeof requireProductAccess>>, 'env' | 'db' | 'organization'>,
  product: Product, locationId: string | null,
): Promise<CatalogScreen> {
  const { db, env, organization } = context
  const userId = organization.user_id
  const principal = memberAccessPrincipal(organization.membership, { env })
  const productId = product.id
  const missing = (message: string): never => { throw new HTTPError({ statusCode: 404, message }) }
  const manages = await roleAllows({ ...principal, permissions: { products: ['update'] } })
  const wide = isOrganizationWideRole(organization.member_role)
  const currency = organization.default_currency
  if (!isCurrencyCode(currency)) throw new Error('Unsupported organization currency')
  const locationPlan = prepareDashboardLocations(organization.id, manages ? undefined : userId, true)
  const collectionPlan = prepareCollectionList({ organizationId: organization.id,
    assignedUserId: manages ? undefined : userId, collectionIds: product.collections.map(row => row.collection_id) })
  const rows = await executeBatch(db, [...locationPlan.queries, ...collectionPlan.queries], { operation: 'Read offering navigation' })
  const { locations } = locationPlan.read(rows.slice(0, locationPlan.queries.length))
  const collections = collectionPlan.read(rows.slice(locationPlan.queries.length))
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
  const memberList = () => memberSchedulingList({ env, userId, organizationId: organization.id })
  const locationsUsed = locations.filter(entry => product.locations.some(binding => binding.location_id === entry.id))
  const prices = product.variants.map(variant => {
    const price = chosenPrice(variant)
    const amount = price ? formatMinorAmount(price.unit_amount, currency) : text(detail('pricing_note')) || 'No price set'
    return product.variants.length === 1 ? amount : `${variant.name}: ${amount}`
  }).join('\n') || 'No price set'
  const photo = leaf('photo', 'Media', product.gallery.length || product.image ? 'View media' : 'Add media', { readonly: !wide })
  photo.image = mediaStillUrl(product.image)
  const definitions = productDetailFields(product.kind).filter(definition => !['pricing_note', 'tagline'].includes(definition.key))
  const assigned = booking?.assigned_member_id ? (await memberList()).members.find(member => member.id === booking.assigned_member_id)?.name : null
  return { title, fields: [], rows: [
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
}
