import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatPlatformTitle,
  PLATFORM_DEFAULT_TITLE,
  truncateForSeo,
} from '../../utils/social-metadata.ts'

test('formatPlatformTitle returns canonical brand title when no title is provided', () => {
  assert.equal(formatPlatformTitle(), PLATFORM_DEFAULT_TITLE)
  assert.equal(formatPlatformTitle(null), PLATFORM_DEFAULT_TITLE)
  assert.equal(formatPlatformTitle(''), PLATFORM_DEFAULT_TITLE)
  assert.equal(formatPlatformTitle('   '), PLATFORM_DEFAULT_TITLE)
})

test('formatPlatformTitle preserves titles with an existing brand without stutter', () => {
  assert.equal(
    formatPlatformTitle('Blawby | Open-Source Websites, Bookings & Payments'),
    'Blawby | Open-Source Websites, Bookings & Payments',
  )
  assert.equal(
    formatPlatformTitle('Blawby — Open-Source Websites'),
    'Blawby — Open-Source Websites',
  )
  assert.equal(formatPlatformTitle('Blawby'), 'Blawby')
  assert.equal(formatPlatformTitle('Lodging | Blawby'), 'Lodging | Blawby')
})

test('formatPlatformTitle appends brand suffix for normal page titles', () => {
  assert.equal(formatPlatformTitle('Pricing'), 'Pricing | Blawby')
  assert.equal(formatPlatformTitle('Documentation'), 'Documentation | Blawby')
  assert.equal(formatPlatformTitle('Terms of Service'), 'Terms of Service | Blawby')
})

test('truncateForSeo preserves titles within 70 characters without truncation', () => {
  const brandTitle = 'Blawby | Open-Source Websites, Bookings & Payments'
  assert.ok(brandTitle.length <= 70)
  assert.equal(truncateForSeo(brandTitle, 70), brandTitle)
})
