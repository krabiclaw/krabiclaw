import { defineHandler, HTTPError } from 'nitro'
import { getQuery, readBody } from 'nitro/h3'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { MEMBER_BUSY_SCOPES } from '~/shared/member-scheduling'
import { INTEGRATIONS } from '~/shared/integrations'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createAuth, NATIVE_CONNECTION_RETURN_ORIGIN } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'

const request = z.object({ integration: z.enum([
  'facebook', 'instagram', 'discord', 'google-calendar', 'google-analytics',
  'google-search-console', 'google-ads', 'meta-ads', 'personal-calendar',
]), attempt: z.uuid() })

const privateHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

export default defineHandler(async event => {
  if (event.req.method !== 'GET' && event.req.method !== 'POST') throw new HTTPError({ statusCode: 405, message: 'Method not allowed' })
  const input = request.safeParse(event.req.method === 'POST' ? await readBody(event) : getQuery(event))
  if (!input.success) throw new HTTPError({ statusCode: 400, message: 'Choose a connection', data: { code: 'INVALID_CONNECTION' } })
  const { integration, attempt } = input.data
  const env = cloudflareEnv(event)
  const auth = createAuth(env)
  const personally = integration === 'personal-calendar'
  const signature = async (ticket: string) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(['connection-authorization', integration, attempt, ticket])))
    return Buffer.from(bytes).toString('base64url')
  }
  const callback = new URL(`${NATIVE_CONNECTION_RETURN_ORIGIN}/${integration}`)
  callback.searchParams.set('attempt', attempt)
  if (event.req.method === 'POST') {
    const { db, organization } = await getDashboardMemberContext(event)
    if (!personally) await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
    const entitlement = personally ? 'calendar_sync' : INTEGRATIONS.find(item => item.key === integration)?.entitlement
    if (entitlement && !await hasOrganizationEntitlement(env, organization.id, entitlement)) {
      throw new HTTPError({ statusCode: 403, message: 'Your plan does not include this connection.', data: { code: 'ENTITLEMENT_REQUIRED' } })
    }
    const { token } = await auth.api.generateOneTimeToken({ headers: event.req.headers })
    const url = new URL(event.url)
    url.search = new URLSearchParams({ integration, attempt, ticket: token, proof: await signature(token) }).toString()
    return jsonResponse({ authorization_url: url.href }, { headers: privateHeaders })
  }

  const query = getQuery(event)
  try {
    if (typeof query.ticket !== 'string' || typeof query.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(query.proof)) {
      throw new HTTPError({ statusCode: 400, message: 'This authorization link is incomplete.' })
    }
    if (!timingSafeEqual(Buffer.from(query.proof), Buffer.from(await signature(query.ticket)))) {
      throw new HTTPError({ statusCode: 400, message: 'This authorization link is invalid.' })
    }
    const session = await auth.api.verifyOneTimeToken({ body: { token: query.ticket } })
    const headers = new Headers({ authorization: `Bearer ${session.session.token}` })
    const provider = integration.startsWith('google-') || personally ? 'google' : integration === 'meta-ads' ? 'facebook' : integration
    const scopes = personally ? [...MEMBER_BUSY_SCOPES] : integration === 'instagram' ? [] : [...INTEGRATION_SCOPES[integration]]
    const response = await auth.api.linkSocialAccount({
      headers, asResponse: true,
      body: {
        provider, scopes, callbackURL: callback.href, errorCallbackURL: callback.href,
        ...(provider === 'google' ? { additionalParams: { access_type: 'offline', prompt: 'consent select_account' } } : {}),
      },
    })
    if (!response.ok) {
      const failure = await response.json() as { message?: string }
      throw new HTTPError({ statusCode: response.status, message: failure.message ?? 'Could not start provider authorization.' })
    }
    const location = response.headers.get('location')
    if (!location) throw new HTTPError({ statusCode: 502, message: 'The authorization provider returned no destination.' })
    const responseHeaders = new Headers(privateHeaders)
    responseHeaders.set('Location', location)
    for (const cookie of response.headers.getSetCookie()) responseHeaders.append('Set-Cookie', cookie)
    return new Response(null, { status: 302, headers: responseHeaders })
  } catch (error) {
    callback.searchParams.set('error', error instanceof Error && error.message ? error.message : 'Could not start provider authorization.')
    return new Response(null, { status: 302, headers: { ...privateHeaders, Location: callback.href } })
  }
})
