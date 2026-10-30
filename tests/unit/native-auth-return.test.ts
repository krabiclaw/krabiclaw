import test from 'node:test'
import assert from 'node:assert/strict'
import { NATIVE_AUTH_RETURN_ORIGIN, NATIVE_BILLING_RETURN_ORIGIN } from '../../server/utils/auth.ts'

test('native auth return origin is defined and uses the krabiclaw custom scheme', () => {
  assert.equal(NATIVE_AUTH_RETURN_ORIGIN, 'krabiclaw://auth-callback')
  assert.equal(NATIVE_BILLING_RETURN_ORIGIN, 'krabiclaw://billing')
})

test('native auth callback query parsing handles tokens and errors correctly', () => {
  const tokenUrl = new URL('krabiclaw://auth-callback?token=test-session-token-123')
  assert.equal(tokenUrl.searchParams.get('token'), 'test-session-token-123')
  assert.equal(tokenUrl.searchParams.get('error'), null)

  const errorUrl = new URL('krabiclaw://auth-callback?error=access_denied')
  assert.equal(errorUrl.searchParams.get('error'), 'access_denied')
  assert.equal(errorUrl.searchParams.get('token'), null)
})
