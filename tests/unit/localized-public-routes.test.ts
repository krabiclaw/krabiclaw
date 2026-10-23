import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateLocaleCatalog } from '../../shared/platform-locale-catalog.ts'
import { projectExactLocalizedResource } from '../../server/utils/public-localization.ts'
import { resolveTenantLocalePath } from '../../utils/tenant-locale-path.ts'
import { tenantBlogPostPath } from '../../utils/tenant-blog-route.ts'
import { validateLocalizedRoutePath } from '../../server/utils/localization-registry.ts'
import { alignTenantPageTranslationBlocks, createTenantPageBlock, createTenantPageTranslationBlocks, tenantPageLocalizedTextFields } from '../../utils/tenant-page-blocks.ts'

test('page translation drafts clear declared copy and retain URLs, identities, choices and calculator values', () => {
  const source = [
    createTenantPageBlock('hero', { title: 'Visit us', accent: 'us', rotating_accents: ['Today', 'Tonight'], cta_label: 'Book', cta_url: '/book', secondary_label: 'View menu', secondary_url: '/menu' }),
    createTenantPageBlock('social_posts', { title: 'News', limit: 6, location_id: 'location-1', call_to_action: { label: 'All posts', url: '/posts' } }),
    createTenantPageBlock('language_reach', { items: [{ title: 'English', locale: 'en' }] }),
    createTenantPageBlock('feature_grid', { source: 'calculator', calculator: { note: 'Your rate', rows: [[1, '$10,000', 20000, 30000]] } }),
    createTenantPageBlock('page_grid', { accent: 'Explore', page_ids: ['page-1'] }),
    createTenantPageBlock('video', { title: 'Our story', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', upload_date: '2026-10-23' }),
  ]
  const before = structuredClone(source)
  const translations = createTenantPageTranslationBlocks(source)
  assert.deepEqual(translations.map(block => block.data), [
    { title: '', accent: '', rotating_accents: ['', ''], cta_label: '', cta_url: '/book', secondary_label: '', secondary_url: '/menu' },
    { title: '', limit: 6, location_id: 'location-1', call_to_action: { label: '', url: '/posts' } },
    { items: [{ title: '', locale: 'en' }] },
    { source: 'calculator', calculator: { note: 'Your rate', rows: [[1, '$10,000', 20000, 30000]] } },
    { accent: '', page_ids: ['page-1'] },
    { title: '', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', upload_date: '2026-10-23' },
  ])
  assert.deepEqual(tenantPageLocalizedTextFields(source[0]!).map(field => field.path), [
    ['title'], ['accent'], ['rotating_accents', 0], ['rotating_accents', 1], ['cta_label'], ['secondary_label'],
  ])
  assert.deepEqual(source, before)
})

test('aligning page translations retains authored second-button and list copy while preserving source structure', () => {
  const source = createTenantPageBlock('hero', { title: 'Visit us', accent: 'us', rotating_accents: ['Today', 'Tonight'], secondary_label: 'View menu', secondary_url: '/menu' })
  const [aligned] = alignTenantPageTranslationBlocks([source], [{
    ...source, id: 'translated-hero', source_block_id: source.id,
    data: { title: 'Ghé thăm', accent: 'chúng tôi', rotating_accents: ['Hôm nay', 'Tối nay'], secondary_label: 'Xem thực đơn', secondary_url: '/incorrect' },
  }])
  assert.equal(aligned!.id, 'translated-hero')
  assert.equal(aligned!.source_block_id, source.id)
  assert.deepEqual(aligned!.data, {
    title: 'Ghé thăm', accent: 'chúng tôi', rotating_accents: ['Hôm nay', 'Tối nay'], secondary_label: 'Xem thực đơn', secondary_url: '/menu',
  })
})

test('catch-all locale classification uses the tenant published-locale set', () => {
  assert.deepEqual(resolveTenantLocalePath('/th/contact', ['th']), {
    localeSegment: 'th',
    sourcePath: '/contact',
    publicPath: '/th/contact',
  })
  for (const path of ['/faq', '/app', '/art']) {
    assert.deepEqual(resolveTenantLocalePath(path, ['th']), {
      localeSegment: null,
      sourcePath: path,
      publicPath: path,
    })
  }
})

test('localized projection clears untranslated localizable fields', () => {
  const projected = projectExactLocalizedResource(
    'product',
    { id: 'product-1', name: 'English name', description: 'English description', variants: [{ id: 'var-1', prices: [{ unit_amount: 2500 }] }] },
    {
      resourceType: 'product',
      resourceId: 'product-1',
      locale: 'th',
      routePath: '/th/locations/studio/products/lesson',
      values: { name: 'บทเรียน' },
    },
  )

  assert.equal(projected.name, 'บทเรียน')
  // An untranslated field is cleared rather than shown in the source language,
  // and cleared is its type's empty value: the Product contract requires a
  // description string, and a projection missing it failed
  // every page that carried it.
  assert.equal(projected.description, '')
  // Prices are not language, so they survive verbatim.
  assert.deepEqual(projected.variants, [{ id: 'var-1', prices: [{ unit_amount: 2500 }] }])
})

test('professional-service blog paths use the canonical /blog route', () => {
  assert.equal(tenantBlogPostPath('thai-law'), '/blog/thai-law')
})

test('a location translation retains its saved historical route and refuses an explicit move', () => {
  assert.equal(validateLocalizedRoutePath('business_location', 'th', undefined, 'current-location'), '/th/locations/current-location')
  assert.equal(validateLocalizedRoutePath('business_location', 'th', null, 'current-location'), '/th/locations/current-location')
  assert.equal(validateLocalizedRoutePath('business_location', 'th', undefined, 'current-location', '/th/locations/historical-name'), '/th/locations/historical-name')
  assert.equal(validateLocalizedRoutePath('business_location', 'th', null, 'current-location', '/th/locations/historical-name'), '/th/locations/historical-name')
  assert.equal(validateLocalizedRoutePath('business_location', 'th', '/th/locations/historical-name', 'current-location', '/th/locations/historical-name'), '/th/locations/historical-name')
  assert.throws(() => validateLocalizedRoutePath('business_location', 'th', '/th/locations/current-location', 'current-location', '/th/locations/historical-name'),
    { statusCode: 422, message: 'A translation keeps its canonical path' })
  assert.throws(() => validateLocalizedRoutePath('business_location', 'th', undefined, 'current-location', null),
    { statusCode: 500, message: 'The location translation has no saved route' })
})

test('platform catalog validation rejects placeholder drift', () => {
  assert.deepEqual(
    validateLocaleCatalog({ greeting: 'Hello {name}' }, { greeting: 'สวัสดี' }, { complete: true }),
    {
      ok: false,
      issue: { kind: 'placeholder', key: 'greeting', expected: ['name'], actual: [] },
    },
  )
})
