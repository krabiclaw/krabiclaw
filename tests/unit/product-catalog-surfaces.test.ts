import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Product } from '../../server/types/products.ts'
import {
  catalogLabel,
  catalogNavigation,
  catalogSummary,
  catalogSurfaces,
  collectionsOnSurface,
  countCatalog,
  isCatalogSurface,
  locationSurfacePath,
  parseSiteProductPath,
  presentationForSurface,
  productCtaKey,
  publicLocationPath,
} from '../../utils/product-presentation.ts'

// The invariant: a Product is on the Experiences surface because it takes
// bookings, and on the vertical's own surface otherwise. Nothing else assigns
// a surface — there is no discriminator to read — so a restaurant that sells
// dishes and bookable experiences manages two surfaces, and one that sells
// only dishes still manages a Menu of Sections.

const dish = { kind: 'dish' } as Pick<Product, 'kind'>
const experience = { kind: 'experience' } as Pick<Product, 'kind'>

test('a restaurant selling only food reaches the menu surface alone', () => {
  const counts = countCatalog([dish, dish])
  assert.deepEqual(catalogSurfaces('restaurant', counts), ['menu'])
  assert.equal(catalogLabel('restaurant', counts), 'Menu')
  assert.equal(catalogSummary('restaurant', counts), '2 dishes')
})

test('a restaurant that also takes bookings reaches both surfaces, menu first', () => {
  const counts = countCatalog([dish, dish, experience])
  assert.deepEqual(catalogSurfaces('restaurant', counts), ['menu', 'experiences'])
  // Neither word names the other, so the level that holds both is the catalog.
  assert.equal(catalogLabel('restaurant', counts), 'Catalog')
  assert.equal(catalogSummary('restaurant', counts), '2 dishes · 1 experience')
})

test('an empty catalog invites the vertical\'s own first item', () => {
  assert.deepEqual(catalogSurfaces('restaurant', countCatalog([])), ['menu'])
  assert.equal(catalogSummary('restaurant', countCatalog([])), 'Add your first dish')
  assert.equal(catalogSummary('experience', countCatalog([])), 'Add your first product')
})

test('a bookable catalog reads as experiences whatever the vertical sells otherwise', () => {
  const counts = countCatalog([experience])
  assert.deepEqual(catalogSurfaces('experience', counts), ['experiences'])
  assert.equal(catalogLabel('experience', counts), 'Experiences')
  assert.equal(catalogSummary('experience', counts), '1 experience')
})

test('the same two numbers come from rows or from a count the server did', () => {
  // summarizeLocationProducts answers in this shape straight from SQL, so a
  // surface is assigned identically however the caller learned the counts.
  assert.deepEqual(countCatalog([dish, dish, experience]), { total: 3, experiences: 1, dishes: 2, stays: 0 })
  assert.equal(catalogSummary('restaurant', { total: 3, experiences: 1, dishes: 2, stays: 0 }), '2 dishes · 1 experience')
})

test('only a vertical\'s own surface and experiences are pages', () => {
  assert.equal(isCatalogSurface('restaurant', 'menu'), true)
  assert.equal(isCatalogSurface('restaurant', 'experiences'), true)
  assert.equal(isCatalogSurface('restaurant', 'products'), true)
  assert.equal(isCatalogSurface('experience', 'products'), true)
  assert.equal(isCatalogSurface('restaurant', 'pc_loc-demo_standard_drinks'), false)
})

test('a mixed restaurant manages each surface\'s collections separately', () => {
  const rows = [
    { name: 'Wood-Fired Pizza', products: [dish, dish] },
    { name: 'Experiences', products: [experience] },
    { name: 'Drinks', products: [dish] },
  ]
  assert.deepEqual(collectionsOnSurface('restaurant', rows, 'menu').map(row => row.name), ['Wood-Fired Pizza', 'Drinks'])
  assert.deepEqual(collectionsOnSurface('restaurant', rows, 'experiences').map(row => row.name), ['Experiences'])
})

// A chef's counter is one collection the owner named once, holding dishes that
// belong on the menu and a bookable seating that belongs to experiences. The
// public pages already split it that way — /menu never shows the omakase and
// /experiences never shows the dishes — so the CMS opens the same collection on
// both surfaces with each surface's members and no others.
test('a collection holding both a dish and an experience is on both surfaces, split', () => {
  const rows = [{ name: "Chef's Counter", products: [dish, experience] }]

  const onMenu = collectionsOnSurface('restaurant', rows, 'menu')
  assert.deepEqual(onMenu.map(row => row.name), ["Chef's Counter"])
  assert.deepEqual(onMenu[0]!.products, [dish])

  const onExperiences = collectionsOnSurface('restaurant', rows, 'experiences')
  assert.deepEqual(onExperiences.map(row => row.name), ["Chef's Counter"])
  assert.deepEqual(onExperiences[0]!.products, [experience])
})

test('a collection with no member on a surface is not offered there', () => {
  const rows = [{ name: 'Drinks', products: [dish] }]
  assert.deepEqual(collectionsOnSurface('restaurant', rows, 'experiences'), [])
})

test('a collection with nothing in it is offered on every surface until it holds something', () => {
  const rows = [{ name: 'Not yet filled', products: [] as Pick<Product, 'kind'>[] }]
  assert.equal(collectionsOnSurface('restaurant', rows, 'menu').length, 1)
  assert.equal(collectionsOnSurface('restaurant', rows, 'experiences').length, 1)
  const filled = [{ name: 'Not yet filled', products: [dish] }]
  assert.equal(collectionsOnSurface('restaurant', filled, 'experiences').length, 0)
})

test('a pure menu keeps every section on the menu surface', () => {
  const rows = [
    { name: 'Antipasti', products: [dish] },
    { name: 'Drinks', products: [dish, dish] },
  ]
  assert.deepEqual(collectionsOnSurface('restaurant', rows, 'menu').map(row => row.name), ['Antipasti', 'Drinks'])
})

const stay = { kind: 'stay' } as Pick<Product, 'kind'>

test('homes are their own surface, counted apart from products', () => {
  const counts = countCatalog([stay, stay, experience])
  assert.deepEqual(counts, { total: 3, experiences: 1, dishes: 0, stays: 2 })
  assert.deepEqual(catalogSurfaces('lodging', counts), ['stays', 'experiences'])
  assert.equal(catalogSummary('lodging', counts), '2 places to stay · 1 experience')
  assert.equal(catalogLabel('lodging', countCatalog([stay])), 'Places to stay')
  assert.equal(isCatalogSurface('lodging', 'stays'), true)
})

test('a home is named by its own slug, and a location that is one home is that home', () => {
  assert.deepEqual(parseSiteProductPath('/stays/ocean-studio'), { surface: 'stays', slug: 'ocean-studio' })
  assert.deepEqual(parseSiteProductPath('/experiences/pizza%20class'), { surface: 'experiences', slug: 'pizza class' })
  assert.equal(parseSiteProductPath('/locations/beach/products/ocean-studio'), null)
  assert.equal(parseSiteProductPath('/stays/%E0%A4%A'), null)
  assert.equal(publicLocationPath({ slug: 'beach', home_slug: 'ocean-studio' }), '/stays/ocean-studio')
  assert.equal(publicLocationPath({ slug: 'beach', home_slug: null }), '/locations/beach')
  assert.equal(locationSurfacePath('beach', 'stays'), '/stays')
  assert.equal(locationSurfacePath('beach', 'menu'), '/locations/beach/menu')
})

test('a card names what it opens by the product kind', () => {
  assert.equal(productCtaKey('stay'), 'stay.check_availability')
  assert.equal(productCtaKey('dish'), 'site.common.view_dish')
  assert.equal(productCtaKey('experience'), 'site.common.view_experience')
})

test('catalog navigation links each section where the site\'s vertical lists it, and a site without a vertical is refused', () => {
  // A legal practice lists its practice areas at /services; it has no /products page.
  assert.equal(presentationForSurface('service', 'products').collectionPath, '/services')
  assert.equal(presentationForSurface('experience', 'products').collectionPath, '/products')
  assert.equal(presentationForSurface(null, 'stays').collectionPath, '/stays')
  assert.equal(presentationForSurface(null, 'experiences').collectionPath, '/experiences')
  assert.equal(presentationForSurface(null, 'menu').collectionPath, '/menu')
  // The products surface reads the site's vertical; its absence is a site that did not load.
  assert.throws(() => presentationForSurface(null, 'products'), /missing vertical/)

  const nav = catalogNavigation('restaurant', { products: true, menu: true, stays: true, experiences: true })
  assert.deepEqual(nav, [
    { surface: 'menu', path: '/menu', labelKey: 'site.footer.menu' },
    { surface: 'products', path: '/products', labelKey: 'site.footer.products' },
    { surface: 'stays', path: '/stays', labelKey: 'site.footer.stays' },
    { surface: 'experiences', path: '/experiences', labelKey: 'site.footer.experiences' },
  ])
})
