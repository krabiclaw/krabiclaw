import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { markTeamThreadRead, teamAccessFor } from '~/server/domain/team-messages'
import { publishDashboardInvalidation } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'read')
  const threadId = getRouterParam(event, 'threadId') ?? ''
  const read = await markTeamThreadRead(db, access, threadId)
  // A read moves the reader's unread counts in their other tabs and devices.
  await publishDashboardInvalidation(env, { eventId: crypto.randomUUID(), type: 'team_thread.changed', organizationId: organization.id, teamThreadId: threadId, occurredAt: read.lastReadAt })
  return jsonResponse(read)
})
