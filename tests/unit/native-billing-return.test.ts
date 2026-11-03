import test from 'node:test'
import assert from 'node:assert/strict'
import { NATIVE_BILLING_RETURN_ORIGIN } from '../../server/utils/auth.ts'

test('native billing return origin uses the krabiclaw custom scheme', () => {
  assert.equal(NATIVE_BILLING_RETURN_ORIGIN, 'krabiclaw://billing')
})
