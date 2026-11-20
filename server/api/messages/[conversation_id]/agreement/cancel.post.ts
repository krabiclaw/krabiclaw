import { defineHandler } from 'nitro'
import { cancelAgreement } from '~/server/domain/agreements'
import { jsonResponse } from '~/server/utils/api-response'
import { agreementRequest, requireAgreementManager } from '~/server/utils/agreement-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { env, conversation, viewer, actor } = await agreementRequest(event)
  requireAgreementManager(viewer)
  await cancelAgreement(env, conversation, actor)
  return jsonResponse({ cancelled: true })
})
