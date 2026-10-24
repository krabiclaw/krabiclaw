import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { listContentReports } from '~/server/domain/content-reports'
import { requirePlatformReportsAccess } from '~/server/utils/platform-reports-access'

// GET /api/dashboard/platform-reports?status=open|removed|dismissed
export default defineHandler(async (event) => {
  const { db } = await requirePlatformReportsAccess(event)
  return jsonResponse({ reports: await listContentReports(db, getQuery(event).status ?? 'open') }, { headers: { 'cache-control': 'private, no-store' } })
})
