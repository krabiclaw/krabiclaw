import { HTTPError, defineHandler  } from 'nitro';

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { getOrganizationBillingStatus, getStripe, requireBillingAccess } from '~/server/utils/billing'
import { resolveRequestedOrganization } from '~/server/utils/dashboard-context'
import {
  buildStripeSubscriptionMetadata, isStripeGa4IntentAction, type StripeGa4IntentAction, } from '~/shared/stripe-ga4'
import { recordStripeGa4Intent } from '~/server/utils/stripe-ga4-intents'
import { readAnalyticsConsent } from '~/server/utils/ga4-delivery'
import { withdrawStripeGaIdentifiers } from '~/server/utils/stripe-ga4'
import { SESSION_COOKIE, isCanonicalEventId } from '~/server/utils/pageview-tracking'
import { queryFirst } from '~/server/db'
import type { AttributionTouch } from '~/utils/analytics-attribution'
import { parseCookies } from 'better-auth/cookies'

interface AnalyticsIntentRequest {
  organizationId?: string
  subscriptionId?: string | null
  action?: string
  gaClientId?: string | null
  gaSessionId?: string | null
  gaSessionCapturedAt?: number | null
  previousPriceId?: string | null
  newPriceId?: string | null
  effectiveTiming?: 'immediate' | 'period_end'
  source?: 'browser' | 'server'
}

function optionalString(value: unknown, maxLength = 255): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null
}

async function updateStripeAttribution(
  env: ReturnType<typeof cloudflareEnv>, organizationId: string, userId: string, body: AnalyticsIntentRequest, action: StripeGa4IntentAction, ): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe not configured' })
  const subscriptionId = optionalString(body.subscriptionId)
  const stripe = getStripe(env)
  const subscription = subscriptionId
    ? await stripe.subscriptions.retrieve(subscriptionId)
    : null
  const customerId = subscription
    ? (typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null)
    : (await getOrganizationBillingStatus(env, env.DB, organizationId)).stripeCustomerId ?? null
  const contextMetadata: Record<string, string> = buildStripeSubscriptionMetadata(action, {
    gaClientId: optionalString(body.gaClientId), gaSessionId: optionalString(body.gaSessionId, 64), gaSessionCapturedAt: body.gaSessionCapturedAt, }, userId, optionalString(body.previousPriceId), optionalString(body.newPriceId))
  if (action !== 'initial_subscription') {
    contextMetadata.pending_change_type = action
    contextMetadata.pending_user_id = userId
    if (contextMetadata.ga_client_id) contextMetadata.pending_ga_client_id = contextMetadata.ga_client_id
    if (contextMetadata.ga_session_id) contextMetadata.pending_ga_session_id = contextMetadata.ga_session_id
    if (contextMetadata.ga_session_captured_at) contextMetadata.pending_ga_session_captured_at = contextMetadata.ga_session_captured_at
  }

  if (!contextMetadata.ga_client_id) {
    contextMetadata.ga_client_id = ''
    contextMetadata.pending_ga_client_id = ''
  }

  if (subscription) {
    await stripe.subscriptions.update(subscription.id, {
      metadata: { ...subscription.metadata, ...contextMetadata }, })
  }
  if (customerId) {
    const customer = await stripe.customers.retrieve(customerId)
    if (!customer.deleted) {
      await stripe.customers.update(customerId, {
        metadata: {
          ...customer.metadata, user_id: userId, ga_client_id: contextMetadata.ga_client_id || '', }, })
    }
  }
}

export default defineHandler(async (event) => {
  const body = await readBody<AnalyticsIntentRequest>(event)
  const env = cloudflareEnv(event)
  if (!env.DB) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })
  if (!body?.organizationId || !isStripeGa4IntentAction(body.action)) {
    return jsonResponse({ error: 'organizationId, and a valid action are required' }, { status: 400 })
  }
  if (body.effectiveTiming && body.effectiveTiming !== 'immediate' && body.effectiveTiming !== 'period_end') {
    return jsonResponse({ error: 'Invalid effective timing' }, { status: 400 })
  }
  if (body.source && body.source !== 'browser' && body.source !== 'server') {
    return jsonResponse({ error: 'Invalid intent source' }, { status: 400 })
  }

  const organization = await resolveRequestedOrganization(event, env.DB, session.user.id, {
    explicitOrganizationId: body.organizationId, })
  if (!organization) return jsonResponse({ error: 'Organization not found' }, { status: 404 })
  try {
    await requireBillingAccess(env, env.DB, organization.id, session.user.id)
  } catch {
    return jsonResponse({ error: 'Only organization owners can manage billing' }, { status: 403 })
  }

  const subscriptionId = optionalString(body.subscriptionId)
  if (subscriptionId) {
    const billingStatus = await getOrganizationBillingStatus(env, env.DB, organization.id)
    if (billingStatus.stripeSubscriptionId !== subscriptionId) return jsonResponse({ error: 'Subscription does not belong to this organization' }, { status: 400 })
  }

  const action = body.action as StripeGa4IntentAction
  if (action !== 'initial_subscription' && !subscriptionId) {
    return jsonResponse({ error: 'An existing subscription is required for an upgrade or downgrade intent' }, { status: 400 })
  }
  if (action === 'initial_subscription' && subscriptionId) {
    return jsonResponse({ error: 'Initial subscription intents cannot reference an existing subscription' }, { status: 400 })
  }
  if (action !== 'downgrade' && body.effectiveTiming === 'period_end') {
    return jsonResponse({ error: 'Only downgrades can be scheduled at period end' }, { status: 400 })
  }
  // A GA identifier is stored only for a visitor whose own request says they accepted analytics;
  // the browser's claim is not consent, and no identifier is kept without it.
  const cookieHeader = event.req.headers.get('cookie') ?? ''
  const consented = readAnalyticsConsent(cookieHeader) === 'accepted'
  // Not accepted: nothing new is stored, and what an earlier acceptance left behind is erased
  // first, because the metadata update below merges with what Stripe already holds.
  if (!consented) await withdrawStripeGaIdentifiers(env.DB, () => getStripe(env), session.user.id)
  const gaBody = consented ? body : { ...body, gaClientId: null, gaSessionId: null, gaSessionCapturedAt: null }
  const clientId = optionalString(gaBody.gaClientId)
  const sessionId = optionalString(gaBody.gaSessionId, 64)
  const sessionCapturedAt = typeof gaBody.gaSessionCapturedAt === 'number'
    && Number.isSafeInteger(gaBody.gaSessionCapturedAt)
    && gaBody.gaSessionCapturedAt > 0
    ? gaBody.gaSessionCapturedAt
    : null

  // The native attribution this visitor's session has observed so far, so the payment a webhook
  // records later carries the campaign that produced it. First-party, so consent-independent.
  const nativeSessionId = parseCookies(cookieHeader).get(SESSION_COOKIE)
  const observed = isCanonicalEventId(nativeSessionId) && typeof event.context.organizationId === 'string'
    ? await queryFirst<{ attribution: string }>(env.DB, `SELECT json_extract(payload_json, '$.attribution') AS attribution FROM analytics_summaries
        WHERE organization_id = ? AND kind = 'session' AND date = '' AND key = ?`, [event.context.organizationId, nativeSessionId])
    : null
  const attribution = observed?.attribution ? { touch: JSON.parse(observed.attribution) as AttributionTouch, attributedAt: new Date().toISOString() } : null

  await updateStripeAttribution(env, organization.id, session.user.id, gaBody, action)
  const intent = await recordStripeGa4Intent(env.DB, {
    organizationId: organization.id, userId: session.user.id, stripeSubscriptionId: subscriptionId, action, clientId, sessionId, sessionCapturedAt, attribution, previousPriceId: optionalString(body.previousPriceId), newPriceId: optionalString(body.newPriceId), effectiveTiming: body.effectiveTiming, source: body.source ?? 'browser', })
  return jsonResponse({ success: true, intent_id: intent.id })
})
import { readBody } from 'nitro/h3';
