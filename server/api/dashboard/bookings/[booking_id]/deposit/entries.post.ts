import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { depositRequest } from '~/server/utils/deposit-request'
import { recordDepositEntry } from '~/server/domain/deposits'

/** Deposit money received, returned or kept, recorded by the business. */
export default defineHandler(async event => {
  const { db, actor } = await depositRequest(event)
  const result = await recordDepositEntry(db, actor, getRouterParam(event, 'booking_id') ?? '', await readRequiredBody<Record<string, unknown>>(event))
  return jsonResponse(result, { status: 201 })
})
