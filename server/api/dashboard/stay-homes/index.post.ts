import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createStayHome, stayAccessFor, stayHomeInput } from '~/server/domain/stays'

// Add a place to stay by hand: a new location and an unpublished stay at it.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const key = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : null
  if (!key || key.length > 200) return jsonResponse({ error: 'idempotency_key must be 1 to 200 characters', code: 'VALIDATION_ERROR', field: 'idempotency_key' }, { status: 400 })
  return jsonResponse({ home: await createStayHome(env, db, access, stayHomeInput(body), key) }, { status: 201 })
})
