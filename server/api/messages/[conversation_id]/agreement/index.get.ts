import { defineHandler } from 'nitro'
import { readBookingAgreement } from '~/server/domain/agreements'
import { jsonResponse } from '~/server/utils/api-response'
import { agreementRequest } from '~/server/utils/agreement-request'

/** The booking's agreement as this viewer reads it: what to sign, who has, and what they may do. */
export default defineHandler(async event => {
  const { db, conversation, viewer, actor } = await agreementRequest(event)
  const { agreement, available_signers } = await readBookingAgreement(db, conversation, viewer, actor)
  return jsonResponse({ agreement, can_manage: viewer.canManage, ...(available_signers ? { available_signers } : {}) }, { headers: { 'cache-control': 'private, no-store' } })
})
