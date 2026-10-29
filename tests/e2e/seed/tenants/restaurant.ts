import type { CreateTenant } from '../seed.ts'
import { SEED_SUBDOMAINS, type SeedTenant } from '../manifest.ts'
import { everyDay, recordProduct, seedLocation, seedMedia, toolFor } from './common.ts'

// Ember & Slice is KrabiClaw's fictional pizzeria: two New York locations with
// table reservations, a menu and a kitchen blog.
export async function seedRestaurant(createTenant: CreateTenant): Promise<SeedTenant> {
  const { owner, tenant } = await createTenant({
    key: 'restaurant', name: 'Ember & Slice', slug: 'ember-slice-demo', subdomain: SEED_SUBDOMAINS.restaurant,
    vertical: 'restaurant', currency: 'USD', timezone: 'America/New_York', subscription: 'business',
  })
  try {
    const tool = toolFor(owner, tenant)
    const address = (street: string) => ({ regionCode: 'US', addressLines: [street], locality: 'Brooklyn', administrativeArea: 'NY', postalCode: '11201' })
    const brooklyn = await seedLocation(tool, tenant, 'brooklyn', { title: 'Ember & Slice Brooklyn', email: 'brooklyn@ember-slice.example', phone: '+12025550123', hours: everyDay(11, 22), address: address('120 Atlantic Avenue') })
    const williamsburg = await seedLocation(tool, tenant, 'williamsburg', { title: 'Ember & Slice Williamsburg', email: 'williamsburg@ember-slice.example', phone: '+12025550124', hours: everyDay(11, 22), address: address('88 Bedford Avenue') })

    // Table reservations: 90-minute seatings, flexible (two-hour) cancellation.
    for (const place of [brooklyn, williamsburg]) {
      await tool('update_reservation_policy', { location_id: place.id, expected_updated_at: null, duration_minutes: 90, slot_capacity: 40, cancellation_policy: 'flexible' })
    }

    const margherita = await seedMedia(owner, tenant, 'margherita', 'dish.avif', 'Margherita pizza with basil')
    const burrata = await seedMedia(owner, tenant, 'burrata', 'venue.avif', 'Burrata with tomatoes')
    const diningRoom = await seedMedia(owner, tenant, 'dining-room', 'room.avif', 'The Brooklyn dining room')
    for (const asset of [burrata, diningRoom]) {
      await tool('attach_media', { placement: { owner_type: 'business_location', owner_id: williamsburg.id, slot: 'gallery' }, asset_id: asset.id })
    }

    const dish = async (key: string, name: string, cents: number, image?: { id: string }) => {
      const { product } = await tool<{ product: { id: string; slug: string; name: string; kind: string } }>('create_product', {
        kind: 'dish', name, active: true, idempotency_key: `seed-${key}`,
        variants: [{ name, prices: [{ unit_amount: cents, currency: 'USD' }] }],
      })
      if (image) {
        await tool('set_media', { placement: { owner_type: 'product', owner_id: product.id, slot: 'image' }, asset_id: image.id })
        await tool('attach_media', { placement: { owner_type: 'product', owner_id: product.id, slot: 'gallery' }, asset_id: image.id })
      }
      for (const place of [brooklyn, williamsburg]) await tool('set_product_location', { product_id: product.id, location_id: place.id, active: true, published: true })
      await tool('set_product_publication', { product_id: product.id, published: true })
      return recordProduct(tenant, key, product)
    }
    const pies = [
      await dish('margherita', 'Margherita', 1800, margherita),
      await dish('pepperoni', 'Pepperoni', 2000),
      await dish('mushroom', 'Wild Mushroom', 2100),
    ]
    const starters = [await dish('burrata', 'Burrata', 1400, burrata), await dish('garlic-knots', 'Garlic Knots', 900)]
    const special = await dish('brooklyn-special', 'Brooklyn Clam Pie', 2600)

    const collection = async (key: string, name: string, products: Array<{ id: string }>, locationId: string | null = null) => {
      const { collection: created } = await tool<{ collection: { id: string; name: string; location_id: string | null } }>('create_collection', { name, ...(locationId ? { location_id: locationId } : {}) })
      await tool('set_collection_products', { collection_id: created.id, product_ids: products.map(product => product.id) })
      tenant.collections[key] = { id: created.id, name: created.name, location_id: created.location_id }
    }
    await collection('pizzas', 'Pizzas', pies)
    await collection('starters', 'Starters', starters)
    await collection('brooklyn-specials', 'Brooklyn Specials', [special], brooklyn.id)

    const { category } = await tool<{ category: { id: string; name: string } }>('create_article_category', { collection: 'blog', name: 'Kitchen', description: 'Notes from the kitchen' })
    tenant.categories.kitchen = { id: category.id, name: category.name }
    return tenant
  } finally { await owner.dispose() }
}
