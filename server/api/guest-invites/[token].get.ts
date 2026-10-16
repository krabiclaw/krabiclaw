import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { describeGuestThreadInvite } from '~/server/domain/guest-threads/invites'

// GET /api/guest-invites/:token → { organization_name, location_title, expires_at }
// for the page that asks the guest to sign in. An unknown link is 404; a used,
// replaced or expired one is 410 with its code.
export default defineHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? ''
  const invite = await describeGuestThreadInvite(cloudflareEnv(event).DB, token)
  return jsonResponse(invite, { headers: { 'cache-control': 'private, no-store' } })
})
