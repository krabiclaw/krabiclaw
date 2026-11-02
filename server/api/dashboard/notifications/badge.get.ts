import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { unreadBadge } from '~/server/domain/unread'

/** The app icon's number for the signed-in person, across every workspace; the app sets it when it opens or reads. */
export default defineHandler(async (event) => {
  const context = await getDashboardMemberContext(event, { requireOrganization: false })
  return jsonResponse({ badge: await unreadBadge(context.env, context.db, context.userId) })
})
