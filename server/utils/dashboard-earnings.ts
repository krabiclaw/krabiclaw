import type { H3Event } from 'nitro'
import { paymentPerformance } from '~/server/domain/payments/earnings'
import { authorizePayments } from '~/server/domain/payments'
import { getDashboardContext } from '~/server/utils/dashboard-context'

export async function readDashboardEarnings(event: H3Event, query: { year?: unknown; month?: unknown }, orgSlug?: string) {
  const { db, organization, userId } = await getDashboardContext(event, { organizationSlug: orgSlug })
  const principal = { organizationId: organization.id, userId, role: organization.role }
  await authorizePayments(principal, 'read')
  const now = new Date()
  const year = Number(query.year ?? now.getUTCFullYear())
  const month = typeof query.month === 'string' ? query.month : now.toISOString().slice(0, 7)
  return paymentPerformance(db, principal, year, month)
}
