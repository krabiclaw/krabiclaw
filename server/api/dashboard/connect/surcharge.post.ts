import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { execute } from '~/server/db'
import { getStripeConnectedAccount } from '~/server/utils/stripe-connect'

/**
 * Passing on credit card fees. The business names a rate; Stripe decides per
 * card, at payment time, whether a surcharge may apply and how much at most, so
 * the rate here is a ceiling the business chose, never the amount charged.
 */
export default defineHandler(async (event) => {
  requireFinancialBrowserOrigin(event)
  const { db, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  const body = await readBody(event) as { basis_points?: unknown } | undefined
  const points = body?.basis_points ?? null
  if (points !== null && (!Number.isSafeInteger(points) || (points as number) < 1 || (points as number) > 10_000)) throw new HTTPError({ statusCode: 400, statusMessage: 'The surcharge rate must be between 0.01% and 100%' })
  const connected = await getStripeConnectedAccount(db, organization.id)
  if (!connected?.stripeAccountId || connected.status !== 'ready') throw new HTTPError({ statusCode: 409, statusMessage: 'Finish Stripe setup before passing on card fees' })
  await execute(db, 'UPDATE stripe_connected_accounts SET surcharge_basis_points=?,updated_at=? WHERE id=? AND organization_id=?', [points, new Date().toISOString(), connected.id, organization.id])
  const account = await getStripeConnectedAccount(db, organization.id)
  if (!account) throw new Error('Stripe connected account disappeared')
  return jsonResponse({ success: true, account })
})
