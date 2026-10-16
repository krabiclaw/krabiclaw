import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { ensureInteractionUser, getAuthSession } from '~/server/utils/auth'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { claimGuestThreadInvite, describeGuestThreadInvite } from '~/server/domain/guest-threads/invites'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'

// POST /api/guest-invites/:token/claim → { thread_id, path }. The browser's
// account takes the conversation. With no session the guest continues without
// an account, as an anonymous identity a later sign-in links; that identity is
// minted only for a link that can still be claimed. The host's open inboxes
// are told the conversation now reaches its guest.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  requireFinancialBrowserOrigin(event)
  const token = getRouterParam(event, 'token') ?? ''
  const session = await getAuthSession(event, env)
  if (!session) await describeGuestThreadInvite(env.DB, token)
  const claimed = await claimGuestThreadInvite(env.DB, { token, userId: session?.user.id ?? await ensureInteractionUser(event, env) })
  await publishGuestInboxThreadEvent(env, env.DB, { threadId: claimed.thread_id, type: 'thread.changed' })
  return jsonResponse(claimed, { headers: { 'cache-control': 'private, no-store' } })
})
