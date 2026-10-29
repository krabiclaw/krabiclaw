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

    // Its buttons use the site's accent colour.
    await tool('update_organization_settings', { button_color: 'accent' })
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
    // The practice once booked through an outside scheduler; its link stays saved after moving to native consultations.
    await tool('set_consultation_mode', { mode: 'external_url', external_url: 'https://scheduler.example/harbor-legal-aid' })
    await tool('set_consultation_mode', { mode: 'native' })

    // The family-law page opens with a cover photo and a gallery of seven more.
    const family = await tool<{ pages: Array<{ id: string; path: string }> }>('list_site_pages', { locale: 'en' })
    const familyPage = family.pages.find(page => page.path === '/services/family')
    if (!familyPage) throw new Error('Harbor Legal Aid has no family-law page')
    const { page: familyDocument } = await tool<{ page: { document: { id: string } } }>('get_site_page', { variant_id: familyPage.id })
    await tool('set_media', { placement: { owner_type: 'content_document', owner_id: familyDocument.document.id, slot: 'cover' }, asset_id: officeImage.id })
    const galleryFiles: Array<[string, string]> = [['class.avif', 'A client meeting'], ['dish.avif', 'The waiting room'], ['room.avif', 'The conference room'], ['venue.avif', 'The library'], ['social.avif', 'Our community clinic'], ['poster.avif', 'The front desk'], ['portrait.avif', 'An attorney at work']]
    for (const [index, [file, altText]] of galleryFiles.entries()) {
      const asset = await seedMedia(owner, tenant, `family-gallery-${index + 1}`, file, altText)
      await tool('attach_media', { placement: { owner_type: 'content_document', owner_id: familyDocument.document.id, slot: 'gallery' }, asset_id: asset.id })
    }

    // What consultations cost, with the questions clients ask on that page.
    await tool('create_site_page', {
      path: '/pricing', title: 'Pricing', pageType: 'custom', locale: 'en',
      blocks: [
        { type: 'hero', data: { title: 'Pricing', subtitle: 'Free consultations for clients who qualify for legal aid.' } },
        { type: 'faq', data: { source: 'page_qa', title: 'Questions about cost' } },
      ],
    })

    // The home page asks for a consultation, beside a photo of the office.
    const { pages } = await tool<{ pages: Array<{ id: string; path: string }> }>('list_site_pages', { locale: 'en' })
    const home = pages.find(page => page.path === '/')
    if (!home) throw new Error('Harbor Legal Aid has no home page')
    const { page } = await tool<{ page: { document: { id: string }; blocks: Array<{ id: string; type: string; updated_at: string; data: { title?: string } }> } }>('get_site_page', { variant_id: home.id })
    const hero = page.blocks.find(block => block.type === 'hero')
    if (!hero) throw new Error('Harbor Legal Aid\'s home page has no hero')
    await tool('replace_content_block', {
      block_id: hero.id, expected_updated_at: hero.updated_at,
      data: { title: hero.data.title ?? 'Harbor Legal Aid', subtitle: 'Free legal help for families in Wake County.', cta_label: 'Request a consultation', cta_url: '/schedule' },
    })
    await tool('append_content_block', {
      document_id: page.document.id, type: 'contact_cta',
      data: { title: 'Talk to an attorney', description: 'Request a free consultation about your situation.', label: 'Request a consultation', url: '/schedule' },
      media: [{ asset_id: officeImage.id, slot: 'featured' }],
    })
    return tenant
  } finally { await owner.dispose() }
}
