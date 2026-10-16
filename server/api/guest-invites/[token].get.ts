import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { describeGuestThreadInvite } from '~/server/domain/guest-threads/invites'

// GET /api/guest-invites/:token → { organization_name, location_title, expires_at }
// for the page that asks the guest to sign in. An unknown link is 404; a used,
// replaced or expired one is 410 with its code.
export default defineHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? ''
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  const invite = await describeGuestThreadInvite(env.DB, token, session?.user.id)
  return jsonResponse(invite, { headers: { 'cache-control': 'private, no-store' } })
})
