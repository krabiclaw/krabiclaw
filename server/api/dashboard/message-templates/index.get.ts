import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { listMessageTemplates } from '~/server/domain/guest-messaging'
import { parseMessageListQuery } from '~/server/domain/guest-message-schedule'

export default defineHandler(async (event) => {
  const query = parseMessageListQuery(getQuery(event))
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return jsonResponse(await listMessageTemplates(db, access, query))
})
