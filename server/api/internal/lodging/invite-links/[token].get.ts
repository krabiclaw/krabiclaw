import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { inviteLinkTokenHash } from '~/server/utils/invite-links'
import { LODGING_INTERNAL_CALLER, validateInternalRequest } from '~/server/utils/internal-secret'

// What an invite link offers, for the lodging Worker's landing page that sends
// the person into the app. It answers for anyone holding the token, so it names
// the organization and role and nothing about its members; accepting needs a
// signed-in user. A withdrawn link no longer exists and answers 404.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const validation = await validateInternalRequest(event, env, LODGING_INTERNAL_CALLER)
  if (!validation.ok) return jsonResponse({ error: validation.error }, { status: validation.status })
  const token = getRouterParam(event, 'token')
  if (!token) return jsonResponse({ error: 'Invite link token is required' }, { status: 400 })

  const link = await queryFirst<{ organization_name: string; role: string; expires_at: string; used_at: string | null }>(env.DB, `
    SELECT o.name AS organization_name, l.role, l.expires_at, l.used_at
    FROM organization_invite_links l JOIN organization o ON o.id = l.organization_id
    WHERE l.token_hash = ?
  `, [await inviteLinkTokenHash(token)])
  if (!link) return jsonResponse({ error: 'This invite link does not exist' }, { status: 404 })
  const status = link.used_at ? 'used' : Date.parse(link.expires_at) <= Date.now() ? 'expired' : 'pending'
  return jsonResponse({ organizationName: link.organization_name, role: link.role, status, expiresAt: link.expires_at })
})
