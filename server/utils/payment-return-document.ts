import { symmetricDecodeJWT, symmetricEncodeJWT } from 'better-auth/crypto'
import type { BatchQuery } from '~/server/db'
import { tokenHash } from '~/server/domain/payments/buyer'
import type { CheckoutHold } from '~/server/domain/payments/events'
import type { CheckoutPayment } from '~/server/domain/payments/intent'
import { isRecord } from '~/server/utils/type-guards'

const PURPOSE = 'blawby-payment-return'
const DOCUMENT_SECONDS = 120

type ReceiptLanguage = { locale: string; source: boolean }
type ReturnDocument = { payment: CheckoutPayment; language: ReceiptLanguage }

export async function sealPaymentReturnDocument(secret: string, host: string, claim: string, row: unknown, language: ReceiptLanguage) {
  if (!secret || !isRecord(row) || !row.buyer_user_id || typeof row.id !== 'string'
    || !row.stripe_payment_intent_id || !row.checkout_expires_at || typeof row.return_expires_at !== 'string'
    || row.return_expires_at <= new Date().toISOString() || row.return_token_hash !== await tokenHash(claim)
    || typeof row.checkout_hold !== 'string') return undefined
  const hold = JSON.parse(row.checkout_hold) as CheckoutHold
  if (!hold.session_id || !hold.conversation_id || !['active', 'converted'].includes(hold.status)) return undefined
  // The SSR snapshot contains private purchase data. Only the same site's
  // claim holder can return it, and settlement still checks the live rows.
  const payment = { ...row, return_token: null }
  return symmetricEncodeJWT({ payment, language, host }, secret, PURPOSE, DOCUMENT_SECONDS)
}

export async function openPaymentReturnDocument(secret: string, host: string, id: string, claim: string, encrypted: string): Promise<ReturnDocument | null> {
  if (!secret || encrypted.length > 65_536 || !/^[a-f0-9-]{72}$/u.test(claim)) return null
  const document = await symmetricDecodeJWT<ReturnDocument & { host: string; exp: number }>(encrypted, secret, PURPOSE)
  if (!document || !Number.isFinite(document.exp) || document.exp * 1000 <= Date.now()) return null
  const { payment, language, host: issuedHost } = document
  if (issuedHost !== host || payment.id !== id || payment.return_token_hash !== await tokenHash(claim)
    || payment.return_expires_at <= new Date().toISOString()) return null
  return { payment, language }
}

/** Resolve today's host and payment inside the same transaction that uses the snapshot. */
export function paymentReturnDocumentGuard(tenant: BatchQuery, { payment, language }: ReturnDocument): BatchQuery {
  return {
    query: `SELECT CASE WHEN EXISTS(
      SELECT 1 FROM payments p WHERE p.id=? AND p.organization_id=(${tenant.query}) AND p.organization_id=?
        AND p.buyer_user_id=? AND p.return_token_hash=? AND p.return_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND p.stripe_account_id=? AND p.stripe_payment_intent_id=? AND p.livemode=? AND p.currency=? AND p.amount=?
        AND EXISTS (SELECT 1 FROM organization_locales l WHERE l.organization_id=p.organization_id AND l.locale=?
          AND l.status='published' AND l.is_source=?)
    ) THEN 1 ELSE json_extract('{}', 'PAYMENT_RETURN_DOCUMENT_STALE') END`,
    params: [payment.id, ...tenant.params ?? [], payment.organization_id, payment.buyer_user_id, payment.return_token_hash,
      payment.stripe_account_id, payment.stripe_payment_intent_id, Number(payment.livemode), payment.currency, payment.amount,
      language.locale, Number(language.source)],
  }
}

export type AuthorizedPaymentReturnDocument = ReturnDocument & { userId: string; guard: BatchQuery }
