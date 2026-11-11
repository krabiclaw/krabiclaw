import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardReviewFeedback } from '~/server/utils/review-feedback'

export default defineHandler(async (event) => {
  const query = getQuery(event)
  return jsonResponse(await loadDashboardReviewFeedback(event, {
    days: typeof query.days === 'string' ? Number(query.days) : undefined,
    startDate: typeof query.start_date === 'string' ? query.start_date : undefined,
    endDate: typeof query.end_date === 'string' ? query.end_date : undefined,
  }))
})
