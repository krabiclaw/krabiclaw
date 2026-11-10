import assert from 'node:assert/strict'
import test from 'node:test'
import { oauthErrorMessage } from '../../utils/errors.ts'

test('oauthErrorMessage handles invalid_client with actionable guidance for AI assistants', () => {
  const message = oauthErrorMessage('invalid_client', 'client not found')
  assert.match(message, /unrecognized or outdated/)
  assert.match(message, /ChatGPT or Claude/)
  assert.match(message, /https:\/\/krabiclaw\.com\/api\/mcp/)
  assert.match(message, /\(invalid_client\) client not found/)
})

test('oauthErrorMessage preserves existing error codes and descriptions', () => {
  assert.match(oauthErrorMessage('state_mismatch'), /expired or could not be verified/)
  assert.match(oauthErrorMessage('access_denied'), /cancelled or denied/)
  assert.match(oauthErrorMessage('unknown_error_code', 'detail'), /The provider connection failed\. Start again\. \(unknown_error_code\) detail/)
  assert.equal(oauthErrorMessage(null), '')
})
