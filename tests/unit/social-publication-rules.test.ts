import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { formatViolation } from '../../server/utils/social-publication.ts'
import { verifyMetaSignedRequest } from '../../server/utils/meta-graph.ts'

const image = (id: string, mime = 'image/jpeg', size = 1000, jpegUrl: string | null = mime === 'image/jpeg' ? `https://images.example.test/${id}` : null) => ({ asset_id: id, mime_type: mime, file_size: size, duration: null, kind: 'image' as const, public_url: `https://images.example.test/${id}`, alt_text: null, jpeg_url: jpegUrl })
const video = (id: string, duration: number | null) => ({ asset_id: id, mime_type: 'video/mp4', file_size: 1000, duration, kind: 'video' as const, public_url: `https://media.example.test/${id}.mp4`, alt_text: null, jpeg_url: null })

test('each channel refuses the first format rule a post breaks, with the limit it breaks', () => {
  assert.equal(formatViolation('facebook', 'Just words', []), null)
  assert.equal(formatViolation('facebook', '', [image('a'), image('b')]), null)
  assert.equal(formatViolation('facebook', '', [video('v', 30)]), null)
  assert.equal(formatViolation('facebook', '', [image('a'), video('v', 30)])?.code, 'unsupported_combination')
  assert.match(formatViolation('facebook', '', [image('w', 'image/webp')])!.message, /asset w is image\/webp/)
  assert.equal(formatViolation('instagram', 'caption only', [])?.code, 'media_required')
  assert.equal(formatViolation('instagram', '', [image('a')]), null)
  assert.equal(formatViolation('instagram', '', [image('a'), video('v', 20)]), null)
  assert.match(formatViolation('instagram', '', [image('p', 'image/png')])!.message, /JPEG images only; asset p is image\/png and has no JPEG rendition/)
  // A PNG that Cloudflare Images renders as JPEG is sent as that rendition.
  assert.equal(formatViolation('instagram', '', [image('r', 'image/png', 1000, 'https://imagedelivery.net/h/r/format=jpeg')]), null)
  assert.match(formatViolation('instagram', '', Array.from({ length: 11 }, (_, index) => image(`i${index}`)))!.message, /at most 10 items; this post has 11/)
  assert.match(formatViolation('instagram', '', [image('a'), video('v', 90)])!.message, /carousel videos run 3–60 seconds; asset v is 90 seconds/)
  assert.equal(formatViolation('instagram', '', [video('reel', 90)]), null)
  assert.equal(formatViolation('instagram', 'x'.repeat(2201), [image('a')])?.code, 'caption_too_long')
  assert.equal(formatViolation('instagram', Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(' '), [image('a')])?.code, 'too_many_hashtags')
  assert.equal(formatViolation('facebook', '', [{ ...image('l'), public_url: 'http://localhost:3000/l.jpg' }])?.code, 'media_not_public')
})

const encode = (value: Buffer | string) => Buffer.from(value).toString('base64url')
function signedRequest(secret: string, payload: Record<string, unknown>) {
  const body = encode(JSON.stringify({ algorithm: 'HMAC-SHA256', ...payload }))
  return `${encode(createHmac('sha256', secret).update(body).digest())}.${body}`
}

test('a Meta callback names the app whose secret verified it, and a signature two apps verify names no one', async () => {
  const apps = [
    { channel: 'facebook' as const, appId: 'fb-app', appSecret: 'facebook-secret' },
    { channel: 'instagram' as const, appId: 'ig-app', appSecret: 'instagram-secret' },
  ]
  assert.deepEqual(await verifyMetaSignedRequest(signedRequest('instagram-secret', { user_id: '42', issued_at: 1 }), apps),
    { channel: 'instagram', providerAppId: 'ig-app', providerSubjectId: '42', issuedAt: 1 })
  assert.equal((await verifyMetaSignedRequest(signedRequest('facebook-secret', { user_id: '42' }), apps))?.channel, 'facebook')
  assert.equal(await verifyMetaSignedRequest(signedRequest('someone-else', { user_id: '42' }), apps), null)
  assert.equal(await verifyMetaSignedRequest(signedRequest('shared', { user_id: '42' }), [{ ...apps[0]!, appSecret: 'shared' }, { ...apps[1]!, appSecret: 'shared' }]), null)
  assert.equal(await verifyMetaSignedRequest(signedRequest('facebook-secret', { user_id: '42', algorithm: 'NONE' }), apps), null)
})
