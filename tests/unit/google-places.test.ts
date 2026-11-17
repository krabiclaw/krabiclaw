import assert from 'node:assert/strict'
import test from 'node:test'
import { autocompletePlaces, getPlaceDetails } from '../../server/utils/google-places.ts'

const SESSION = '3f1c2a4e-8b7d-4c1e-9a2b-5d6e7f8a9b0c'

async function capture(body: unknown, run: () => Promise<unknown>) {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    return { result: await run(), calls }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('autocomplete keeps well-formed predictions and drops malformed ones', async () => {
  const { result } = await capture({
    suggestions: [
      { placePrediction: { placeId: 'ChIJ-a', text: { text: 'Kikuzuki, Ao Nang, Thailand' }, structuredFormat: { mainText: { text: 'Kikuzuki' }, secondaryText: { text: 'Ao Nang, Thailand' } } } },
      { placePrediction: { placeId: 'ChIJ-b', text: { text: 'Thailand' }, structuredFormat: { mainText: { text: 'Thailand' } } } },
      { placePrediction: { text: { text: 'No id' }, structuredFormat: { mainText: { text: 'No id' } } } },
      { placePrediction: { placeId: 'ChIJ-c', text: { text: 'No main text' }, structuredFormat: {} } },
      { placePrediction: { placeId: 'ChIJ-d', structuredFormat: { mainText: { text: 'No full text' } } } },
      { queryPrediction: { text: { text: 'kikuzuki near me' } } },
    ],
  }, () => autocompletePlaces('key-1', 'Kikuzuki', SESSION))
  assert.deepEqual(result, [
    { google_place_id: 'ChIJ-a', name: 'Kikuzuki', address_label: 'Ao Nang, Thailand', full_text: 'Kikuzuki, Ao Nang, Thailand' },
    { google_place_id: 'ChIJ-b', name: 'Thailand', address_label: '', full_text: 'Thailand' },
  ])
  const empty = await capture({}, () => autocompletePlaces('key-1', 'zzzzzz', SESSION))
  assert.deepEqual(empty.result, [])
})

test('Place Details answers the phone in E.164, from the number that names its country', async () => {
  const listed = await capture({ id: 'ChIJ-a', internationalPhoneNumber: '+66 95 293 2112' }, () => getPlaceDetails('key-1', 'ChIJ-a'))
  assert.equal((listed.result as { phone: string | null }).phone, '+66952932112')
  const unlisted = await capture({ id: 'ChIJ-a' }, () => getPlaceDetails('key-1', 'ChIJ-a'))
  assert.equal((unlisted.result as { phone: string | null }).phone, null)
})
