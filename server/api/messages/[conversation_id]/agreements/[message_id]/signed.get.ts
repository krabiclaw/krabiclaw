import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { signedAgreementDocument } from '~/server/domain/agreements'
import { agreementRequest, pdfResponse } from '~/server/utils/agreement-request'

/** The signed document: every signature in place and the signature record after it. */
export default defineHandler(async event => {
  const { env, conversation, viewer } = await agreementRequest(event)
  const messageId = getRouterParam(event, 'message_id', { decode: true })
  if (!messageId) throw new HTTPError({ statusCode: 400, message: 'A document is required', data: { code: 'VALIDATION_ERROR', field: 'message_id' } })
  const document = await signedAgreementDocument(env, conversation, messageId, viewer)
  return pdfResponse(document.bytes, document.fileName, getQuery(event).download === '1')
})
