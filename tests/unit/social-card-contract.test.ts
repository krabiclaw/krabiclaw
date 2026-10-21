import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSocialCardGenerationKey } from '../../server/utils/social-card.ts'
import { resolveOwnerPicture } from '../../shared/media-placement-contract.ts'

const placed = (slot: string, asset_id: string, kind: 'image' | 'video' = 'image', thumbnail_url: string | null = null) => ({
  slot,
  asset_id,
  kind,
  public_url: kind === 'video' ? `https://media.example/${asset_id}.mp4` : `https://img.example/${asset_id}.png`,
  thumbnail_url,
})

test('an owner\'s picture is the first image in its own slot, and never its gallery', () => {
  const share = [placed('logo', 'org-logo'), placed('social_share', 'org-share')]
  assert.equal(resolveOwnerPicture('business_location', [placed('social_card', 'owner-card'), placed('hero', 'owner-hero')], share)?.asset_id, 'owner-hero')
  assert.equal(resolveOwnerPicture('product', [placed('image', 'product-image'), placed('gallery', 'product-gallery')], share)?.asset_id, 'product-image')
  assert.equal(resolveOwnerPicture('content_document', [placed('cover', 'post-cover')], share)?.asset_id, 'post-cover')
  assert.equal(resolveOwnerPicture('review', [placed('portrait', 'review-portrait')], share)?.asset_id, 'review-portrait')
  // An article's picture is its leading block's own.
  assert.equal(resolveOwnerPicture('content_block', [placed('media', 'block-cover')], share)?.asset_id, 'block-cover')
  // A gallery is not the owner's picture: with nothing in its own slot, the owner gets the share image.
  assert.equal(resolveOwnerPicture('business_location', [placed('gallery', 'gallery-1')], share)?.asset_id, 'org-share')
  assert.equal(resolveOwnerPicture('business_location', [placed('gallery', 'gallery-1')], [placed('logo', 'org-logo')]), null)
})

test('a video stands in by its poster only when its slot holds no image and the organization chose no share image', () => {
  const video = placed('hero', 'hero-video', 'video', 'https://img.example/poster.png')
  const still = placed('hero', 'hero-still')
  // Kikuzuki's shape: a video first, then a photograph. The photograph is the picture.
  assert.equal(resolveOwnerPicture('business_location', [video, still], [])?.asset_id, 'hero-still')
  assert.equal(resolveOwnerPicture('business_location', [video], [])?.thumbnail_url, 'https://img.example/poster.png')
  assert.equal(resolveOwnerPicture('business_location', [video], [placed('social_share', 'org-share')])?.asset_id, 'org-share')
  // A video with no poster has no still, so it is no picture at all.
  assert.equal(resolveOwnerPicture('business_location', [{ ...video, thumbnail_url: null }], []), null)
})

test('the organization\'s picture is its share image, never its logo or a page\'s picture', () => {
  const organizationMedia = [placed('logo', 'org-logo'), placed('social_share', 'org-share')]
  assert.equal(resolveOwnerPicture('organization', organizationMedia, organizationMedia)?.asset_id, 'org-share')
  assert.equal(resolveOwnerPicture('organization', [placed('logo', 'org-logo')], [placed('logo', 'org-logo')]), null)
  // A share image that is a video with no poster cannot stand in either.
  const posterless = [placed('social_share', 'org-share', 'video', null)]
  assert.equal(resolveOwnerPicture('content_document', [], posterless), null)
  for (const ownerType of ['content_document', 'review', 'business_location', 'product'] as const) {
    assert.equal(resolveOwnerPicture(ownerType, [], organizationMedia)?.asset_id, 'org-share', `${ownerType} falls back to the share image`)
  }
})

test('social card generation keys change when a byte-producing source changes', () => {
  const base = {
    logoAssetId: 'logo-1',
    payload: { template: 'tenant' as const, title: 'Site', organizationName: 'Site', backgroundImageUrl: 'https://img.example/background.png' },
  }
  assert.notEqual(
    buildSocialCardGenerationKey({ ...base, sourceAssetId: 'source-1' }),
    buildSocialCardGenerationKey({ ...base, sourceAssetId: 'source-2' }),
  )
  assert.notEqual(
    buildSocialCardGenerationKey({ ...base, sourceAssetId: 'source-1', sourceUpdatedAt: '2026-09-06T00:00:00Z' }),
    buildSocialCardGenerationKey({ ...base, sourceAssetId: 'source-1', sourceUpdatedAt: '2026-09-06T01:00:00Z' }),
  )
})
