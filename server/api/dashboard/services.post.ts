import { defineHandler, HTTPError } from 'nitro'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { agreeToService, endService, isService, listServices } from '~/server/utils/organization-services'
import { endStrategy, readStrategy, startStrategy } from '~/server/utils/strategy-service'

/** Starting or ending a service uses the shared billing permission, from the dashboard itself. */
export default defineHandler(async (event) => {
  requireFinancialBrowserOrigin(event)
  const { db, env, organization, userId } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['update'] } })
  const body = await readRequiredBody<{ service?: unknown; action?: unknown }>(event)
  if (body.action !== 'agree' && body.action !== 'end') throw new HTTPError({ statusCode: 400, statusMessage: 'A service and an action (agree or end) are required' })
  if (body.service === 'strategy') {
    // Stripe owns this one: the subscription item is the agreement.
    if (body.action === 'agree') await startStrategy(env, db, organization.id)
    else await endStrategy(env, db, organization.id)
  } else {
    if (!isService(body.service)) throw new HTTPError({ statusCode: 400, statusMessage: 'A service and an action (agree or end) are required' })
    if (body.action === 'agree') await agreeToService(db, env, organization.id, body.service, userId)
    else await endService(db, organization.id, body.service, userId)
  }
  const [agreements, strategy] = await Promise.all([listServices(db, organization.id), readStrategy(env, db, organization.id)])
  return jsonResponse({ success: true, services: { ...agreements, strategy } })
})
