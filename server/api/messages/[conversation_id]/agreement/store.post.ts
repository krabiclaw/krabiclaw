import { defineHandler, HTTPError } from 'nitro'
import { storeAgreement } from '~/server/domain/agreements'
import { jsonResponse } from '~/server/utils/api-response'
import { agreementRequest, requireAgreementManager } from '~/server/utils/agreement-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'

/** The business keeps a copy that was already signed on the booking. */
export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { env, conversation, viewer, actor } = await agreementRequest(event)
  requireAgreementManager(viewer)
  const file = (await event.req.formData()).get('file')
  if (!(file instanceof File)) throw new HTTPError({ statusCode: 400, message: 'Choose a PDF', data: { code: 'FILE_REQUIRED', field: 'file' } })
  await storeAgreement(env, conversation, actor, file)
  return jsonResponse({ stored: true }, { status: 201 })
})
