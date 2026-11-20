import { cloudflareEnv } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const auth = createAuth(env)

  // Call the oauthProvider-registered endpoint directly — no HTTP subrequest.
  // HTTP self-calls (fetch(${baseUrl}/api/auth/...)) time out in Cloudflare Workers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadata = await (auth.api as any).getOpenIdConfig({
    request: new Request(new URL('/.well-known/openid-configuration', auth.options.baseURL)), asResponse: false, })

  setResponseHeaders(event, {
    'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600', })
  return metadata
})
import { defineHandler } from 'nitro';
import {  setResponseHeaders  } from 'nitro/h3';
