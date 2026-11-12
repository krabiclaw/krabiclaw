import { z } from 'zod'
import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { apiErrorResponse, jsonResponse } from '~/server/utils/api-response'
import { loadDashboardOrganizationAnalytics } from '~/server/utils/dashboard-org-analytics'

export default defineHandler(async (event) => {
  const query = getQuery(event)
  try {
    return jsonResponse(await loadDashboardOrganizationAnalytics(event, {
      startDate: typeof query.start_date === 'string' ? query.start_date : undefined,
      endDate: typeof query.end_date === 'string' ? query.end_date : undefined,
    }))
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiErrorResponse(event, 500, 'INVALID_ANALYTICS_RESPONSE',
        `Analytics response is invalid: ${error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    }
    throw error
  }
})
