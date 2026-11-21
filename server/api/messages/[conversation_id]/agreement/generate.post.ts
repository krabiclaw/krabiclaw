import { defineHandler, HTTPError } from 'nitro'
import { generateAgreementFromTemplate } from '~/server/domain/agreement-templates'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { agreementRequest, requireAgreementManager } from '~/server/utils/agreement-request'

/** The listing's template filled from this booking, as the PDF the business then reviews and sends. */
export default defineHandler(async event => {
  const { env, conversation, viewer, actor } = await agreementRequest(event)
  requireAgreementManager(viewer)
  const { signers } = await readRequiredBody<{ signers?: unknown }>(event)
  const valid = Array.isArray(signers) && signers.every(signer => typeof signer === 'object' && signer !== null
    && typeof (signer as { key?: unknown }).key === 'string' && typeof (signer as { name?: unknown }).name === 'string'
    && ['guest', 'host'].includes((signer as { role?: unknown }).role as string))
  if (!valid) throw new HTTPError({ statusCode: 422, message: 'Signers are required', data: { code: 'VALIDATION_ERROR', field: 'signers' } })
  const document = await generateAgreementFromTemplate(env, conversation, actor, signers as { key: string; name: string; role: 'guest' | 'host' }[])
  return jsonResponse({ file_name: document.file_name, fields: document.fields, pdf_base64: Buffer.from(document.bytes).toString('base64') }, { headers: { 'cache-control': 'private, no-store' } })
})
