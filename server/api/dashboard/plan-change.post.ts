import { defineHandler, HTTPError } from 'nitro'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { confirmBusinessChange, previewBusinessChange } from '~/server/utils/business-plan'
import { isAttemptId } from '~/server/utils/strategy-service'

/** Business locations and rental units: Stripe's invoice preview first, then the confirmed change, with the shared billing permission. */
export default defineHandler(async (event) => {
  requireFinancialBrowserOrigin(event)
  const { db, env, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['update'] } })
  const body = await readRequiredBody<{ action?: unknown; locations?: unknown; rentalUnits?: unknown; prorationDate?: unknown; attempt?: unknown }>(event)
  if (body.action === 'preview') {
    return jsonResponse({ success: true, preview: await previewBusinessChange(env, db, organization.id, body) }, { headers: { 'cache-control': 'private, no-store' } })
  }
  if (body.action === 'confirm') {
    // The attempt id scopes Stripe's idempotency to this confirmation, so a retried click does not change the subscription twice.
    if (!isAttemptId(body.attempt)) throw new HTTPError({ statusCode: 400, statusMessage: 'An attempt id is required to confirm a plan change' })
    return jsonResponse({ success: true, plan: await confirmBusinessChange(env, db, organization.id, { ...body, attempt: body.attempt }) })
  }
  throw new HTTPError({ statusCode: 400, statusMessage: 'An action (preview or confirm) is required' })
})
