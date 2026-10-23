import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Product } from '../../server/types/products.ts'
import {
  COLLECTION_SIBLING_LIMIT,
  composeProductSeoDescription,
  extractDietarySchemaUrls,
  isOfferedProduct,
  selectProductCollectionSiblings,
} from '../../utils/product-seo.ts'
import en from '../../i18n/locales/en.ts'

// The real English messages, interpolated the way vue-i18n interpolates them,
// so the composed length and wording are measured against what ships.
const messages = en.site.product_detail as Record<string, string>
const translate = (key: string, named: Record<string, string>) => {
  const message = messages[key.replace('site.product_detail.', '')]
  if (!message) throw new Error(`Missing test message: ${key}`)
  return message.replace(/\{(\w+)\}/g, (_match, name: string) => named[name] ?? '')
}

// Intl renders currency with a non-breaking space; collapse it so the
// assertions read the way the tag does.
const readable = (text: string) => text.replaceAll(' ', ' ')

const SELECTION = { currency: 'THB' as const, location_id: 'loc-1', at: '2099-01-01T00:00:00.000Z' }

function price(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price-1',
    organization_id: 'org-1',
    product_variant_id: 'var-1',
    location_id: null,
    active: true,
    currency: 'THB',
    unit_amount: 32000,
    type: 'one_time',
    recurring_interval: null,
    recurring_interval_count: null,
    tax_behavior: 'unspecified',
    compare_at_unit_amount: null,
    valid_from_at: null,
    valid_until_at: null,
    source: 'manual',
    ...overrides,
  }
}

/** A Product carrying exactly what the SEO composer and sibling picker read. */
function product(overrides: Partial<Product> & { id: string; name: string }): Product {
  const { collectionId = 'col-1', priced = true, ...rest } = overrides as Partial<Product> & {
    id: string; name: string; collectionId?: string; priced?: boolean
  }
  return {
    slug: rest.name.toLowerCase().replaceAll(' ', '-'),
    description: '',
    active: true,
    variants: [{ id: `var-${rest.id}`, name: 'Default', prices: priced ? [price({ product_variant_id: `var-${rest.id}` })] : [] }],
    collections: [{ collection_id: collectionId, sort_order: 0 }],
    locations: [{ location_id: 'loc-1', active: true, published: true }],
    ...rest,
  } as unknown as Product
}

test('a dish with no description of its own is described by its price and location', () => {
  const description = composeProductSeoDescription({
    product: product({ id: 'p-1', name: 'Sprite' }),
    locationTitle: 'Kikuzuki Ao Nang',
    priceSelection: SELECTION,
  }, translate)
  assert.equal(readable(description), 'Sprite. THB 320.00 at Kikuzuki Ao Nang.')
})

test('two dishes at the same location get different descriptions', () => {
  const shared = { locationTitle: 'Kikuzuki Ao Nang', priceSelection: SELECTION }
  const sprite = composeProductSeoDescription({ ...shared, product: product({ id: 'p-1', name: 'Sprite' }) }, translate)
  const akagai = composeProductSeoDescription({
    ...shared,
    product: product({ id: 'p-2', name: 'Akagai Sashimi', description: 'Ark shell clam.' }),
  }, translate)
  assert.notEqual(sprite, akagai)
  assert.match(akagai, /Ark shell clam/)
})

test('the price and location survive a description far longer than the tag', () => {
  const description = composeProductSeoDescription({
    product: product({ id: 'p-3', name: 'Omakase', description: 'Chef selection '.repeat(40) }),
    locationTitle: 'Kikuzuki Ao Nang',
    priceSelection: SELECTION,
  }, translate)
  assert.ok(description.length <= 160, `composed ${description.length} characters`)
  assert.match(readable(description), /at Kikuzuki Ao Nang\.$/)
  // Truncated on a word boundary, never mid-word.
  assert.match(readable(description), / Chef…\. THB 320\.00 at /)
})

test('a Product with no applicable price is not offered and is described without one', () => {
  const unpriced = product({ id: 'p-4', name: 'Market Fish', priced: false })
  assert.equal(isOfferedProduct(unpriced, SELECTION), false)
  assert.equal(
    readable(composeProductSeoDescription({ product: unpriced, locationTitle: 'Kikuzuki Ao Nang', priceSelection: SELECTION }, translate)),
    'Market Fish. Available at Kikuzuki Ao Nang.',
  )
})

test('collection siblings exclude the page itself, other collections and unpriced rows', () => {
  const catalogue = [
    product({ id: 'p-1', name: 'Akagai' }),
    product({ id: 'p-2', name: 'Maguro' }),
    product({ id: 'p-3', name: 'Placeholder', priced: false }),
    product({ id: 'p-4', name: 'Sprite', collectionId: 'col-2' }),
  ]
  assert.deepEqual(
    selectProductCollectionSiblings(catalogue, catalogue[0]!, 'col-1', SELECTION).map(sibling => sibling.name),
    ['Maguro'],
  )
})

test('the sibling window rotates and stays bounded so a large collection is fully linked', () => {
  const catalogue = Array.from({ length: 20 }, (_item, index) => product({ id: `p-${index}`, name: `Dish ${index}` }))
  const first = selectProductCollectionSiblings(catalogue, catalogue[0]!, 'col-1', SELECTION).map(sibling => sibling.name)
  const middle = selectProductCollectionSiblings(catalogue, catalogue[10]!, 'col-1', SELECTION).map(sibling => sibling.name)
  assert.equal(first.length, COLLECTION_SIBLING_LIMIT)
  assert.equal(middle.length, COLLECTION_SIBLING_LIMIT)
  assert.deepEqual(first, ['Dish 1', 'Dish 2', 'Dish 3', 'Dish 4', 'Dish 5', 'Dish 6', 'Dish 7', 'Dish 8'])
  assert.deepEqual(middle, ['Dish 11', 'Dish 12', 'Dish 13', 'Dish 14', 'Dish 15', 'Dish 16', 'Dish 17', 'Dish 18'])
  // The last item wraps to the front rather than returning a short list.
  assert.deepEqual(
    selectProductCollectionSiblings(catalogue, catalogue[19]!, 'col-1', SELECTION).map(sibling => sibling.name),
    ['Dish 0', 'Dish 1', 'Dish 2', 'Dish 3', 'Dish 4', 'Dish 5', 'Dish 6', 'Dish 7'],
  )
})

test('extractDietarySchemaUrls maps product dietary notes to standard Schema.org diet enumeration URLs', () => {
  const baseProduct = {
    id: 'prod-1',
    name: 'Pad Thai',
    slug: 'pad-thai',
    description: 'Delicious noodles',
    kind: 'dish' as const,
    variants: [],
    collections: [],
    details: {},
  }

  assert.deepEqual(
    extractDietarySchemaUrls({ ...baseProduct, details: { dietary_notes: ['V'] } }),
    ['https://schema.org/VegetarianDiet'],
  )
  assert.deepEqual(
    extractDietarySchemaUrls({ ...baseProduct, details: { dietary_notes: ['VG'] } }),
    ['https://schema.org/VeganDiet'],
  )
  assert.deepEqual(
    extractDietarySchemaUrls({ ...baseProduct, details: { dietary_notes: ['GF'] } }),
    ['https://schema.org/GlutenFreeDiet'],
  )
  assert.deepEqual(
    extractDietarySchemaUrls({ ...baseProduct, details: { dietary_notes: ['V', 'GF', 'UNKNOWN'] } }),
    ['https://schema.org/VegetarianDiet', 'https://schema.org/GlutenFreeDiet'],
  )
  assert.deepEqual(
    extractDietarySchemaUrls({ ...baseProduct, details: {} }),
    [],
  )
})

