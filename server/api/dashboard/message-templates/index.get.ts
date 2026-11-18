import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { listMessageTemplates } from '~/server/domain/guest-messaging'
import { messageScheduleLabel } from '~/utils/message-schedule-presentation'
import { messagingError, parseMessageListQuery } from '~/server/domain/guest-message-schedule'

export default defineHandler(async (event) => {
  const params = getQuery(event)
  const query = parseMessageListQuery(params, ['product_id'])
  const productId = params.product_id
  if (productId !== undefined && (typeof productId !== 'string' || !productId.trim() || productId !== productId.trim())) {
    messagingError(400, 'INVALID_MESSAGING_QUERY', 'product_id must be one product ID', 'product_id')
  }
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const page = await listMessageTemplates(db, access, query, productId)
  return jsonResponse({
    ...page,
    can_manage: access.manage,
    templates: page.templates.map(template => ({ ...template, schedule_label: messageScheduleLabel(template.schedule, organization.vertical) })),
  })
})
