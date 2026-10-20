import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ROBOTS_VISIBILITY,
  ROBOTS_DIRECTIVES,
  ROBOTS_DISABLED_DIRECTIVE,
  ROBOTS_ENABLED_DIRECTIVE,
  robotsDirective,
} from '../../shared/robots-directive.ts'
import { composeSocialMetadata } from '../../utils/social-metadata.ts'

test('the served directive is derived from what the surface is', () => {
  // Live, listed public content: indexable, and carrying the preview
  // directives Google reads for rich results.
  assert.equal(
    robotsDirective('listed'),
    'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
  )
  // Published but unlisted: reachable by its own URL, absent from discovery.
  // Links out still count, so it follows.
  assert.equal(robotsDirective('unlisted'), 'noindex, follow')
  // An authenticated preview, the dashboard, and every internal, auth and
  // setup surface.
  assert.equal(robotsDirective('private'), 'noindex, nofollow')
})

test('a surface that says nothing about itself is public, listed content', () => {
  assert.equal(DEFAULT_ROBOTS_VISIBILITY, 'listed')
  assert.equal(robotsDirective(null), ROBOTS_ENABLED_DIRECTIVE)
  assert.equal(robotsDirective(undefined), ROBOTS_ENABLED_DIRECTIVE)
  // @nuxtjs/robots serves these two, so the module's site-wide tag and this
  // contract agree byte for byte.
  assert.equal(ROBOTS_ENABLED_DIRECTIVE, ROBOTS_DIRECTIVES.listed)
  assert.equal(ROBOTS_DISABLED_DIRECTIVE, ROBOTS_DIRECTIVES.private)
})

test('only indexable content carries the preview directives', () => {
  // A preview limit describes a search result that will not exist.
  for (const visibility of ['unlisted', 'private'] as const) {
    assert.ok(!robotsDirective(visibility).includes('max-image-preview'))
  }
})

test('every composed page carries the derived robots directive', () => {
  const base = {
    template: 'platform' as const,
    title: 'Pricing',
    canonicalUrl: 'https://krabiclaw.com/pricing',
    brand: { organizationName: 'KrabiClaw' },
  }
  assert.equal(composeSocialMetadata(base, null).robots, ROBOTS_ENABLED_DIRECTIVE)
  assert.equal(composeSocialMetadata({ ...base, discoverability: null }, null).robots, ROBOTS_ENABLED_DIRECTIVE)
  assert.equal(
    composeSocialMetadata({ ...base, discoverability: 'private' }, null).robots,
    ROBOTS_DISABLED_DIRECTIVE,
  )
  assert.equal(
    composeSocialMetadata({ ...base, discoverability: 'unlisted' }, null).robots,
    'noindex, follow',
  )
})

test('no tenant value can reach the directive', () => {
  // The whole vocabulary is three names this module owns. There is no parser
  // and no stored intent, so there is nothing a tenant could submit that ends
  // up in a robots tag.
  assert.deepEqual(Object.keys(ROBOTS_DIRECTIVES).sort(), ['listed', 'private', 'unlisted'])
})
