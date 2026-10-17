import { defineHandler, HTTPError } from 'nitro'
import { getQuery, readRawBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createStripeClient } from '~/server/utils/stripe-client'
import { paymentsStripeKeys, platformLivemode } from '~/server/utils/stripe-connect'
import { processPaymentEvent } from '~/server/domain/payments/events'

export default defineHandler(async event => {
  const env=cloudflareEnv(event)
  // Each Stripe mode has its own destination; ?mode=test is the test-mode one on a live platform.
  const livemode=getQuery(event).mode==='test'?false:platformLivemode(env), keys=paymentsStripeKeys(env,livemode)
  if(!keys?.paymentsWebhookSecret) throw new HTTPError({statusCode:503,statusMessage:'Stripe Payments webhook is not configured'})
  if(Number(event.req.headers.get('content-length'))>512*1024) throw new HTTPError({statusCode:413,statusMessage:'Payload too large'})
  const payload=await readRawBody(event), signature=event.req.headers.get('stripe-signature')
  if(!payload || new TextEncoder().encode(payload).byteLength>512*1024 || !signature) throw new HTTPError({statusCode:400,statusMessage:'Signed payment payload required'})
  const stripe=createStripeClient(keys.secretKey, 'payments')
  let notification
  try {notification=await stripe.webhooks.constructEventAsync(payload,signature,keys.paymentsWebhookSecret)}
  catch {throw new HTTPError({statusCode:400,statusMessage:'Invalid Stripe payment signature'})}
  if(notification.livemode!==livemode) throw new HTTPError({statusCode:400,statusMessage:'Stripe event mode does not match this destination'})
  if (!await processPaymentEvent(env.DB,stripe,notification,env)) throw new HTTPError({statusCode:503,statusMessage:'Stripe payment event processing is in progress'})
  return jsonResponse({received:true})
})
