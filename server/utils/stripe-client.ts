import Stripe from 'stripe'
import {
  STRIPE_API_VERSION,
  STRIPE_PAYMENTS_API_VERSION,
} from '~/shared/stripe-contract'

export { STRIPE_API_VERSION } from '~/shared/stripe-contract'

export function createStripeClient(secretKey: string, purpose: 'canonical' | 'payments' = 'canonical', signal?: AbortSignal): Stripe {
  return new Stripe(secretKey, {
    // The stable SDK supports these primitives; preview versions are outside its literal API-version type.
    apiVersion: (purpose === 'payments' ? STRIPE_PAYMENTS_API_VERSION : STRIPE_API_VERSION) as Stripe.LatestApiVersion,
    // The Worker runtime uses the SDK fetch transport rather than Node sockets.
    httpClient: Stripe.createFetchHttpClient(signal ? (input, init) => fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    }) : undefined),
    ...(signal ? { maxNetworkRetries: 0 } : {}),
  })
}
