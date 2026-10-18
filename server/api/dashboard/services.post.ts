import { defineHandler, HTTPError } from 'nitro'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { agreeToService, endService, isService, listServices } from '~/server/utils/organization-services'

/** Starting or ending a service uses the shared billing permission, from the dashboard itself. */
export default defineHandler(async (event) => {
  requireFinancialBrowserOrigin(event)
  const { db, env, organization, userId } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['update'] } })
  const body = await readRequiredBody<{ service?: unknown; action?: unknown }>(event)
  if (!isService(body.service) || (body.action !== 'agree' && body.action !== 'end')) throw new HTTPError({ statusCode: 400, statusMessage: 'A service and an action (agree or end) are required' })
  if (body.action === 'agree') await agreeToService(db, env, organization.id, body.service, userId)
  else await endService(db, organization.id, body.service, userId)
  return jsonResponse({ success: true, services: await listServices(db, organization.id) })
})
