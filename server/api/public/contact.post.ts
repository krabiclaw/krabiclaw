import { createInquiry } from '~/server/domain/inquiries'
import { jsonResponse } from '~/server/utils/api-response'
import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'

/** The website's inquiry form: the same operation MCP's create_inquiry runs, for the tenant this host resolves to. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })
  let body: ApiRecord
  try { body = await readBody(event) } catch {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  const outcome = await createInquiry(event, { organizationId, body })
  return jsonResponse(outcome.body, { status: outcome.status })
})
