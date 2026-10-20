import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertAssignedBookingAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { createGuestThreadInvite } from '~/server/domain/guest-threads/invites'

// POST /api/dashboard/organizations/:organizationId/guest-threads/:threadId/invite
// → 201 { url, expires_at }. A single-use link, valid fourteen days, that the
// host shares from their own phone; whoever opens it and signs in gets this
// conversation in their account inbox. KrabiClaw sends nothing. A new link
// revokes the previous unused one. Who may reply to the conversation may invite.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const threadId = getRouterParam(event, 'threadId')
  if (!organizationId || !threadId) return jsonResponse({ error: 'Missing params', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })

  const { env, db, session, organization } = await requireOrganizationMembership(event, organizationId)
  await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), requestId: threadId })
  const invite = await createGuestThreadInvite(db, env, { organizationId, threadId, actorUserId: session.user.id })
  return jsonResponse(invite, { status: 201, headers: { 'cache-control': 'private, no-store' } })
})
