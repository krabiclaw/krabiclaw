import { HTTPError, type H3Event } from 'nitro'
import { getQuery } from 'nitro/h3'
import { getDashboardMemberContext, listDashboardLocations } from '~/server/utils/dashboard-context'
import { roleAllows, assertRoleAllows, isOrganizationWideRole } from '~/server/utils/member-access'
import { hydrateProductMedia, listCollections, listOrganizationProducts } from '~/server/utils/product-management'
import { groupProductsByCollection } from '~/utils/product-presentation'
import { formatProductPriceRange, summarizeProductPrices } from '~/utils/product-money'
import { isCurrencyCode } from '~/shared/currencies'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import type { CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import type { Product } from '~/server/types/products'

const kinds = [
  { value: 'menu', label: 'Menu' }, { value: 'experience', label: 'Experiences' },
  { value: 'service', label: 'Services' }, { value: 'stay', label: 'Places to stay' },
  { value: 'table', label: 'Tables' },
]

export async function loadDashboardCatalog(event: H3Event) {
  const { db, organization } = await getDashboardMemberContext(event)
  const manages = await roleAllows({ ...organization, permissions: { products: ['read'] } })
  if (!manages) await assertRoleAllows({ ...organization, permissions: { products: ['assigned'] } })
  const can_create = await roleAllows({ ...organization, permissions: { products: ['create'] } })
  const scope = { organizationId: organization.id, assignedUserId: manages ? undefined : organization.userId }
  const [products, collections, locations] = await Promise.all([
    listOrganizationProducts(db, scope).then(rows => hydrateProductMedia(db, organization.id, rows)),
    listCollections(db, scope),
    listDashboardLocations(db, organization.id, scope.assignedUserId, true),
  ])
  const query = getQuery(event)
  const kind = kinds.find(item => item.value === query.kind)?.value ?? 'all'
  const location = locations.find(item => item.id === query.location_id)
  const groups = groupProductsByCollection(products, collections)
  const menu = collections.filter(section => {
    const items = groups.find(group => group.id === section.id)?.products ?? []
    return !items.length || items.some(product => product.kind === 'dish')
  })
  const offers = (value: string) => value === 'menu'
    ? menu.length > 0 || products.some(product => product.kind === 'dish')
    : products.some(product => product.kind === value)
  const filters = [{ value: 'all', label: 'All' }, ...kinds.filter(item => item.value === kind || offers(item.value))]
  const base = `/dashboard/${encodeURIComponent(organization.slug)}/products`
  const currency = organization.default_currency
  if (!isCurrencyCode(currency)) throw new Error('Unsupported organization currency')
  const item = (product: Product, locationId?: string): CatalogRow => {
    const bindings = product.locations.map(binding => {
      const place = locations.find(row => row.id === binding.location_id)
      if (!place) throw new Error('The offering location could not be loaded')
      return place.title
    })
    const scopes = locationId ? [locationId] : [null, ...locations.map(place => place.id)]
    const price = formatProductPriceRange(summarizeProductPrices(product.variants, scopes.map(location_id => ({ currency, location_id }))))
    return {
      id: product.id, label: product.stay?.internal_name ?? product.name,
      summary: [price, product.booking?.held_online ? 'Online' : null, ...bindings].filter(Boolean).join(' · '),
      image: mediaStillUrl(product.image),
      to: `${base}/${product.id}${locationId ? `?location_id=${encodeURIComponent(locationId)}&kind=dish` : ''}`,
      native: product.kind === 'stay' ? 'stay' : 'offering',
      query: { product_id: product.id, ...(locationId ? { location_id: locationId } : {}) },
    }
  }
  const screen: CatalogScreen = { title: 'Catalog', fields: [], rows: [], empty_title: 'No offerings' }
  const wide = isOrganizationWideRole(organization.role)
  if (query.view === 'menu' || query.view === 'section') {
    if (query.location_id && !location) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
    const locationId = location?.id
    const sections = menu.filter(section => !locationId || section.location_id === null || section.location_id === locationId)
    const dishes = products.filter(product => product.kind === 'dish' && (!locationId || product.locations.some(binding => binding.location_id === locationId)))
    screen.title = location ? `${location.title} menu` : 'Menu'
    screen.empty_title = 'No dishes'
    if (query.view === 'section') {
      const section = sections.find(entry => entry.id === query.section_id)
      if (!section) throw new HTTPError({ statusCode: 404, message: 'Section not found' })
      screen.title = section.name
      const visible = new Set(dishes.map(dish => dish.id))
      screen.rows = (groups.find(group => group.id === section.id)?.products ?? [])
        .filter(dish => visible.has(dish.id)).map(dish => item(dish, locationId))
      if (wide && section.location_id === (locationId ?? null)) {
        const edit = (native: string, label: string, summary?: string): CatalogRow => ({
          id: native, native, label, summary, query: { section_id: section.id },
        })
        screen.rows.unshift(
          edit('section-name', 'Name', section.name),
          edit('section-description', 'Description', section.description ?? undefined),
          { ...edit('section-photo', 'Photo'), image: mediaStillUrl(section.image) },
          edit('section-membership', 'Choose dishes'),
          edit('section-move', 'Move a dish'),
          edit('create-offering', 'Create a dish'),
          edit('section-items', 'Order items'),
          edit('delete-section', 'Delete section'),
        )
      }
    } else {
      screen.rows = [
        ...(wide && can_create ? [{ id: 'add-section', native: 'add-section', label: 'Add section', query: locationId ? { location_id: locationId } : {} }] : []),
        ...(wide && sections.filter(section => section.location_id === (locationId ?? null)).length > 1
          ? [{ id: 'menu-order', native: 'menu-order', label: 'Reorder sections', query: locationId ? { location_id: locationId } : {} }] : []),
        ...sections.map(section => ({
          id: section.id, label: section.name, image: mediaStillUrl(section.image), native: 'section',
          query: { section_id: section.id, ...(locationId ? { location_id: locationId } : {}) },
        })),
        ...dishes.filter(dish => !dish.collections.some(membership => sections.some(section => section.id === membership.collection_id))).map(dish => item(dish, locationId)),
      ]
    }
  } else {
    if (wide && can_create && query.native === '1') screen.rows.push({
      id: 'create-offering', label: 'Add offering', native: 'create-offering', query: {},
    })
    if ((kind === 'all' || kind === 'menu') && offers('menu')) {
      const menuLocations = locations.length
        ? [...locations, ...(menu.some(section => section.location_id === null) ? [null] : [])]
        : [null]
      screen.rows.push(...menuLocations.map((place): CatalogRow => ({
        id: place ? `menu-${place.id}` : 'menu', label: place?.title ?? (locations.length ? 'Shared menu' : 'Menu'),
        summary: 'Menu', image: place?.picture_url ?? null,
        to: `${base}/menu${place ? `?location_id=${encodeURIComponent(place.id)}` : ''}`,
        native: 'menu', query: place ? { location_id: place.id } : {},
      })))
    }
    screen.rows.push(...products.filter(product => product.kind !== 'dish' && (kind === 'all' || kind === product.kind)).map(product => item(product)))
  }
  return { screen, filters, kind, can_create, has_stays: offers('stay') }
}
