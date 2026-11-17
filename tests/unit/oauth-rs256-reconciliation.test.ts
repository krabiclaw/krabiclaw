import assert from 'node:assert/strict'
import test from 'node:test'
import { localDevelopmentOrigin, shouldBypassE2eAuthRateLimit } from '../../server/utils/auth.ts'

test('accepts loopback HTTP origins on arbitrary development ports', () => {
  assert.equal(localDevelopmentOrigin('http://127.0.0.1:3001'), 'http://127.0.0.1:3001')
  assert.equal(localDevelopmentOrigin('http://localhost:4173/'), 'http://localhost:4173')
  assert.equal(localDevelopmentOrigin('http://[::1]:3001'), 'http://[::1]:3001')
  assert.equal(localDevelopmentOrigin('https://127.0.0.1:3001'), null)
  assert.equal(localDevelopmentOrigin('http://example.com:3001'), null)
  assert.equal(localDevelopmentOrigin('not a URL'), null)
})

test('E2E auth rate-limit bypass requires the enabled environment and matching secret', () => {
  const request2 = (secret?: string) => new Request('https://staging.krabiclaw.com/api/auth/sign-in/email', {
    headers: secret ? { 'x-dev-route-secret': secret } : {},
  })

  assert.equal(shouldBypassE2eAuthRateLimit({}, request2('expected')), false)
  assert.equal(shouldBypassE2eAuthRateLimit({ E2E_ALLOW_DEV_ROUTES: 'true' }, request2('expected')), false)
  assert.equal(shouldBypassE2eAuthRateLimit({
    E2E_ALLOW_DEV_ROUTES: 'true',
    E2E_DEV_ROUTE_SECRET: 'expected',
  }, request2()), false)
  assert.equal(shouldBypassE2eAuthRateLimit({
    E2E_ALLOW_DEV_ROUTES: 'true',
    E2E_DEV_ROUTE_SECRET: 'expected',
  }, request2('wrong')), false)
  assert.equal(shouldBypassE2eAuthRateLimit({
    E2E_ALLOW_DEV_ROUTES: 'true',
    E2E_DEV_ROUTE_SECRET: 'expected',
  }, request2('expected')), true)
})
