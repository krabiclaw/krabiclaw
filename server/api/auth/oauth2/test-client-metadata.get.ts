
import { assertE2eFixtureEnabled } from '~/server/utils/dev-route-auth'
import { getRequestHost, getRequestProtocol } from 'nitro/h3'

export default defineHandler((event) => {
  assertE2eFixtureEnabled(event)

  const requestUrl = new URL(event.url)
  requestUrl.host = getRequestHost(event)
  requestUrl.protocol = `${getRequestProtocol(event)}:`
  const origin = requestUrl.origin

  return {
    client_id: requestUrl.toString(), client_name: 'KrabiClaw MCP auth regression client', redirect_uris: [`${origin}/oauth/test-callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'openid offline_access tenant', }
})
import { defineHandler } from 'nitro';
