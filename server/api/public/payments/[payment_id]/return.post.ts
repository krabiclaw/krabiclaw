import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { ensureInteractionUser, getAuthSession } from '~/server/utils/auth'
import { completePaymentReturn, type preparePaymentReturn } from '~/server/domain/payments/intent'
import { assertExactCanonicalLocale, readPublicOrganizationLanguage, readPublicSourceLocale } from '~/server/utils/localization'
import type { AuthorizedPaymentReturnDocument } from '~/server/utils/payment-return-document'

/** The buyer is back from paying on this site: the purchase is verified, attached to the site's buyer and its receipt named. */
export default defineHandler(async (event) => {
  const document = event.context.authorizedPaymentReturn as AuthorizedPaymentReturnDocument | undefined
  const organizationId = document?.payment.organization_id ?? event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'payment_id')
  if (event.context.checkoutBodyError) throw event.context.checkoutBodyError
  const body = (event.context.checkoutBody as { claim?: unknown; locale?: unknown } | undefined) ?? await readRequiredBody<{ claim?: unknown; locale?: unknown }>(event)
  if (!organizationId || !paymentId || typeof body.claim !== 'string') return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const prepared = event.context.paymentReturn as { paymentId: string; plan: Awaited<ReturnType<typeof preparePaymentReturn>>; row: unknown } | undefined
  const receiptLanguage = typeof body.locale === 'string' ? async () => {
    const source = await readPublicSourceLocale(event, env.DB, organizationId)
    return readPublicOrganizationLanguage(event, env.DB, organizationId, assertExactCanonicalLocale(body.locale), source)
  } : undefined
  try {
    return jsonResponse(await completePaymentReturn(env.DB, env, organizationId, paymentId, body.claim, async () => (await ensureInteractionUser(event, env)).id,
      prepared?.paymentId === paymentId ? prepared : undefined, receiptLanguage,
      async () => (await getAuthSession(event, env))?.user.id, document), { headers: { 'cache-control': 'private, no-store' } })
  } catch (error) {
    if (document && error instanceof Error && error.message.includes('PAYMENT_RETURN_DOCUMENT_STALE')) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'Checkout return context expired', data: { code: 'PAYMENT_RETURN_DOCUMENT_STALE' }, cause: error })
    }
    throw error
  }
})
