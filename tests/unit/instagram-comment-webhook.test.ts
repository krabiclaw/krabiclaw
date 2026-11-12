import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  COMMENT_TRIGGER_REGEX,
  verifyInstagramWebhookSignature,
} from '../../server/api/integrations/meta/instagram-comments.post.ts'

test('Instagram comment trigger regex matches keywords with boundaries', () => {
  assert.equal(COMMENT_TRIGGER_REGEX.test('YES'), true)
  assert.equal(COMMENT_TRIGGER_REGEX.test('yes please!'), true)
  assert.equal(COMMENT_TRIGGER_REGEX.test('Can I book a table?'), true)
  assert.equal(COMMENT_TRIGGER_REGEX.test('send me the LINK'), true)
  assert.equal(COMMENT_TRIGGER_REGEX.test('where is the menu'), true)

  // Unrelated words should not trigger
  assert.equal(COMMENT_TRIGGER_REGEX.test('eyes are beautiful'), false) // 'eyes' contains 'yes' but not as word
  assert.equal(COMMENT_TRIGGER_REGEX.test('blink twice'), false) // 'blink' contains 'link'
  assert.equal(COMMENT_TRIGGER_REGEX.test('this looks great!'), false)
})

test('verifyInstagramWebhookSignature verifies valid signature and rejects invalid/tampered payloads', async () => {
  const secret = 'test-app-secret-123'
  const payload = JSON.stringify({ object: 'instagram', entry: [{ id: '123' }] })

  const validHmac = createHmac('sha256', secret).update(payload).digest('hex')
  const validHeader = `sha256=${validHmac}`

  const isValid = await verifyInstagramWebhookSignature(payload, validHeader, secret)
  assert.equal(isValid, true)

  // Tampered payload
  const isTamperedValid = await verifyInstagramWebhookSignature(payload + 'x', validHeader, secret)
  assert.equal(isTamperedValid, false)

  // Wrong secret
  const isWrongSecretValid = await verifyInstagramWebhookSignature(payload, validHeader, 'wrong-secret')
  assert.equal(isWrongSecretValid, false)

  // Missing or malformed header
  assert.equal(await verifyInstagramWebhookSignature(payload, null, secret), false)
  assert.equal(await verifyInstagramWebhookSignature(payload, 'invalid-signature-format', secret), false)
})
