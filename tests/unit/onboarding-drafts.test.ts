import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeOnboardingDraftInput, parseOnboardingDraftPayload } from '../../server/utils/onboarding-drafts.ts'

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

test('a different Google place seeds its own time zone while a saved place preserves edits', () => {
  const existing = parseOnboardingDraftPayload(JSON.stringify({
    version: 3,
    source: { type: 'google_places', placeId: place.placeId, place, details: { ...details, timezone: 'Asia/Tokyo' } },
    preview,
  }))
  const row = { vertical: 'restaurant', subdomain_candidate: 'kikuzuki', organization_id: null } as const
  assert.equal(normalizeOnboardingDraftInput({}, row, existing, 'google_places', place.placeId, place).payload.source.details.timezone, 'Asia/Tokyo')
  const replacement = { ...place, placeId: 'ChIJ-replacement', timezone: 'Europe/London' }
  assert.equal(normalizeOnboardingDraftInput({}, row, existing, 'google_places', replacement.placeId, replacement).payload.source.details.timezone, 'Europe/London')
  const edited = normalizeOnboardingDraftInput({ details: { timezone: 'Europe/Paris' } }, row, existing, 'google_places', replacement.placeId, replacement)
  assert.equal(edited.payload.source.details.timezone, 'Europe/Paris')
})

test('a partial update retains an omitted website address and distinguishes clearing it', () => {
  const start = normalizeOnboardingDraftInput({ partial: true, vertical: 'restaurant', name: 'Kikuzuki', subdomain: 'our-custom-address' }, null, null, 'manual', null, null)
  const row = { vertical: start.vertical, subdomain_candidate: start.subdomain, organization_id: null }
  const paused = normalizeOnboardingDraftInput({ partial: true, paused_step: 'location' }, row, start.payload, 'manual', null, null)
  assert.equal(paused.subdomain, 'our-custom-address')
  const cleared = normalizeOnboardingDraftInput({ partial: true, subdomain: '' }, row, start.payload, 'manual', null, null)
  assert.equal(cleared.subdomain, '')
  const complete = normalizeOnboardingDraftInput({ details: { source_locale: 'en' } }, row, paused.payload, 'manual', null, null)
  assert.equal(complete.subdomain, 'our-custom-address')
})

test('completing a partial Google draft retains an edited name for the same place', () => {
  const start = normalizeOnboardingDraftInput({ partial: true, vertical: 'restaurant', name: 'Our Local Name' }, null, null, 'google_places', place.placeId, null)
  const row = { vertical: start.vertical, subdomain_candidate: start.subdomain, organization_id: null }
  const finish = { details: { source_locale: 'en' } }
  const complete = normalizeOnboardingDraftInput(finish, row, start.payload, 'google_places', place.placeId, place)
  assert.equal(complete.name, 'Our Local Name')
  assert.equal(complete.subdomain, 'our-local-name')
  const replacement = { ...place, placeId: 'ChIJ-replacement', name: 'New Place' }
  assert.equal(normalizeOnboardingDraftInput(finish, row, start.payload, 'google_places', replacement.placeId, replacement).name, 'New Place')
})
