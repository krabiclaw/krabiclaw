import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildReplyToAddress, InboundEmailRejection, parseReplyToAddress, verifyReplyToken } from '../../server/utils/reply-address.ts'

const env = { EMAIL_REPLY_SECRET: 'reply-contract-test-key', NUXT_PUBLIC_PLATFORM_DOMAIN: 'example.com' }
const entry = '1f9d0aaa-226a-4e91-90b5-f4872451a438'
const sign = (fact: string) => createHmac('sha256', env.EMAIL_REPLY_SECRET).update(fact).digest('hex').slice(0, 24)

// A reply address names the conversation entry an email was about, fits SMTP's
// 64-character local part, and verifies only for the guest or member it was signed for.
test('a guest reply address round-trips to its entry and verifies only as the guest', async () => {
  const address = await buildReplyToAddress(env, entry, { kind: 'guest' })
  const token = sign(`guest:${entry}`)
  assert.equal(address, `rg${entry.replaceAll('-', '')}${token}@reply.example.com`)
  assert.deepEqual(parseReplyToAddress(env, address), { kind: 'guest', entryId: entry, token })
  assert.equal(await verifyReplyToken(env, entry, { kind: 'guest' }, token), true)
  assert.equal(await verifyReplyToken(env, entry, { kind: 'member', userId: 'owner' }, token), false)
  assert.throws(() => parseReplyToAddress(env, address.replace('@reply.example.com', '@other.example.com')), InboundEmailRejection)
  assert.throws(() => parseReplyToAddress(env, `${address}@reply.example.com`), InboundEmailRejection)
  // The retired request-addressed format is no longer accepted.
  assert.throws(() => parseReplyToAddress(env, `rr${entry.replaceAll('-', '')}${token}@reply.example.com`), InboundEmailRejection)
  await assert.rejects(verifyReplyToken({ NUXT_PUBLIC_PLATFORM_DOMAIN: 'example.com' }, entry, { kind: 'guest' }, token), /EMAIL_REPLY_SECRET/u)
})

test('a member reply address verifies only for its member', async () => {
  const address = await buildReplyToAddress(env, entry, { kind: 'member', userId: 'user-owner' })
  const token = sign(`member:${entry}:user-owner`)
  assert.ok(address.split('@')[0]!.length <= 64)
  assert.deepEqual(parseReplyToAddress(env, address), { kind: 'member', entryId: entry, token })
  assert.equal(await verifyReplyToken(env, entry, { kind: 'member', userId: 'user-owner' }, token), true)
  assert.equal(await verifyReplyToken(env, entry, { kind: 'member', userId: 'user-other' }, token), false)
  // A conversation id that is a 64-character hash is never put in an address.
  await assert.rejects(buildReplyToAddress(env, '9ec2a9868678b21e32fd613e3634b02224465258eb881ec4435650b34fcf9618', { kind: 'guest' }), /not a UUID/u)
})
