import type { CreateTenant } from '../seed.ts'
import type { SeedTenant } from '../manifest.ts'

type Location = { id: string; slug: string; title: string; timezone: string }

// Ember & Slice is KrabiClaw's fictional pizzeria: two New York locations with
// table reservations, a menu, a bookable class and a kitchen blog.
export async function seedRestaurant(createTenant: CreateTenant): Promise<SeedTenant> {
  const { owner, tenant } = await createTenant({
    key: 'restaurant', name: 'Ember & Slice', slug: 'ember-slice-demo', subdomain: 'demo',
    vertical: 'restaurant', currency: 'USD', timezone: 'America/New_York',
  })
  try {
    const org = tenant.organizationId
    const tool = <T>(name: string, args: Record<string, unknown>) => owner.tool<T>(org, name, args)
    const everyDay = (open: number, close: number) => ({ periods: [0, 1, 2, 3, 4, 5, 6].map(day => ({ open: { day, hour: open, minute: 0 }, close: { day, hour: close, minute: 0 } })) })

    const location = async (key: string, title: string, street: string) => {
      const { location: created } = await tool<{ location: Location }>('create_location', { title, timezone: 'America/New_York', idempotency_key: `seed-${key}` })
      await tool('update_location', {
        location_id: created.id, status: 'active',
        email: `${key}@ember-slice.example`, phone: '+12025550123',
        address: { regionCode: 'US', addressLines: [street], locality: 'Brooklyn', administrativeArea: 'NY', postalCode: '11201' },
        opening_hours: everyDay(11, 22),
      })
      tenant.locations[key] = { id: created.id, slug: created.slug, title: created.title, timezone: 'America/New_York' }
      return created
    }
    const brooklyn = await location('brooklyn', 'Ember & Slice Brooklyn', '120 Atlantic Avenue')
    const williamsburg = await location('williamsburg', 'Ember & Slice Williamsburg', '88 Bedford Avenue')

    // Table reservations: 90-minute seatings, flexible (two-hour) cancellation.
    for (const place of [brooklyn, williamsburg]) {
      await tool('update_reservation_policy', {
        location_id: place.id, expected_updated_at: null, duration_minutes: 90, slot_capacity: 40, cancellation_policy: 'flexible',
      })
    }

    const upload = async (key: string, file: string, altText: string) => {
      tenant.media[key] = await owner.upload(org, file, { altText })
      return tenant.media[key]!
    }
    const margherita = await upload('margherita', 'dish.avif', 'Margherita pizza with basil')
    const burrata = await upload('burrata', 'venue.avif', 'Burrata with tomatoes')
    await upload('dining-room', 'room.avif', 'The Brooklyn dining room')
    for (const asset of [burrata, tenant.media['dining-room']!]) {
      await tool('attach_media', { placement: { owner_type: 'business_location', owner_id: williamsburg.id, slot: 'gallery' }, asset_id: asset.id })
    }

    const dish = async (key: string, name: string, cents: number, image?: { id: string }) => {
      const { product } = await tool<{ product: { id: string; slug: string; name: string; kind: string } }>('create_product', {
        kind: 'dish', name, active: true, idempotency_key: `seed-${key}`,
        variants: [{ name, prices: [{ unit_amount: cents, currency: 'USD' }] }],
      })
      tenant.products[key] = { id: product.id, slug: product.slug, name: product.name, kind: product.kind }
      if (image) await tool('set_media', { placement: { owner_type: 'product', owner_id: product.id, slot: 'image' }, asset_id: image.id })
      if (image) await tool('attach_media', { placement: { owner_type: 'product', owner_id: product.id, slot: 'gallery' }, asset_id: image.id })
      for (const place of [brooklyn, williamsburg]) await tool('set_product_location', { product_id: product.id, location_id: place.id, active: true, published: true })
      await tool('set_product_publication', { product_id: product.id, published: true })
      return product
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
