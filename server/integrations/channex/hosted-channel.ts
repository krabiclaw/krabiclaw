import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { requireStays } from '~/server/utils/cms-capabilities'
import { channelInventory, channexList, channexRequest, type ChannexEnv } from './client'
import { object, string } from './data'

const VRBO = 'VRB'

interface HomeMapping {
  product_id: string
  property_id: string
  rate_plan_id: string
  name: string
}

const syncedHomeMappings = `SELECT m.product_id, m.property_id, m.rate_plan_id, p.name
  FROM product_channel_mappings m
  JOIN products p ON p.organization_id = m.organization_id AND p.id = m.product_id
  WHERE m.organization_id = ? AND m.provider = 'channex' AND m.enabled = 1 AND m.import_stage = 'complete'`

export async function vrboHomes(db: DbClient, env: ChannexEnv, organizationId: string) {
  await requireStays(db, organizationId)
  const homes = await queryAll<HomeMapping>(db, `${syncedHomeMappings} ORDER BY p.name, p.id`, [organizationId])
  return await Promise.all(homes.map(async (home) => {
    const channels = await channexList(env, '/channels', 'channel', {
      'filter[property_id]': home.property_id,
      'filter[channel]': VRBO,
    })
    const links = channels
      .filter(channel => channel.attributes.channel === VRBO)
      .map(channelInventory)
      .filter(channel => channel.properties.includes(home.property_id))
    const connected = links.some(channel => channel.active
      && channel.ratePlans.some(mapping => mapping.rate_plan_id === home.rate_plan_id))
    const status = connected ? 'connected' : links.length ? 'needs_review' : 'not_connected'
    return { product_id: home.product_id, name: home.name, status }
  }))
}

export async function startVrboSetup(db: DbClient, env: ChannexEnv, organizationId: string, productId: string, username: string) {
  await requireStays(db, organizationId)
  const home = await queryFirst<HomeMapping>(db, `${syncedHomeMappings} AND m.product_id = ?`, [organizationId, productId])
  if (!home) throw new HTTPError({
    statusCode: 409,
    message: 'This home needs a synced Channex property and a rate plan before you can map it to Vrbo.',
    data: { code: 'CHANNEL_MAPPING_REQUIRED', field: 'product_id' },
  })
  const url = env.CHANNEX_BASE_URL && URL.parse('/auth/exchange', env.CHANNEX_BASE_URL)
  if (!url || url.protocol !== 'https:') {
    throw new HTTPError({ statusCode: 502, message: 'Channex setup requires an HTTPS URL' })
  }
  const response = await channexRequest(env, '/auth/one_time_token', 'POST', {
    one_time_token: { property_id: home.property_id, username },
  })
  const token = string(object(response.data, 'Channex one-time access').token, 'Channex one-time token')
  url.search = new URLSearchParams({
    oauth_session_key: token,
    app_mode: 'headless',
    redirect_to: '/channels',
    property_id: home.property_id,
    channels: VRBO,
  }).toString()
  return { url: url.href }
}
