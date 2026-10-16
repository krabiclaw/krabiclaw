import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { describeInviteLink } from '~/server/utils/invite-links'

// GET /api/invite-links/:token → { organization: { name }, role, expiresAt }
// for the public invite page. It answers anyone holding the token. An unknown
// or withdrawn link is 404; a used or expired one is 410 with its code.
export default defineHandler(async (event) => {
  const invite = await describeInviteLink(cloudflareEnv(event).DB, getRouterParam(event, 'token') ?? '')
  return jsonResponse(invite, { headers: { 'cache-control': 'private, no-store' } })
})
