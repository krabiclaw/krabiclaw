import { defineHandler, HTTPError } from 'nitro'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { acceptedPaymentMethods } from '~/server/utils/stripe-connect'
import { buildPublicPaymentMethodsCacheKey, getPublicResourceCache, putPublicResourceCache } from '~/server/utils/public-resource-cache'

const PAYMENT_METHODS_TTL_SECONDS = 3600

/**
 * The ways this site's business takes payment, for its footer. Kept in the
 * site's public resource cache for an hour, under the site's own key, so
 * Stripe is asked at most hourly per site and a site purge clears it.
 */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) throw new HTTPError({ statusCode: 404, statusMessage: 'Site not found' })
  const env = cloudflareEnv(event)
  const kv = env.ORGANIZATION_CACHE
  if (!kv) throw new HTTPError({ statusCode: 500, statusMessage: 'Public resource cache is not bound' })
  const key = buildPublicPaymentMethodsCacheKey(organizationId)
  const cached = await getPublicResourceCache(kv, key)
  const body = cached ?? JSON.stringify(await acceptedPaymentMethods(env.DB, env, organizationId))
  if (!cached) await putPublicResourceCache(kv, key, body, PAYMENT_METHODS_TTL_SECONDS)
  return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${PAYMENT_METHODS_TTL_SECONDS}` } })
})
