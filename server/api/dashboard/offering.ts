import { defineHandler, HTTPError } from 'nitro'
import { catalogAnswer } from '~/shared/catalog-screen'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { dashboardOffering } from '~/server/utils/dashboard-offering'

export default defineHandler(async event => {
  if (event.req.method === 'GET') return jsonResponse(await dashboardOffering(event))
  if (event.req.method !== 'POST') throw new HTTPError({ statusCode: 405, message: 'Method not allowed' })
  const answer = catalogAnswer.safeParse(await readRequiredBody(event))
  if (!answer.success) throw new HTTPError({ statusCode: 422, message: 'Invalid offering answer' })
  await dashboardOffering(event, answer.data)
  return jsonResponse({ success: true })
})
