import { defineHandler } from 'nitro'
import { readRequiredBody, jsonResponse } from '~/server/utils/api-response'
import { createTableReservation } from '~/server/domain/table-reservations'

export default defineHandler(async event => {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })
  const result = await createTableReservation(event, { organizationId, body: await readRequiredBody<Record<string, unknown>>(event) })
  return jsonResponse(result.body, { status: result.status })
})
