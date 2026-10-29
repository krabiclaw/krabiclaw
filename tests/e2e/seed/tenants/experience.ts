import type { CreateTenant } from '../seed.ts'
import { SEED_SUBDOMAINS, type SeedTenant } from '../manifest.ts'
import { alwaysOpen, everyDay, publishProfile, recordProduct, seedLocation, seedMedia, toolFor } from './common.ts'

const HOST_ID = 'user-e2e-pottery-location-owner'

// Clayhouse Studio is a fictional pottery school in Krabi: two studios, a
// daily wheel class hosted by one teacher and a glazing session at the river.
// The Ao Nang studio never closes, so the class it seeds now is always in hours.
export async function seedExperience(createTenant: CreateTenant): Promise<SeedTenant> {
  const { owner, tenant } = await createTenant({
    key: 'experience', name: 'Clayhouse Studio', slug: 'clayhouse-studio', subdomain: SEED_SUBDOMAINS.experience,
    vertical: 'experience', currency: 'THB', timezone: 'Asia/Bangkok', subscription: 'growth',
  })
  try {
    const tool = toolFor(owner, tenant)
    const address = (street: string) => ({ regionCode: 'TH', addressLines: [street], locality: 'Krabi', administrativeArea: 'Krabi', postalCode: '81000' })
    const aoNang = await seedLocation(tool, tenant, 'ao-nang', { title: 'Ao Nang Studio', email: 'aonang@clayhouse.example', phone: '+66812345678', hours: alwaysOpen(), address: address('12 Ao Nang Road') })
    const riverside = await seedLocation(tool, tenant, 'riverside', { title: 'Riverside Studio', email: 'riverside@clayhouse.example', phone: '+66812345679', hours: everyDay(10, 17), address: address('5 River Walk') })

    const hostMemberId = tenant.memberIds[HOST_ID]
    if (!hostMemberId) throw new Error('The Clayhouse host is not a member')
    await publishProfile(tool, hostMemberId, 'Mali, studio teacher', 'Mali has taught the wheel in Ao Nang for ten years.')

    const classImage = await seedMedia(owner, tenant, 'wheel-class', 'class.avif', 'Hands shaping clay on the wheel')
    const studioImage = await seedMedia(owner, tenant, 'studio', 'venue.avif', 'The open-air studio')

    const experience = async (key: string, input: { name: string; description: string; location: { id: string }; start: string; capacity: number; amount: number; image: { id: string } }) => {
      const { product } = await tool<{ product: { id: string; slug: string; name: string; kind: string } }>('create_product', {
        kind: 'experience', name: input.name, description: input.description, active: true, idempotency_key: `seed-experience-${key}`,
        variants: [{ name: 'One guest', prices: [{ unit_amount: input.amount, currency: 'THB' }] }],
        booking: {
          location_id: input.location.id, duration_minutes: 120, default_capacity: input.capacity, confirmation_mode: 'instant',
          scheduling_mode: 'legacy', assigned_member_id: hostMemberId,
          weekly_slots: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start_time: input.start })),
        },
      })
      await tool('set_media', { placement: { owner_type: 'product', owner_id: product.id, slot: 'image' }, asset_id: input.image.id })
      for (const asset of [input.image, studioImage]) await tool('attach_media', { placement: { owner_type: 'product', owner_id: product.id, slot: 'gallery' }, asset_id: asset.id })
      await tool('set_product_location', { product_id: product.id, location_id: input.location.id, active: true, published: true })
      await tool('set_product_publication', { product_id: product.id, published: true })
      return recordProduct(tenant, key, product)
    }
    await experience('wheel-class', {
      name: 'Wheel Throwing Class', location: aoNang, start: '11:00', capacity: 8, amount: 150000, image: classImage,
      description: [
        'Spend two unhurried hours at the wheel with a teacher beside you. You will centre the clay, open it and pull up the walls of your first bowl.',
        'Every guest has their own wheel, apron and tools. Pieces are trimmed and fired after the class and ready to collect a week later, or posted anywhere in Thailand.',
        'No experience is needed. Wear clothes that can meet a little clay, and bring a friend: the class is as much about the afternoon as the bowl.',
      ].join('\n\n'),
    })
    await experience('glaze-painting', {
      name: 'Glaze Painting Session', location: riverside, start: '14:00', capacity: 10, amount: 90000, image: studioImage,
      description: 'Paint a bisque-fired cup or plate with our glazes by the river, then collect it after the kiln firing.',
    })
    // A guest who already came: a short class booked now that ends while the
    // seed finishes, so the studio has a conversation in its past mailbox.
    const wheel = tenant.products['wheel-class']!
    const startsAt = new Date(Date.now() + 15_000)
    const endsAt = new Date(startsAt.getTime() + 60_000)
    const { sessions: [session] } = await tool<{ sessions: Array<{ id: string }> }>('create_product_session', {
      product_id: wheel.id, location_id: aoNang.id, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), capacity: 4, idempotency_key: 'seed-experience-ended-class',
    })
    await tool('create_product_booking', {
      product_slug: wheel.slug, session_id: session!.id, party_size: 1, guest_name: 'Past Guest', guest_email: 'past-guest@playwright.example',
      source: 'phone', guest_acknowledgement: false, idempotency_key: 'seed-experience-ended-booking',
    })
    tenant.endedSessionEndsAt = endsAt.toISOString()
    return tenant
  } finally { await owner.dispose() }
}
