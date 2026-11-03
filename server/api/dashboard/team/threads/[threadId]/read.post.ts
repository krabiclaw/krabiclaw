import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { markTeamThreadRead, teamAccessFor } from '~/server/domain/team-messages'
import { publishNotificationInvalidation } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async (event) => {
  const { env, db, organization, userId } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'read')
  const read = await markTeamThreadRead(db, access, getRouterParam(event, 'threadId') ?? '')
  // The reader's other tabs and devices re-read their counts. notification.read is the reader-only
  // event every client already answers that way; team_thread.changed would reload the conversation.
  await publishNotificationInvalidation(env, { type: 'notification.read', organizationId: organization.id, locationId: null, targetUserId: userId })
  return jsonResponse(read)
})
