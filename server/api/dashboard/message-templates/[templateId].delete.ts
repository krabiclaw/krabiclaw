import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { deleteMessageTemplate } from '~/server/domain/guest-messaging'
import { messageText, messagingError } from '~/server/domain/guest-message-schedule'

export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const value = await readRequiredBody<unknown>(event)
  if (!value || typeof value !== 'object' || Array.isArray(value)) messagingError(422, 'INVALID_MESSAGING_FIELD', 'Provide an object containing the current version', 'version')
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(key => key !== 'version')) messagingError(422, 'INVALID_MESSAGING_FIELD', 'Provide the current version only', 'version')
  await deleteMessageTemplate(db, env, access, messageText(getRouterParam(event, 'templateId'), 'templateId', 200), body.version)
  return jsonResponse({ status: 'deleted' })
})
