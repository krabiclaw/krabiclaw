import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { agreementDocument } from '~/server/domain/agreements'
import { agreementRequest, pdfResponse } from '~/server/utils/agreement-request'

/** A booking's document, for whoever can read its conversation. */
export default defineHandler(async event => {
  const { env, conversation } = await agreementRequest(event)
  const messageId = getRouterParam(event, 'message_id', { decode: true })
  if (!messageId) throw new HTTPError({ statusCode: 400, message: 'A document is required', data: { code: 'VALIDATION_ERROR', field: 'message_id' } })
  const document = await agreementDocument(env, conversation, messageId)
  return pdfResponse(document.bytes, document.fileName, getQuery(event).download === '1')
})
