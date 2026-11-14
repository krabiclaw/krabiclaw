import { defineHandler, HTTPError } from 'nitro'
import { catalogAnswer } from '~/shared/catalog-screen'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { dashboardOffering } from '~/server/utils/dashboard-offering'
import { isRecord } from '~/server/utils/type-guards'

export default defineHandler(async event => {
  try {
    if (event.req.method === 'GET') return jsonResponse(await dashboardOffering(event))
    if (event.req.method !== 'POST') throw new HTTPError({ statusCode: 405, message: 'Method not allowed' })
    const answer = catalogAnswer.safeParse(await readRequiredBody(event))
    if (!answer.success) throw new HTTPError({ statusCode: 422, message: 'Invalid offering answer' })
    await dashboardOffering(event, answer.data)
    return jsonResponse({ success: true })
  } catch (error) {
    if (!HTTPError.isError(error) || error.status < 400 || error.status >= 500) throw error
    const details = isRecord(error.data) ? error.data : {}
    if (typeof details.code === 'string' && details.code.trim()) throw error
    throw new HTTPError({
      statusCode: error.status, message: error.message, headers: error.headers, cause: error,
      data: { ...details, code: 'CMS_REQUEST_REJECTED' },
    })
  }
})
