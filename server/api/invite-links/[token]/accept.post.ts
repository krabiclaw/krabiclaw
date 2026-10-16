import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { acceptInviteLink } from '~/server/utils/invite-links'

// POST /api/invite-links/:token/accept → { organization: { id, name }, role, memberId }
// The signed-in caller joins the link's organization with the link's role.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, message: 'Sign in to accept this invite', data: { code: 'AUTHENTICATION_REQUIRED', field: 'session' } })
  return jsonResponse(await acceptInviteLink(env, getRouterParam(event, 'token') ?? '', session.user.id), { headers: { 'cache-control': 'private, no-store' } })
})
