import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const baseUrl = (env.BETTER_AUTH_URL ?? 'https://krabiclaw.com').replace(/\/$/, '')

  setResponseHeaders(event, {
    'content-type': 'application/json', 'access-control-allow-origin': '*', })

  const { getProtectedResourceMetadata } = oauthProviderResourceClient(createAuth(env)).getActions()
  // 'openid' is deliberately excluded — Better Auth's resource-server helper
  // rejects it in scopes_supported (it's an authorization-server/OIDC scope, // not something a resource server advertises per RFC 9728).
  return await getProtectedResourceMetadata({
    resource: `${baseUrl}/api/mcp`, bearer_methods_supported: ['header'], scopes_supported: ['offline_access', 'tenant'], })
})
import { defineHandler } from 'nitro';
import {  setResponseHeaders  } from 'nitro/h3';
