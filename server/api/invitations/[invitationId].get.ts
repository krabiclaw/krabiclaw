import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { describeEmailInvitation } from '~/server/utils/email-invitations'

// GET /api/invitations/:invitationId → { email, organization: { name }, role, expiresAt }
// for the accept-invitation page and the app, before anyone signs in. An
// unknown invitation is 404; an answered, withdrawn or expired one is 410.
export default defineHandler(async (event) => {
  const invitation = await describeEmailInvitation(cloudflareEnv(event).DB, getRouterParam(event, 'invitationId') ?? '')
  return jsonResponse(invitation, { headers: { 'cache-control': 'private, no-store' } })
})
