import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { resolveContentReport } from '~/server/domain/content-reports'
import { requirePlatformReportsAccess } from '~/server/utils/platform-reports-access'

// POST /api/dashboard/platform-reports/:reportId/resolve {decision: 'remove' | 'dismiss'}
export default defineHandler(async (event) => {
  const { env, db, session } = await requirePlatformReportsAccess(event)
  const body = await readStrictBody<{ decision?: unknown }>(event, { decision: 'string' })
  const report = await resolveContentReport(env, db, {
    reportId: getRouterParam(event, 'reportId') ?? '', staffUserId: session.user.id, decision: body.decision, headers: event.req.headers,
  })
  return jsonResponse({ report })
})
