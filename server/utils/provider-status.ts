import { getResendClient } from '~/server/utils/resend'

const GRAPH_API_VERSION = 'v25.0'

interface ProviderStatusEnv {
  WHATSAPP_PHONE_NUMBER_ID?: string
  WHATSAPP_ACCESS_TOKEN?: string
  RESEND_API_KEY?: string
}

export interface ProviderStatusResult {
  ok: boolean
  detail: string
}

/** Read-only check: confirms the WhatsApp number + access token are live. Sends no message. */
export async function getWhatsAppProviderStatus(env: ProviderStatusEnv): Promise<ProviderStatusResult> {
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = env.WHATSAPP_ACCESS_TOKEN
  if (!phoneNumberId || !accessToken) {
    return { ok: false, detail: 'WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not configured' }
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}?fields=display_phone_number,quality_rating,code_verification_status`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    const body = await response.json() as { id?: string; error?: { message?: string } }
    if (!response.ok || body.error) {
      return { ok: false, detail: body.error?.message ?? `HTTP ${response.status}` }
    }
    return { ok: true, detail: `connected (${body.id ?? phoneNumberId})` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Network error' }
  }
}

/** Read-only check: confirms the Resend API key is live and at least one domain is verified. Sends no email. */
export async function getResendProviderStatus(env: ProviderStatusEnv): Promise<ProviderStatusResult> {
  const apiKey = env.RESEND_API_KEY
  if (!apiKey) {
    return { ok: false, detail: 'RESEND_API_KEY not configured' }
  }

  const response = await getResendClient({ RESEND_API_KEY: apiKey }).domains.list()
  if (response.error) {
    return { ok: false, detail: `${response.error.statusCode ?? 'no response'} ${response.error.name}: ${response.error.message}` }
  }
  const verifiedCount = response.data.data.filter(domain => domain.status === 'verified').length
  if (verifiedCount === 0) {
    return { ok: false, detail: 'No verified Resend domains' }
  }
  return { ok: true, detail: `${verifiedCount} verified domain(s)` }
}
