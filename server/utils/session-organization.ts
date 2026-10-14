import type { H3Event } from 'nitro/h3'
import { appendResponseHeader } from 'nitro/h3'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'

// Makes `organizationId` the caller's active organization through Better Auth's
// organization plugin (POST /organization/set-active), forwarding the refreshed
// session cookies onto the current response. Used after a site is created so the
// post-login resolver lands on the organization just acted in.
export async function activateSessionOrganization(event: H3Event, env: CloudflareEnv, organizationId: string): Promise<void> {
  const response = await createAuth(env).api.setActiveOrganization({
    body: { organizationId },
    headers: event.req.headers,
    asResponse: true,
  })
  if (!response.ok) {
    throw new Error(`Failed to activate organization ${organizationId} (${response.status})`)
  }
  for (const cookieValue of response.headers.getSetCookie()) {
    appendResponseHeader(event, 'set-cookie', cookieValue)
  }
}
