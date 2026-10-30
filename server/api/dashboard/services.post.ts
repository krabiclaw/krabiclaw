import { defineHandler, HTTPError } from 'nitro'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { agreeToService, endService, isService, listServices } from '~/server/utils/organization-services'
import { endStrategy, isAttemptId, readStrategy, startStrategy } from '~/server/utils/strategy-service'
import { SERVICES as offers } from '~/shared/billing-model'

/** Starting or ending a service uses the shared billing permission, from the dashboard itself. */
export default defineHandler(async (event) => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, organization, userId } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['update'] } })
  try {
  const body = await readRequiredBody<{ service?: unknown; action?: unknown; attempt?: unknown }>(event)
  if (body.action !== 'agree' && body.action !== 'end') throw new HTTPError({ statusCode: 400, statusMessage: 'A service and an action (agree or end) are required', data: { code: 'INVALID_SERVICE_ACTION', field: 'action' } })
  if (body.service === 'strategy') {
    // Stripe owns this one: the subscription item is the agreement. The attempt id scopes Stripe's idempotency to this consent.
    if (!isAttemptId(body.attempt)) throw new HTTPError({ statusCode: 400, statusMessage: 'An attempt id is required for the strategy service', data: { code: 'INVALID_SERVICE_ATTEMPT', field: 'attempt' } })
    if (body.action === 'agree') await startStrategy(env, db, organization.id, userId, body.attempt)
    else await endStrategy(env, db, organization.id, userId, body.attempt)
  } else {
    if (!isService(body.service)) throw new HTTPError({ statusCode: 400, statusMessage: 'A service and an action (agree or end) are required', data: { code: 'INVALID_SERVICE', field: 'service' } })
    if (body.action === 'agree') await agreeToService(db, env, organization.id, body.service, userId)
    else await endService(db, organization.id, body.service, userId)
  }
  const [agreements, strategy] = await Promise.all([listServices(db, organization.id), readStrategy(env, db, organization.id)])
  return jsonResponse({ success: true, services: { ...agreements, strategy }, offers })
  } catch (cause) {
    if (cause instanceof HTTPError) throw cause
    throw new HTTPError({ statusCode: 502, statusMessage: 'Service change could not be verified; read the current status before trying again', data: { code: 'SERVICE_CHANGE_UNVERIFIED', field: 'service' }, cause })
  }
})
