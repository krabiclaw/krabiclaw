import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { PAYMENT_TERMS } from '~/shared/billing-model'
import { execute } from '~/server/db'
import { getStripeConnectedAccount } from '~/server/utils/stripe-connect'

/**
 * Passing on credit card fees. The business names a rate; Stripe decides per
 * card, at payment time, whether a surcharge may apply and how much at most, so
 * the rate here is a ceiling the business chose, never the amount charged.
 */
export default defineHandler(async (event) => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  const body = await readBody(event) as { basis_points?: unknown } | undefined
  if (!body || !Object.hasOwn(body, 'basis_points')) throw new HTTPError({ statusCode: 422, statusMessage: 'basis_points is required; use null to turn surcharging off', data: { code: 'VALIDATION_ERROR', field: 'basis_points' } })
  const points = body.basis_points
  if (points !== null && (!Number.isSafeInteger(points) || (points as number) < PAYMENT_TERMS.minimumBasisPoints || (points as number) > PAYMENT_TERMS.maximumBasisPoints)) throw new HTTPError({ statusCode: 400, statusMessage: `The surcharge rate must be between ${PAYMENT_TERMS.minimumBasisPoints / 100}% and ${PAYMENT_TERMS.maximumBasisPoints / 100}%`, data: { code: 'VALIDATION_ERROR', field: 'basis_points' } })
  const connected = await getStripeConnectedAccount(db, organization.id)
  if (!connected?.stripeAccountId || connected.status !== 'ready') throw new HTTPError({ statusCode: 409, statusMessage: 'Finish Stripe setup before passing on card fees', data: { code: 'CONNECT_NOT_READY', field: 'account.status' } })
  await execute(db, 'UPDATE stripe_connected_accounts SET surcharge_basis_points=?,updated_at=? WHERE id=? AND organization_id=?', [points, new Date().toISOString(), connected.id, organization.id])
  const account = await getStripeConnectedAccount(db, organization.id)
  if (!account) throw new Error('Stripe connected account disappeared')
  return jsonResponse({ success: true, account })
})
