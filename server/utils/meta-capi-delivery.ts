import { parseCookie } from 'cookie-es'
import type { DbClient } from '~/server/db'
import { execute } from '~/server/db'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { readIntegration } from './organization-integrations'
import { metaGraphRequest } from './meta-graph'
import { META_ADS_GRAPH_VERSION, formatMetaAdAccountId } from './meta-ads'
import type { OrganizationConversionInput } from './organization-conversions'

export type MetaCapiDeliveryStatus = 'sent' | 'not_configured' | 'failed' | 'skipped'

export interface MetaCapiDelivery {
  status: MetaCapiDeliveryStatus
  pixelId?: string
  eventId?: string
  detail?: string
  error?: string
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.trim().toLowerCase())
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function normalizePhoneForMeta(phone: string): string {
  return phone.replace(/\D/g, '')
}

export function mapToMetaEventName(eventName: string): string | null {
  switch (eventName) {
    case 'purchase':
    case 'order_payment':
      return 'Purchase'
    case 'booking_submit':
    case 'reservation_submit':
      return 'Schedule'
    case 'lead_submit':
    case 'contact_submit':
      return 'Lead'
    default:
      return null
  }
}

/** Resolves the pixel or dataset ID attached to the organization's Meta integration. */
export type MetaPixelResolution =
  | { kind: 'resolved'; pixelId: string; accessToken: string }
  | { kind: 'not_configured'; reason: 'no_integration' | 'no_pixel_found' }
  | { kind: 'failed'; error: string }

export async function resolveMetaPixel(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  tokenResolver = linkedAccountAccessToken,
): Promise<MetaPixelResolution> {
  const integration = await readIntegration(db, organizationId, 'meta_ads')
  if (!integration?.account_id || !integration.target_id) {
    return { kind: 'not_configured', reason: 'no_integration' }
  }

  try {
    const { accessToken } = await tokenResolver(env, integration.account_id)
    if (integration.measurement_id) {
      return { kind: 'resolved', pixelId: integration.measurement_id, accessToken }
    }

    // Discover pixels attached to the Ad Account and cache on the integration row
    const actId = formatMetaAdAccountId(integration.target_id)
    const response = await metaGraphRequest<{ data?: Array<{ id: string; name: string }> }>(
      `https://graph.facebook.com/${META_ADS_GRAPH_VERSION}/${actId}/adspixels?fields=id,name&limit=1`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )

    const pixelId = response.data?.[0]?.id
    if (!pixelId) return { kind: 'not_configured', reason: 'no_pixel_found' }

    await execute(
      db,
      `UPDATE organization_integrations SET measurement_id = ? WHERE organization_id = ? AND provider = 'meta_ads'`,
      [pixelId, organizationId],
    )

    return { kind: 'resolved', pixelId, accessToken }
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Dispatches a server-side conversion event to Meta Conversions API (CAPI).
 * Deduplicated with Meta client-side pixels via the canonical eventId.
 */
export async function deliverMetaCapiForEvent(
  env: CloudflareEnv,
  db: DbClient,
  params: {
    eventId: string
    organizationId: string
    origin: { headers: Headers } | null
    input: OrganizationConversionInput
  },
  tokenResolver = linkedAccountAccessToken,
): Promise<MetaCapiDelivery> {
  const metaEventName = mapToMetaEventName(params.input.eventName)
  if (!metaEventName) {
    return { status: 'skipped', detail: 'unmapped_event_type' }
  }

  const resolution = await resolveMetaPixel(env, db, params.organizationId, tokenResolver)
  if (resolution.kind === 'failed') {
    const outcome: MetaCapiDelivery = { status: 'failed', error: resolution.error }
    await recordMetaCapiDelivery(db, params.eventId, outcome)
    return outcome
  }
  if (resolution.kind === 'not_configured') {
    return { status: 'not_configured', detail: resolution.reason }
  }

  const { pixelId, accessToken } = resolution

  const cookieHeader = params.origin?.headers.get('cookie') ?? ''
  const cookies = cookieHeader ? parseCookie(cookieHeader) : {}
  const clientIp = params.origin?.headers.get('cf-connecting-ip')
    ?? params.origin?.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? undefined
  const clientUserAgent = params.origin?.headers.get('user-agent') ?? undefined
  const referer = params.origin?.headers.get('referer') ?? params.origin?.headers.get('origin') ?? undefined
  const actionSource = (referer && clientUserAgent) ? 'website' : 'system_generated'

  const userData: Record<string, unknown> = {}
  if (clientIp) userData.client_ip_address = clientIp
  if (clientUserAgent) userData.client_user_agent = clientUserAgent
  if (cookies._fbp) userData.fbp = cookies._fbp
  if (cookies._fbc) userData.fbc = cookies._fbc

  // Extract guest email/phone from metadata or properties when present
  const email = typeof params.input.metadata?.email === 'string'
    ? params.input.metadata.email
    : typeof params.input.properties?.email === 'string'
      ? params.input.properties.email
      : undefined
  const phone = typeof params.input.metadata?.phone === 'string'
    ? params.input.metadata.phone
    : typeof params.input.properties?.phone === 'string'
      ? params.input.properties.phone
      : undefined

  if (email) userData.em = [await sha256Hex(email)]
  if (phone) userData.ph = [await sha256Hex(normalizePhoneForMeta(phone))]

  const customData: Record<string, unknown> = {}
  if (params.input.value?.amount_minor !== undefined) {
    customData.value = params.input.value.amount_minor / 100
    customData.currency = params.input.value.currency || 'USD'
  }

  const eventPayload = {
    data: [
      {
        event_name: metaEventName,
        event_time: Math.floor((params.input.occurredAt ? Date.parse(params.input.occurredAt) : Date.now()) / 1000),
        event_id: params.eventId,
        action_source: actionSource,
        event_source_url: referer,
        user_data: userData,
        custom_data: Object.keys(customData).length > 0 ? customData : undefined,
      },
    ],
  }

  try {
    await metaGraphRequest(
      `https://graph.facebook.com/${META_ADS_GRAPH_VERSION}/${pixelId}/events`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(eventPayload),
      },
    )

    const outcome: MetaCapiDelivery = { status: 'sent', pixelId, eventId: params.eventId }
    await recordMetaCapiDelivery(db, params.eventId, outcome)
    return outcome
  } catch (error) {
    const outcome: MetaCapiDelivery = {
      status: 'failed',
      pixelId,
      eventId: params.eventId,
      error: error instanceof Error ? error.message : String(error),
    }
    await recordMetaCapiDelivery(db, params.eventId, outcome)
    return outcome
  }
}

async function recordMetaCapiDelivery(db: DbClient, eventId: string, delivery: MetaCapiDelivery): Promise<void> {
  await execute(
    db,
    `UPDATE analytics_events SET payload_json = json_set(payload_json, '$.meta_capi_delivery', json(?)) WHERE id = ?`,
    [JSON.stringify(delivery), eventId],
  )
}
