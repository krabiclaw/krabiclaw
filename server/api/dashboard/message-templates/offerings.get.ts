import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { listMessageOfferings } from '~/server/domain/guest-messaging'

// The homes and bookable products (tables included) an automatic message can name.
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return jsonResponse(await listMessageOfferings(db, access))
})
