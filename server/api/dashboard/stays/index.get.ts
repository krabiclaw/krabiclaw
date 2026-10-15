import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listStays, stayAccessFor } from '~/server/domain/stays'

// Stays overlapping [from, to) across the organization, or at one home with product_id.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const query = getQuery(event)
  return jsonResponse({
    stays: await listStays(db, access, {
      from: query.from, to: query.to,
      productId: typeof query.product_id === 'string' ? query.product_id : undefined,
      includeCancelled: query.include_cancelled === 'true',
    }),
    manage: access.manage,
  })
})
