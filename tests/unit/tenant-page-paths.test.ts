import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  claimedRoutesFromHandlers,
  claimedRoutesFromPages,
  mergeClaimedRoutes,
} from '../../build/claimed-public-routes.ts'
import { isClaimedPublicPath, templateAllowsPageDocumentAt } from '../../shared/tenant-page-paths.ts'
import { PLATFORM_TEMPLATE, resolvePublicTemplate } from '../../utils/template-registry.ts'
import { isTrackablePath } from '../../utils/pageview-path.ts'

// The invariant: a path is writable when the site's template renders a tenant
// page document there, or nothing claims the path and the template's catch-all
// renders it. Six hand-maintained lists used to answer this and they disagreed.

test('a page tree claims the paths its routes resolve, and only those', () => {
  const claims = claimedRoutesFromPages([
    { path: '/blog' },
    { path: '/blog/:slug()' },
    { path: '/docs/:segments(.*)*' },
    { path: '/locations/:slug()', children: [
      { path: 'menu' },
      { path: '/absolute-child' },
    ] },
    { path: '/help', alias: '/hilfe' },
    { path: '/:tenantPath(.*)*' },
  ])
  const patterns = claims.map(claim => `${claim.subtree ? 'subtree ' : 'exact '}${claim.pattern}`)

  assert.deepEqual(patterns.sort(), [
    'exact /absolute-child',
    'exact /blog',
    'exact /blog/:slug()',
    'exact /help',
    'exact /hilfe',
    'exact /locations/:slug()',
    'exact /locations/:slug()/menu',
    'subtree /docs',
  ])
})

test('nitro middleware and the catch-all renderer claim nothing', () => {
  const claims = claimedRoutesFromHandlers([
    { route: '/**', middleware: false },
    { route: '/*', middleware: false },
    { middleware: true },
    // An exact root handler is an ordinary claim, not a catch-all.
    { route: '/' },
    { route: '/robots.txt' },
  ])
  assert.deepEqual(claims, [
    { pattern: '/', subtree: false },
    { pattern: '/robots.txt', subtree: false },
  ])
})

const CLAIMS = mergeClaimedRoutes(
  claimedRoutesFromPages([
    { path: '/blog' },
    { path: '/blog/:slug()' },
    { path: '/menu' },
    { path: '/reservations' },
    { path: '/locations/:slug()' },
    { path: '/docs/:segments(.*)*' },
    { path: '/:locale(th)/about' },
  ]),
  [],
)

// A venue (restaurant, experience or stay) site, a legal practice's, and KrabiClaw's own.
function allows(site: 'venue' | 'legal' | 'platform', path: string) {
  const template = site === 'platform' ? PLATFORM_TEMPLATE : resolvePublicTemplate({ vertical: site === 'legal' ? 'service' : 'restaurant' })
  return templateAllowsPageDocumentAt(template, CLAIMS, path)
}

test('/blog is a page document on a legal practice and never one on a venue', () => {
  // The venue route asks for blog articles and renders the article index; a document
  // stored there would never be shown, so it may not be created.
  assert.equal(allows('legal', '/blog'), true)
  assert.equal(allows('venue', '/blog'), false)
})

test('a venue owns /reservations, which no tenant could author before', () => {
  assert.equal(allows('venue', '/reservations'), true)
})

test('a claimed route the template does not map is refused', () => {
  assert.equal(allows('venue', '/menu'), false)
  assert.equal(allows('legal', '/menu'), false)
  assert.equal(allows('venue', '/docs/anything/deeper'), false)
})

test('an unclaimed path is writable through the catch-all', () => {
  assert.equal(allows('venue', '/our-story'), true)
  assert.equal(allows('legal', '/services/family'), true)
})

test('a [param] route claims one segment, not the subtree below it', () => {
  assert.equal(allows('venue', '/blog/hello'), false)
  assert.equal(allows('venue', '/blog/2026/hello'), true)
})

test('a constrained param claims only what it matches', () => {
  assert.equal(allows('venue', '/th/about'), false)
  assert.equal(allows('venue', '/fr/about'), true)
})

test('the platform owns its marketing pages and excludes private auth routes from pageviews', () => {
  // KrabiClaw's own site renders page documents through the same loader and the
  // same catch-all every customer site uses (#903).
  assert.equal(allows('platform', '/about'), true)
  assert.equal(allows('platform', '/features'), true)
  assert.equal(allows('platform', '/'), true)
  // An unclaimed path is writable through the catch-all, and a claimed
  // tenant-only route the platform template does not map still is not.
  assert.equal(allows('platform', '/our-story'), true)
  assert.equal(allows('platform', '/menu'), false)
  for (const path of ['/oauth/login', '/oauth/consent', '/accept-invitation/nonexistent-invitation', '/login', '/forgot-password', '/reset-password']) {
    assert.equal(isTrackablePath(path), false, path)
  }
  for (const path of ['/signup', '/ja/menu', '/th/reservations', '/oauth-notes', '/accept-invitation-story']) {
    assert.equal(isTrackablePath(path), true, path)
  }
})

test('claimed route matching follows case-insensitive literals and constraints', () => {
  assert.equal(allows('venue', '/Blog'), false)
  assert.equal(allows('venue', '/TH/About'), false)
  assert.equal(allows('venue', '/FR/About'), true)
})

test('Nitro single-segment wildcards claim concrete paths, without claiming descendants', () => {
  const claims = claimedRoutesFromHandlers([{ route: '/feed/*' }, { route: '/files/:name' }, { route: '/docs-md/:category/:slug.md' }])
  assert.equal(isClaimedPublicPath(claims, '/feed/news'), true)
  assert.equal(isClaimedPublicPath(claims, '/feed/news/archive'), false)
  assert.equal(isClaimedPublicPath(claims, '/files/report'), true)
  assert.equal(isClaimedPublicPath(claims, '/docs-md/start/setup.md'), true)
  assert.equal(isClaimedPublicPath(claims, '/docs-md/start/setup'), false)
})
