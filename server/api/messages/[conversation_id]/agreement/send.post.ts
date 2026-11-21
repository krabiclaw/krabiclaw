import { defineHandler, HTTPError } from 'nitro'
import { sendAgreement } from '~/server/domain/agreements'
import { jsonResponse } from '~/server/utils/api-response'
import { agreementRequest, requireAgreementManager } from '~/server/utils/agreement-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'

/** The business sends a PDF with each signer's fields placed; every guest signer is emailed a link to sign. */
export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { env, conversation, viewer, actor } = await agreementRequest(event)
  requireAgreementManager(viewer)
  const form = await event.req.formData()
  const file = form.get('file')
  const details = form.get('details')
  if (!(file instanceof File)) throw new HTTPError({ statusCode: 400, message: 'Choose a PDF', data: { code: 'FILE_REQUIRED', field: 'file' } })
  if (typeof details !== 'string') throw new HTTPError({ statusCode: 400, message: 'Signers and fields are required', data: { code: 'VALIDATION_ERROR', field: 'details' } })
  let parsed: unknown
  try {
    parsed = JSON.parse(details)
  } catch (cause) {
    throw new HTTPError({ statusCode: 400, message: 'Signers and fields are not valid JSON', data: { code: 'VALIDATION_ERROR', field: 'details' }, cause })
  }
  const { signers, fields } = (parsed ?? {}) as { signers?: unknown; fields?: unknown }
  if (!Array.isArray(signers) || !Array.isArray(fields)) throw new HTTPError({ statusCode: 422, message: 'Signers and fields are required', data: { code: 'VALIDATION_ERROR', field: 'details' } })
  await sendAgreement(env, conversation, actor, { file, signers, fields })
  return jsonResponse({ sent: true }, { status: 201 })
})
