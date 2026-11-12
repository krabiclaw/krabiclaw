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

test('formatPlatformTitle preserves existing brand-prefixed titles without stutter', () => {
  assert.equal(
    formatPlatformTitle('KrabiClaw | Open-Source Websites, Bookings & Payments'),
    'KrabiClaw | Open-Source Websites, Bookings & Payments',
  )
  assert.equal(
    formatPlatformTitle('KrabiClaw — Open-Source Websites'),
    'KrabiClaw — Open-Source Websites',
  )
  assert.equal(formatPlatformTitle('KrabiClaw'), 'KrabiClaw')
})

test('formatPlatformTitle appends brand suffix for normal page titles', () => {
  assert.equal(formatPlatformTitle('Pricing'), 'Pricing | KrabiClaw')
  assert.equal(formatPlatformTitle('Documentation'), 'Documentation | KrabiClaw')
  assert.equal(formatPlatformTitle('Terms of Service'), 'Terms of Service | KrabiClaw')
})

test('truncateForSeo preserves titles within 70 characters without truncation', () => {
  const brandTitle = 'KrabiClaw | Open-Source Websites, Bookings & Payments'
  assert.ok(brandTitle.length <= 70)
  assert.equal(truncateForSeo(brandTitle, 70), brandTitle)
})
