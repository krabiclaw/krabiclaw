import { defineHandler, HTTPError } from 'nitro'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { acceptedPaymentMethods } from '~/server/utils/stripe-connect'

/** The ways this site's business takes payment, for its footer. Stripe is asked at most hourly per site. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) throw new HTTPError({ statusCode: 404, statusMessage: 'Site not found' })
  const env = cloudflareEnv(event)
  return jsonResponse(await acceptedPaymentMethods(env.DB, env, organizationId), { headers: { 'cache-control': 'public, max-age=3600' } })
})
