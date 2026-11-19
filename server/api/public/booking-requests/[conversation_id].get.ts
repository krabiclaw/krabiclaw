import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { executeBatch } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { conversationIdParam } from '~/server/utils/conversation-request'
import { prepareGuestBookingReceipt, type GuestReceiptRead } from '~/server/utils/guest-booking-receipt'
import { assertExactCanonicalLocale, readPublicOrganizationLanguage, readPublicSourceLocale } from '~/server/utils/localization'
import { readBearerToken } from '~/server/utils/reservation-cancel-token'

/** The emailed capability can still read the receipt after it has been spent on a cancellation. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const requestId = conversationIdParam(event)
  const token = readBearerToken(event.req.headers.get('authorization'))
  if (!organizationId || !token) return jsonResponse({ error: 'Missing required parameters' }, { status: 400 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const preloaded = event.context.guestReceipt as GuestReceiptRead | undefined
  const requested = getQuery(event).locale
  const source = await readPublicSourceLocale(event, env.DB, organizationId)
  const language = await readPublicOrganizationLanguage(event, env.DB, organizationId, assertExactCanonicalLocale(requested ?? source.locale), source)
  const localized = language.source ? undefined : language.locale
  const prepared = preloaded?.requestId === requestId && (preloaded.locale === localized || language.source) ? preloaded : undefined
  const plan = prepared?.plan ?? await prepareGuestBookingReceipt({ query: '?', params: [organizationId] }, requestId, token, localized)
  const rows = prepared?.rows ?? await executeBatch(env.DB, plan.queries, { operation: 'Read guest booking receipt' })
  const booking = await plan.read(env.DB, env, organizationId, language.locale, language.source, rows)
  if (!booking) return jsonResponse({ error: 'Booking not found' }, { status: 404 })
  return jsonResponse({ success: true, booking }, { headers: { 'cache-control': 'private, no-store' } })
})
