import { defineHandler } from 'nitro'
import { cloudflareEnv, textResponse } from '~/server/utils/api-response'

const legacyChallenge = "5deG0JLJcqqzqy3aWoacWeTmDmm_wiVQ-_7UI_cp4IQ\n"

const challengeHeaders = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'public, max-age=0, must-revalidate',
}

export default defineHandler((event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    return textResponse('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } })
  }
  const hostname = event.url.hostname
  if (hostname === 'krabiclaw.com' || hostname === 'staging.krabiclaw.com') {
    return new Response(legacyChallenge, { headers: challengeHeaders })
  }
  if (hostname === 'blawby.com') {
    const encoded = cloudflareEnv(event).OPENAI_APPS_CHALLENGE_BLAWBY_B64
    if (encoded) {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
      return new Response(bytes, { headers: challengeHeaders })
    }
  }
  return textResponse('Not found\n', { status: 404, headers: { 'cache-control': 'no-store' } })
})
