import assert from 'node:assert/strict'
import test from 'node:test'

import localeQueryMiddleware from '../../server/middleware/locale-query.ts'

function event(url: string) {
  return { req: new Request(url) } as never
}

test('locale query selection is limited to public data APIs', () => {
  assert.throws(
    () => localeQueryMiddleware(event('https://tenant.example/menu?locale=th')),
    /locale-prefixed path/i,
  )
  assert.equal(
    localeQueryMiddleware(event('https://tenant.example/api/public/page?locale=th')),
    undefined,
  )
  assert.equal(
    localeQueryMiddleware(event('https://krabiclaw.example/dashboard/kikuzuki/website/brand?editMode=translations&locale=th')),
    undefined,
  )
  assert.throws(
    () => localeQueryMiddleware(event('https://tenant.example/dashboards?locale=th')),
    /locale-prefixed path/i,
  )
})
