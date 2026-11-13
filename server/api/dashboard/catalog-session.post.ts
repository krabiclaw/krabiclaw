import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { z } from 'zod'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'

const handoff = z.object({
  token: z.string().min(1).max(256),
  destination: z.string().regex(/^\/dashboard\/[a-zA-Z0-9-]+\/products(?:\?kind=(?:menu|experience|service|stay|table))?$/),
})

export default defineHandler(async (event) => {
  // Require JSON so a browser form cannot sign its visitor into another account.
  // A programmatic WebKit navigation can carry the opaque Origin "null".
  const origin = event.req.headers.get('origin')
  const contentType = event.req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HTTPError({ statusCode: 415, message: 'Catalog sign-in requires JSON' })
  if ((origin !== null && origin !== 'null' && origin !== event.url.origin) || event.req.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HTTPError({ statusCode: 403, message: 'Catalog sign-in requires a same-origin request' })
  }

  const input = handoff.safeParse(await readBody(event))
  if (!input.success) throw new HTTPError({ statusCode: 400, message: 'Invalid Catalog destination or sign-in token' })

  const auth = createAuth(cloudflareEnv(event))
  const verification = await auth.api.verifyOneTimeToken({
    body: { token: input.data.token },
    asResponse: true,
  })
  if (!verification.ok) return verification
  const cookies = verification.headers.getSetCookie()
  if (!cookies.length) throw new HTTPError({ statusCode: 502, message: 'Better Auth did not issue a dashboard session' })

  // The existing dashboard route and editor APIs authorize every resource.
  const response = new Headers({ location: input.data.destination, 'cache-control': 'no-store' })
  for (const cookie of cookies) response.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers: response })
})
