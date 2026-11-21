import type { H3Event } from 'nitro'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { assertRoleAllows, memberAccessPrincipal } from '~/server/utils/member-access'

/** A deposit write: money the business records, so it takes the same permission as a refund. */
export async function depositRequest(event: H3Event) {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  await assertRoleAllows({ ...principal, permissions: { payments: ['refund'] } })
  return { db, actor: { organizationId: principal.organizationId, actorId: principal.userId } }
}
