import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { createPaymentCheckout } from '~/server/domain/payments/checkout'
import { ownedBuyerRequest } from '~/server/domain/payments/buyer'
import { readApprovedStayCheckout } from '~/server/domain/stays'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { resolvePublicTenantOrigin } from '~/server/utils/public-base'

export default defineHandler(async event => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, message: 'Sign in to pay for your stay' })
  requireFinancialBrowserOrigin(event)
  const bookingId = getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const buyerUserId = session.user.id
  const owned = await ownedBuyerRequest(env.DB, buyerUserId, bookingId, 'booking')
  if (owned.unit !== 'nights') throw new HTTPError({ statusCode: 404, message: 'Stay not found' })
  const organizationId = owned.organization_id
  const [approved, origin] = await Promise.all([
    readApprovedStayCheckout(env.DB, organizationId, bookingId, buyerUserId),
    resolvePublicTenantOrigin(env.DB, env, organizationId),
  ])
  if (!origin) throw new HTTPError({ statusCode: 409, message: 'This stay’s website is unavailable for payment' })
  const key = `approved-stay:${bookingId}:${approved.version}`
  const checkout = await createPaymentCheckout(env.DB, env, {
    unit: 'nights', organizationId, buyerUserId, requestId: approved.conversationId,
    requestFingerprint: key, idempotencyKey: key, quantity: 1, following: () => [],
    origin: { request: event.req, pageEventId: null },
    stay: approved.quote, guest: approved.guest, quote: async () => approved.quote,
    approval: { bookingId, buyerUserId, version: approved.version, conversationId: approved.conversationId, expiresAt: approved.expiresAt, policy: approved.policy },
  })
  const pay = new URL(checkout.pay_path, origin)
  pay.hash = checkout.purchase_claim
  return jsonResponse({ pay_url: pay.href }, { headers: { 'cache-control': 'private, no-store' } })
})
