import type { CreateTenant } from '../seed.ts'
import { SEED_SUBDOMAINS, type SeedTenant } from '../manifest.ts'
import { everyDay, publishProfile, recordProduct, seedLocation, seedMedia, setWorkingHours, toolFor } from './common.ts'

const ATTORNEY_ID = 'user-e2e-ncls-owner'

// Harbor Legal Aid is a fictional nonprofit practice on the Blawby template:
// one Raleigh office, two attorneys and practice areas clients request
// consultations for.
export async function seedLegal(createTenant: CreateTenant): Promise<SeedTenant> {
  const { owner, tenant } = await createTenant({
    key: 'legal', name: 'Harbor Legal Aid', slug: 'harbor-legal-aid', subdomain: SEED_SUBDOMAINS.legal,
    vertical: 'service', currency: 'USD', timezone: 'America/New_York', subscription: 'growth',
  })
  try {
    const tool = toolFor(owner, tenant)
    const office = await seedLocation(tool, tenant, 'raleigh', {
      title: 'Raleigh Office', email: 'raleigh@harbor-legal.example', phone: '+19195550123', hours: everyDay(9, 17, [1, 2, 3, 4, 5]),
      address: { regionCode: 'US', addressLines: ['200 Fayetteville Street'], locality: 'Raleigh', administrativeArea: 'NC', postalCode: '27601' },
    })

    const attorneyMemberId = tenant.memberIds[ATTORNEY_ID]
    if (!attorneyMemberId) throw new Error('The Harbor Legal Aid attorney is not a member')
    await setWorkingHours(tool, attorneyMemberId, 'America/New_York', [1, 2, 3, 4, 5], '09:00', '17:00')
    await publishProfile(tool, attorneyMemberId, 'Dana Brooks, Esq.', 'Dana represents families in custody, support and divorce matters.')

    const logo = await seedMedia(owner, tenant, 'logo', 'office.avif', 'Harbor Legal Aid')
    await tool('set_media', { placement: { owner_type: 'organization', owner_id: tenant.organizationId, slot: 'logo' }, asset_id: logo.id })
    const officeImage = await seedMedia(owner, tenant, 'office', 'office.avif', 'The Raleigh office reception')
    await seedMedia(owner, tenant, 'attorney', 'portrait.avif', 'Dana Brooks')

    const practiceArea = async (key: string, name: string, path: string, summary: string) => {
      const { product } = await tool<{ product: { id: string; slug: string; name: string; kind: string } }>('create_product', {
        kind: 'service', name, description: summary, active: true, idempotency_key: `seed-legal-${key}`,
        variants: [{ name: 'Consultation', prices: [{ unit_amount: 0, currency: 'USD' }] }],
        booking: {
          location_id: office.id, duration_minutes: 60, default_capacity: 1, confirmation_mode: 'review',
          scheduling_mode: 'provider', assigned_member_id: attorneyMemberId,
          weekly_slots: [1, 2, 3, 4, 5].flatMap(weekday => ['10:00', '14:00'].map(start_time => ({ weekday, start_time }))),
        },
        page: {
          path, title: name, summary,
          blocks: [
            { type: 'hero', data: { title: name, subtitle: summary } },
            { type: 'markdown', data: { editor_mode: 'rich', markdown: `Our attorneys help clients with ${name.toLowerCase()} matters across Wake County. Request a consultation and an attorney will review it within two business days.` } },
          ],
        },
      })
      await tool('set_product_location', { product_id: product.id, location_id: office.id, active: true, published: true })
      await tool('set_product_publication', { product_id: product.id, published: true })
      return recordProduct(tenant, key, product)
    }
    await practiceArea('family-law', 'Family Law', '/services/family', 'Custody, child support, divorce and protective orders.')
    await practiceArea('housing', 'Housing Law', '/services/housing', 'Eviction defense and tenant rights.')
    await tool('set_consultation_mode', { mode: 'native' })

    // The home page asks for a consultation, beside a photo of the office.
    const { pages } = await tool<{ pages: Array<{ id: string; path: string }> }>('list_site_pages', { locale: 'en' })
    const home = pages.find(page => page.path === '/')
    if (!home) throw new Error('Harbor Legal Aid has no home page')
    const { page } = await tool<{ page: { document: { id: string } } }>('get_site_page', { variant_id: home.id })
    await tool('append_content_block', {
      document_id: page.document.id, type: 'contact_cta',
      data: { title: 'Talk to an attorney', description: 'Request a free consultation about your situation.', label: 'Request a consultation', url: '/schedule' },
      media: [{ asset_id: officeImage.id, slot: 'featured' }],
    })
    return tenant
  } finally { await owner.dispose() }
}
