import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateLocaleCatalog } from '../../shared/platform-locale-catalog.ts'
import { projectExactLocalizedResource } from '../../server/utils/public-localization.ts'
import { resolveTenantLocalePath } from '../../utils/tenant-locale-path.ts'
import { tenantBlogPostPath } from '../../utils/tenant-blog-route.ts'
import { isTrackablePath } from '../../utils/pageview-path.ts'

test('private OAuth and invitation workflows cannot produce public pageviews', () => {
  for (const path of ['/oauth', '/oauth/consent', '/oauth/callback', '/accept-invitation', '/accept-invitation/invitation-id']) {
    assert.equal(isTrackablePath(path), false, path)
  }
  for (const path of ['/login', '/signup', '/oauth-guide', '/accept-invitation-guide']) {
    assert.equal(isTrackablePath(path), true, path)
  }
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

test('professional-service blog paths use the Blawby article route', () => {
  assert.equal(tenantBlogPostPath({ vertical: 'service' }, 'thai-law'), '/article/thai-law')
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
