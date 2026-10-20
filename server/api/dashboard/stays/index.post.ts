import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createStay, stayAccessFor } from '~/server/domain/stays'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readRequiredBody<Record<string, unknown>>(event)
  if (typeof body.product_id !== 'string' || !body.product_id) return jsonResponse({ error: 'product_id is required', code: 'VALIDATION_ERROR', field: 'product_id' }, { status: 400 })
  if (typeof body.idempotency_key !== 'string' || !body.idempotency_key) return jsonResponse({ error: 'idempotency_key is required', code: 'VALIDATION_ERROR', field: 'idempotency_key' }, { status: 400 })
  return jsonResponse({ stay: await createStay(db, env, access, { ...body, product_id: body.product_id, idempotency_key: body.idempotency_key }) }, { status: 201 })
})
