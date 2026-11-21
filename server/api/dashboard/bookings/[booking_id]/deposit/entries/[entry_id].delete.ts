import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { depositRequest } from '~/server/utils/deposit-request'
import { deleteDepositEntry } from '~/server/domain/deposits'

/** Remove a deposit entry recorded by mistake. */
export default defineHandler(async event => {
  const { db, actor } = await depositRequest(event)
  return jsonResponse({ deposit: await deleteDepositEntry(db, actor, getRouterParam(event, 'booking_id') ?? '', getRouterParam(event, 'entry_id') ?? '') })
})
