import type { CreateTenant } from '../seed.ts'
import { SEED_SUBDOMAINS, type SeedTenant } from '../manifest.ts'
import { everyDay, publishProfile, recordProduct, seedLocation, seedMedia, toolFor } from './common.ts'

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
    // A party of four booked by phone for dinner a week from today in Brooklyn.
    const nextWeek = new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone }).format(Date.now() + 7 * 86_400_000)
    await tool('create_table_reservation', {
      location_id: brooklyn.id, date: nextWeek, time: '19:00', party_size: 4, guest_name: 'Maya Chen', guest_email: 'maya.chen@playwright.example',
      guest_phone: '+12025550188', idempotency_key: 'seed-restaurant-reservation', source: 'phone', guest_acknowledgement: false,
    })

    const margherita = await seedMedia(owner, tenant, 'margherita', 'dish.avif', 'Margherita pizza with basil')
    const burrata = await seedMedia(owner, tenant, 'burrata', 'venue.avif', 'Burrata with tomatoes')
    const diningRoom = await seedMedia(owner, tenant, 'dining-room', 'room.avif', 'The Brooklyn dining room')
    const logo = await seedMedia(owner, tenant, 'logo', 'dish.avif', 'Ember & Slice')
    await tool('set_media', { placement: { owner_type: 'organization', owner_id: tenant.organizationId, slot: 'logo' }, asset_id: logo.id })
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

    // Besides its menu, Brooklyn teaches a pizza class on Saturdays at opening, hosted by its chef.
    const chefMemberId = tenant.memberIds['user-e2e-demo-owner']
    if (!chefMemberId) throw new Error('The Ember & Slice chef is not a member')
    await publishProfile(tool, chefMemberId, 'Rosa, head chef', 'Rosa has run the Brooklyn wood oven since it was lit.')
    const { product: pizzaClass } = await tool<{ product: { id: string; slug: string; name: string; kind: string } }>('create_product', {
      kind: 'experience', name: 'Pizza-Making Class', active: true, idempotency_key: 'seed-pizza-class',
      description: 'Stretch, top and fire your own pie in our wood oven with the Brooklyn kitchen team.',
      variants: [{ name: 'One guest', prices: [{ unit_amount: 6500, currency: 'USD' }] }],
      booking: { location_id: brooklyn.id, duration_minutes: 120, default_capacity: 12, confirmation_mode: 'instant', scheduling_mode: 'legacy', assigned_member_id: chefMemberId, weekly_slots: [{ weekday: 6, start_time: '11:00' }] },
    })
    await tool('set_media', { placement: { owner_type: 'product', owner_id: pizzaClass.id, slot: 'image' }, asset_id: diningRoom.id })
    await tool('set_product_location', { product_id: pizzaClass.id, location_id: brooklyn.id, active: true, published: true })
    await tool('set_product_publication', { product_id: pizzaClass.id, published: true })
    recordProduct(tenant, 'pizza-class', pizzaClass)

    // The home page's hero sends guests to the menu.
    const { pages } = await tool<{ pages: Array<{ id: string; page_id: string; path: string }> }>('list_site_pages', { locale: 'en' })
    const home = pages.find(page => page.path === '/')
    if (!home) throw new Error('Ember & Slice has no home page')
    const { page } = await tool<{ page: { document: { id: string }; blocks: Array<{ id: string; type: string; updated_at: string; data: { title?: string } }> } }>('get_site_page', { variant_id: home.id })
    const hero = page.blocks.find(block => block.type === 'hero')
    if (!hero) throw new Error('Ember & Slice\'s home page has no hero')
    await tool('replace_content_block', {
      block_id: hero.id, expected_updated_at: hero.updated_at,
      data: { title: hero.data.title ?? 'Ember & Slice', subtitle: 'Wood-fired pizza in Brooklyn and Williamsburg.', cta_label: 'Reserve a table', cta_url: '/reservations', secondary_label: 'View menu', secondary_url: '/menu' },
    })

    // Its posts appear on the home page as they are published.
    await tool('append_content_block', { document_id: page.document.id, type: 'social_posts', data: { title: 'From the kitchen', limit: 6 } })

    // The site is also published in Japanese and Thai for visitors, each starting with its homepage.
    const translations = {
      ja: { title: 'エンバー＆スライス', subtitle: 'ブルックリンとウィリアムズバーグの薪窯ピザ。', cta_label: 'テーブルを予約', secondary_label: 'メニューを見る' },
      th: { title: 'เอมเบอร์ แอนด์ สไลซ์', subtitle: 'พิซซ่าเตาฟืนในบรูคลินและวิลเลียมส์เบิร์ก', cta_label: 'จองโต๊ะ', secondary_label: 'ดูเมนู' },
    }
    for (const [locale, copy] of Object.entries(translations)) {
      await tool('add_organization_language', { locale })
      await tool('create_site_page', {
        page_id: home.page_id, locale, path: '/', title: copy.title,
        blocks: [{ type: 'hero', source_block_id: hero.id, data: { ...copy, cta_url: '/reservations', secondary_url: '/menu' } }],
      })
      // Its locations carry the language too, so their pages (reservations among them) exist in it.
      for (const place of [brooklyn, williamsburg]) {
        await tool('put_resource_localization', { resource_type: 'business_location', resource_id: place.id, locale, values: { title: place.title } })
      }
      await tool('publish_organization_language', { locale })
    }

    const { category } = await tool<{ category: { id: string; name: string } }>('create_article_category', { collection: 'blog', name: 'Kitchen', description: 'Notes from the kitchen' })
    tenant.categories.kitchen = { id: category.id, name: category.name }
    const { category: specials } = await tool<{ category: { id: string; name: string } }>('create_article_category', { collection: 'blog', name: 'Specials', description: 'This week\'s specials' })
    tenant.categories.specials = { id: specials.id, name: specials.name }
    return tenant
  } finally { await owner.dispose() }
}
