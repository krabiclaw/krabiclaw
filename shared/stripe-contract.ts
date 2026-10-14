export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const
// Payments/Connect Accounts v2 Express Managed Risk requires the documented preview.
export const STRIPE_PAYMENTS_API_VERSION = '2026-09-30.preview' as const
// Stripe lets webhook destinations pin the event-rendering schema separately
// from the outbound client API version. Keep this endpoint contract explicit;
// changing the client version must not silently upgrade inbound webhook events.
export const STRIPE_WEBHOOK_API_VERSION = '2025-11-17.clover' as const
export const STRIPE_WEBHOOK_PATH = '/api/auth/stripe/webhook' as const
