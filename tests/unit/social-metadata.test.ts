import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatPlatformTitle,
  PLATFORM_DEFAULT_TITLE,
  resolveSocialImageFromMedia,
} from '../../utils/social-metadata.ts'

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
  assert.equal(formatPlatformTitle(), PLATFORM_DEFAULT_TITLE)
  assert.equal(formatPlatformTitle(null), PLATFORM_DEFAULT_TITLE)
  assert.equal(formatPlatformTitle(''), PLATFORM_DEFAULT_TITLE)
  assert.equal(formatPlatformTitle('   '), PLATFORM_DEFAULT_TITLE)
})

test('resolveSocialImageFromMedia prefers canonical product photograph over generated social_card', () => {
  const photo = { slot: 'image', kind: 'image' as const, public_url: 'https://img.example/property.jpg', mime_type: 'image/jpeg', width: 1200, height: 800 }
  const socialCard = { slot: 'social_card', kind: 'image' as const, public_url: 'https://img.example/card.png', mime_type: 'image/png' }
  const orgShare = { slot: 'social_share', kind: 'image' as const, public_url: 'https://img.example/org-share.jpg', mime_type: 'image/jpeg' }

  // 1. When canonical image slot is present, it must be chosen over social_card
  const resolved = resolveSocialImageFromMedia('product', [socialCard, photo], [orgShare])
  assert.equal(resolved?.url, 'https://img.example/property.jpg')
  assert.equal(resolved?.width, 1200)
  assert.equal(resolved?.height, 800)

  // 2. When only gallery photos exist, first gallery image is chosen over social_card and org share
  const galleryPhoto = { slot: 'gallery', kind: 'image' as const, public_url: 'https://img.example/gallery-1.jpg', mime_type: 'image/jpeg' }
  const fromGallery = resolveSocialImageFromMedia('product', [socialCard, galleryPhoto], [orgShare])
  assert.equal(fromGallery?.url, 'https://img.example/gallery-1.jpg')

  // 3. When no authentic photos exist, falls back to social_card
  const fromCard = resolveSocialImageFromMedia('product', [socialCard], [])
  assert.equal(fromCard?.url, 'https://img.example/card.png')
  assert.equal(fromCard?.type, 'image/png')
})

