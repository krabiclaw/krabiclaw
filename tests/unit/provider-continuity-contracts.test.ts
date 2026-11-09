import { createHmac } from 'node:crypto'
import { buildMemberReplyToAddress, buildReplyToAddress, parseReplyToAddress, verifyMemberReplyToken, verifyReplyToken } from '../../server/utils/submission-messages.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('compact reply contract preserves its signature and configured domain', async () => {
  const env = { EMAIL_REPLY_SECRET: 'reply-contract-test-key', NUXT_PUBLIC_PLATFORM_DOMAIN: 'example.com' }
  const id = '00000000-0000-4000-8000-000000000123'
  const token = createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`reservation:${id}`).digest('hex').slice(0, 24)
  const address = await buildReplyToAddress(env, 'reservation', id)
  assert.equal(address, `rr${id.replaceAll('-', '')}${token}@reply.example.com`)
  assert.ok(address)
  assert.deepEqual(parseReplyToAddress(env, address), { kind: 'guest', submissionType: 'reservation', submissionId: id, token })
  assert.equal(await verifyReplyToken(env, 'reservation', id, token), true)
  assert.equal(await verifyReplyToken(env, 'contact', id, token), false)
  assert.equal(await verifyReplyToken(env, 'reservation', `${id.slice(0, -1)}4`, token), false)
  assert.equal(parseReplyToAddress(env, address.replace('@reply.example.com', '@other.example.com')), null)
  assert.equal(parseReplyToAddress(env, `${address}@reply.example.com`), null)
})

// A member's alert carries a reply address that names the conversation, fits
// SMTP's 64-character local part, and verifies only for the member it was signed for.
test('a member reply address round-trips to its conversation and verifies only for its member', async () => {
  const env = { EMAIL_REPLY_SECRET: 'reply-contract-test-key', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.com' }
  const thread = '1f9d0aaa-226a-4e91-90b5-f4872451a438'
  const address = await buildMemberReplyToAddress(env, thread, 'user-owner')
  const token = createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`member:${thread}:user-owner`).digest('hex').slice(0, 24)
  assert.equal(address, `rm${thread}${token}@reply.krabiclaw.com`)
  assert.ok(address.split('@')[0]!.length <= 64)
  assert.deepEqual(parseReplyToAddress(env, address), { kind: 'member', threadId: thread, token })
  assert.equal(await verifyMemberReplyToken(env, thread, 'user-owner', token), true)
  assert.equal(await verifyMemberReplyToken(env, thread, 'user-other', token), false)
  assert.equal(await verifyMemberReplyToken({ ...env, EMAIL_REPLY_SECRET: 'another' }, thread, 'user-owner', token), false)
  // A guest's signature over the same conversation never answers as a member.
  assert.equal(await verifyReplyToken(env, 'contact', thread, token), false)
  await assert.rejects(buildMemberReplyToAddress({ NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.com' }, thread, 'user-owner'), /EMAIL_REPLY_SECRET/u)
})
