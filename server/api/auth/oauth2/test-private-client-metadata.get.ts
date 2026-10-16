
import { assertE2eFixtureEnabled } from '~/server/utils/dev-route-auth'
import { getRequestHost, getRequestProtocol } from 'nitro/h3'

export default defineHandler((event) => {
  assertE2eFixtureEnabled(event)

  const requestUrl = new URL(event.url)
  requestUrl.host = getRequestHost(event)
  requestUrl.protocol = `${getRequestProtocol(event)}:`
  const origin = requestUrl.origin

  return {
    client_id: requestUrl.toString(),
    client_name: 'KrabiClaw private-key CIMD regression client',
    redirect_uris: [`${origin}/oauth/test-callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'private_key_jwt',
    jwks_uri: `${origin}/api/auth/oauth2/test-private-client-jwks`,
  }
})
import { defineHandler } from 'nitro';
