import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Product } from '../../server/types/products.ts'
import {
  catalogLabel,
  catalogNavigation,
  catalogSummary,
  catalogSurfaces,
  countCatalog,
  locationSurfacePath,
  parseSiteProductPath,
  presentationForSurface,
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
  // summarizeLocationProducts answers in this shape straight from SQL.
  assert.deepEqual(counts, { total: 3, experiences: 1, dishes: 2, stays: 0 })
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

const stay = { kind: 'stay' } as Pick<Product, 'kind'>

test('homes are their own surface, counted apart from products', () => {
  const counts = countCatalog([stay, stay, experience])
  assert.deepEqual(counts, { total: 3, experiences: 1, dishes: 0, stays: 2 })
  assert.deepEqual(catalogSurfaces('lodging', counts), ['stays', 'experiences'])
  assert.equal(catalogSummary('lodging', counts), '2 places to stay · 1 experience')
  assert.equal(catalogLabel('lodging', countCatalog([stay])), 'Places to stay')
})

test('a home is named by its own slug, separately from a business branch', () => {
  assert.deepEqual(parseSiteProductPath('/stays/ocean-studio'), { surface: 'stays', slug: 'ocean-studio' })
  assert.deepEqual(parseSiteProductPath('/experiences/pizza%20class'), { surface: 'experiences', slug: 'pizza class' })
  assert.equal(parseSiteProductPath('/locations/beach/products/ocean-studio'), null)
  assert.equal(parseSiteProductPath('/stays/%E0%A4%A'), null)
  assert.equal(publicLocationPath({ slug: 'beach' }), '/locations/beach')
  assert.equal(locationSurfacePath('beach', 'stays'), '/stays')
  assert.equal(locationSurfacePath('beach', 'menu'), '/locations/beach/menu')
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
