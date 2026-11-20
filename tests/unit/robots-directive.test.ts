import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ROBOTS_DISABLED_DIRECTIVE,
  ROBOTS_ENABLED_DIRECTIVE,
} from '../../shared/robots-directive.ts'
import { composeSocialMetadata } from '../../utils/social-metadata.ts'

test('every composed page carries the derived robots directive', () => {
  const base = {
    template: 'platform' as const,
    title: 'Pricing',
    canonicalUrl: 'https://blawby.com/pricing',
    brand: { organizationName: 'Blawby' },
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

