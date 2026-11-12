import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOnboardingDraftPayload } from '../../server/utils/onboarding-drafts.ts'

const details = {
  name: 'Kikuzuki', street_address: '88 Moo 2', address_line_2: null, city: 'Ao Nang', region: null, postal_code: null,
  country: 'TH', phone: null, website_url: null, opening_hours: null, special_hours: null, timezone: 'Asia/Bangkok', currency: null, source_locale: null,
}
const place = {
  placeId: 'ChIJ-kikuzuki', name: 'Kikuzuki', address: null, phone: null, mapsUrl: 'https://maps.google.com/?cid=1',
  websiteUrl: null, rating: 4.8, ratingCount: 120, openingHours: null, timezone: 'Asia/Bangkok', reviews: [],
}
const preview = {
  brandName: 'Kikuzuki', vertical: 'restaurant', subdomainCandidate: 'kikuzuki', config: {}, media: [],
  locations: [], products: [], reviews: [], qa: [], content: [], locales: [{ code: 'ja', label: '日本語', is_source: true }],
}

test('a version 2 Google draft with migrated stored fields restores as version 3 with its place identity', () => {
  const payload = parseOnboardingDraftPayload(JSON.stringify({ version: 2, source: { type: 'google_places', place, details }, preview }))
  assert.equal(payload.version, 3)
  assert.equal(payload.source.placeId, 'ChIJ-kikuzuki')
  assert.equal(payload.source.place?.mapsUrl, 'https://maps.google.com/?cid=1')
  assert.equal(payload.source.details.source_locale, 'ja')
})

test('a version 2 manual draft restores as version 3 with no place', () => {
  const payload = parseOnboardingDraftPayload(JSON.stringify({ version: 2, source: { type: 'manual', place: null, details }, preview }))
  assert.equal(payload.version, 3)
  assert.equal(payload.source.placeId, null)
  assert.equal(payload.source.place, null)
  assert.equal(payload.source.details.source_locale, 'ja')
})

test('a version 3 draft whose source contradicts its type is refused', () => {
  assert.throws(() => parseOnboardingDraftPayload(JSON.stringify({ version: 3, source: { type: 'google_places', placeId: null, place: null, details }, preview })))
  assert.throws(() => parseOnboardingDraftPayload(JSON.stringify({ version: 3, source: { type: 'manual', placeId: 'ChIJ-kikuzuki', place: null, details }, preview })))
  assert.throws(() => parseOnboardingDraftPayload(JSON.stringify({ version: 1, source: { type: 'manual', place: null, details }, preview })))
})
