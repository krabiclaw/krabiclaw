import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createMemberBooking } from '~/server/domain/product-bookings'
import { nightBooking } from '~/server/utils/dashboard-bookings'

export default defineHandler(async event => {
  const { env, organization } = await getDashboardMemberContext(event)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const { product_id, idempotency_key } = body
  if (typeof product_id !== 'string' || !product_id) throw new HTTPError({ statusCode: 400, message: 'Product ID is required' })
  if (typeof idempotency_key !== 'string' || !idempotency_key) throw new HTTPError({ statusCode: 400, message: 'Idempotency key is required' })
  const result = await createMemberBooking(event, {
    principal: memberAccessPrincipal(organization, { env, event }), productId: product_id, body,
    operator: { idempotencyKey: idempotency_key, source: 'dashboard', externalReference: null, guestAcknowledgement: body.guest_acknowledgement === true },
  })
  if (result.kind === 'stay') return jsonResponse({ booking: nightBooking(result.stay) }, { status: result.status })
  return jsonResponse(result.status < 400 ? { booking: result.body } : result.body, { status: result.status })
})
