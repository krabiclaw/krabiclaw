import { HTTPError } from 'nitro'
import { queryAll, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { ChannexConnection } from './channel-connection'
import { requireStays } from '~/server/utils/cms-capabilities'
import { channexRequest, mapsActiveRate, propertyChannels, VRBO_CHANNEL, type ChannexEnv } from './client'
import { object, string } from './data'

export function vrboEnabled(env: { CHANNEX_VRBO_ENABLED?: string }): boolean {
  return env.CHANNEX_VRBO_ENABLED === 'true'
}

interface HomeMapping {
  product_id: string
  property_id: string | null
  rate_plan_id: string | null
  name: string
}

export async function vrboHomes(db: DbClient, env: ChannexEnv, organizationId: string) {
  await requireStays(db, organizationId)
  const homes = await queryAll<HomeMapping>(db, `SELECT p.id AS product_id, p.name, m.property_id, m.rate_plan_id
    FROM product_stay_configs h
    JOIN products p ON p.organization_id = h.organization_id AND p.id = h.product_id
    LEFT JOIN product_channel_mappings m ON m.organization_id = h.organization_id AND m.product_id = h.product_id
      AND m.provider = 'channex' AND m.import_stage IN ('draft', 'complete')
    WHERE h.organization_id = ? ORDER BY p.name, p.id`, [organizationId])
  return await Promise.all(homes.map(async (home) => {
    if (home.property_id === null || home.rate_plan_id === null) {
      return { product_id: home.product_id, name: home.name, status: 'not_connected' as const }
    }
    const ratePlanId = home.rate_plan_id
    const links = await propertyChannels(env, home.property_id, VRBO_CHANNEL)
    const connected = links.some(channel => mapsActiveRate(channel, ratePlanId))
    const status = connected ? 'connected' : links.length ? 'needs_review' : 'not_connected'
    return { product_id: home.product_id, name: home.name, status }
  }))
}

export async function startVrboSetup(db: DbClient, env: CloudflareEnv, organizationId: string, productId: string, actorId: string, username: string): Promise<{ url: string } | { preparing: true }> {
  const url = env.CHANNEX_BASE_URL && URL.parse('/auth/exchange', env.CHANNEX_BASE_URL)
  if (!url || url.protocol !== 'https:') {
    throw new HTTPError({ statusCode: 502, message: 'Channex setup requires an HTTPS URL' })
  }
  const propertyId = await new ChannexConnection(db, env, organizationId, actorId).prepareHostedProperty(productId)
  if (propertyId === null) return { preparing: true }
  const response = await channexRequest(env, '/auth/one_time_token', 'POST', {
    one_time_token: { property_id: propertyId, username },
  })
  const token = string(object(response.data, 'Channex one-time access').token, 'Channex one-time token')
  url.search = new URLSearchParams({
    oauth_session_key: token,
    app_mode: 'headless',
    redirect_to: '/channels',
    property_id: propertyId,
    channels: VRBO_CHANNEL,
  }).toString()
  return { url: url.href }
}
