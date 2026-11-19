import Stripe from 'stripe'
import { recordDatabaseRequestPhase, recordRequestExternalCall } from '~/server/utils/request-metrics'
import {
  STRIPE_API_VERSION,
  STRIPE_PAYMENTS_API_VERSION,
} from '~/shared/stripe-contract'

export { STRIPE_API_VERSION } from '~/shared/stripe-contract'

export function createStripeClient(secretKey: string, purpose: 'canonical' | 'payments' = 'canonical', requestDb?: D1Database): Stripe {
  const stripe = new Stripe(secretKey, {
    // The stable SDK supports these primitives; preview versions are outside its literal API-version type.
    apiVersion: (purpose === 'payments' ? STRIPE_PAYMENTS_API_VERSION : STRIPE_API_VERSION) as Stripe.LatestApiVersion,
    // The Worker runtime uses the SDK fetch transport rather than Node sockets.
    httpClient: Stripe.createFetchHttpClient(),
  })
  if (requestDb) {
    stripe.on('request', () => recordRequestExternalCall(requestDb, 'stripe'))
    stripe.on('response', response => recordDatabaseRequestPhase(requestDb, 'stripe_responses', performance.now() - response.elapsed))
  }
  return stripe
}
