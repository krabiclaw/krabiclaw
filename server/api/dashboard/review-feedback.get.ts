import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardReviewFeedback } from '~/server/utils/review-feedback'

export default defineHandler(async (event) => {
  const query = getQuery(event)
  return jsonResponse(await loadDashboardReviewFeedback(event, {
    days: typeof query.days === 'string' ? Number(query.days) : undefined,
    startDate: typeof query.startDate === 'string' ? query.startDate : undefined,
    endDate: typeof query.endDate === 'string' ? query.endDate : undefined,
  }))
})
