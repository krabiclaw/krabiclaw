import type { SeedClient } from '../client.ts'

// KrabiClaw's own site, as its administrator authors it: a home page whose hero
// carries its layered artwork, a pricing page that reads the plans from
// billing, and the plugin and products pages. Only the structure the platform pages require is authored here.
const PARALLAX_LAYERS = ['sky', 'clouds', 'mountains', 'far_trees', 'building_trees', 'foreground']
const PARALLAX_SIZES = ['xxs', 'xs', 'sm', 'md', 'lg']

export async function seedPlatform(owner: SeedClient, platformOrganizationId: string) {
  const tool = <T>(name: string, args: Record<string, unknown>) => owner.tool<T>(platformOrganizationId, name, args)
  const artwork = await owner.upload(platformOrganizationId, 'social.avif', { altText: 'Krabi coastline at dusk' })

  const { pages } = await tool<{ pages: Array<{ id: string; path: string }> }>('list_site_pages', { locale: 'en' })
  const home = pages.find(page => page.path === '/')
  if (!home) throw new Error('The platform site has no home page')
  const { page } = await tool<{ page: { blocks: Array<{ id: string; type: string; updated_at: string }> } }>('get_site_page', { variant_id: home.id })
  const hero = page.blocks.find(block => block.type === 'hero')
  if (!hero) throw new Error('The platform home page has no hero')
  await tool('replace_content_block', {
    block_id: hero.id, expected_updated_at: hero.updated_at,
    data: { title: 'Your business, online in minutes', subtitle: 'Websites, bookings and messages for local businesses.', cta_label: 'Start free', cta_url: '/signup' },
  })
  for (const slot of ['media', ...PARALLAX_LAYERS.flatMap(layer => PARALLAX_SIZES.map(size => `parallax_${layer}_${size}`))]) {
    await tool('set_media', { placement: { owner_type: 'content_block', owner_id: hero.id, slot }, asset_id: artwork.id })
  }

  for (const [path, title] of [['/plugin', 'KrabiClaw for your AI assistant'], ['/products', 'Your website is just the beginning']]) {
    await tool('create_site_page', { path, title, pageType: 'custom', locale: 'en', blocks: [{ type: 'hero', data: { title } }] })
  }
  await tool('create_site_page', {
    path: '/pricing', title: 'Pricing', pageType: 'custom', locale: 'en',
    blocks: [
      { type: 'hero', data: { eyebrow: 'Simple, flexible plans', title: 'Simple, transparent pricing.' } },
      { type: 'feature_grid', data: { source: 'billing_plans', title: 'Plans' } },
      { type: 'feature_grid', data: { source: 'billing_features', title: 'Compare the details.' } },
    ],
  })
}
