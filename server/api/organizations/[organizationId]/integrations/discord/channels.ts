import { defineHandler } from 'nitro'
import { getRouterParam, readBody, type H3Event } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { linkedAccountAccessToken, requireIntegrationAccount } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { DiscordError, listConnectableGuilds, listMessageChannels, readMessageChannel } from '~/server/utils/discord-bot'
import { integrationSummary, readIntegration, storeIntegration } from '~/server/utils/organization-integrations'
import { requireOrganizationAccess } from '~/server/utils/location-access'

// GET lists the channels to choose from; POST connects the chosen one. One
// route file: the dashboard's typed $fetch is at TypeScript's depth limit
// for the number of API routes, so Discord adds none beyond its paths.
// Discord records the scopes it grants the account's token; `bot` is not one of
// them (it adds the bot to a server), so only `guilds` is checked here, and the
// bot's presence is read from Discord by listConnectableGuilds.
const GRANTED_SCOPES = ['guilds']

export default defineHandler((event) => {
  if (event.req.method === 'GET') return list(event)
  if (event.req.method === 'POST') return select(event)
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
})

/**
 * The Discord leaf: the connected channel, and the channels the KrabiClaw bot
 * can post to in the servers a linked Discord account manages.
 *
 * Which account is the caller's to say (`account_id`, one of their own linked
 * Discord accounts); without one, the account the organization already uses.
 * Only names and ids leave here.
 */
async function list(event: H3Event) {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const connection = await readIntegration(env.DB, organization.id, 'discord')
  const summary = integrationSummary(connection)
  const accountId = event.url.searchParams.get('account_id') || connection?.account_id || null
  if (!accountId) return jsonResponse({ success: true, account_id: null, connection: summary, choices: [], error: null })

  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: connection?.account_id, providerId: 'discord', scopes: GRANTED_SCOPES,
  })
  try {
    const guilds = await listConnectableGuilds(env, (await linkedAccountAccessToken(env, accountId)).accessToken)
    const choices = (await Promise.all(guilds.map(async guild => (await listMessageChannels(env, guild.id))
      .map(channel => ({ id: channel.id, name: channel.name, server: guild.name }))))).flat()
    return jsonResponse({
      success: true, account_id: accountId, connection: summary, choices,
      error: choices.length ? null : 'The KrabiClaw bot is in no server you manage, or sees no text channel there. Connect Discord again and choose the server.',
    })
  } catch (error) {
    if (!(error instanceof DiscordError)) throw error
    return jsonResponse({ account_id: accountId, connection: summary, choices: [], error: error.message }, { status: 502 })
  }
}

/**
 * The tenant's answer to "which channel". This is the only thing that writes a
 * Discord connection, so a channel is connected because somebody chose it,
 * through the linked Discord account they named, in a server that account
 * manages and the KrabiClaw bot is in.
 */
async function select(event: H3Event) {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const body = await readBody<{ account_id?: string; channel_id?: string }>(event)
  const accountId = body?.account_id?.trim()
  const channelId = body?.channel_id?.trim()
  if (!accountId || !channelId) return jsonResponse({ error: 'Choose a Discord account and channel.' }, { status: 400 })

  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  if (!await hasOrganizationEntitlement(env, organization.id, 'managed_service')) {
    return jsonResponse({ error: 'Discord requires the Growth plan.' }, { status: 403 })
  }

  const current = await readIntegration(env.DB, organization.id, 'discord')
  if (current) return jsonResponse({ error: 'Disconnect Discord before connecting again.' }, { status: 409 })
  await requireIntegrationAccount(env, accountId, {
    userId: session.user.id, currentAccountId: null, providerId: 'discord', scopes: GRANTED_SCOPES,
  })

  const channel = await readMessageChannel(env, channelId)
  const guilds = await listConnectableGuilds(env, (await linkedAccountAccessToken(env, accountId)).accessToken)
  if (!guilds.some(guild => guild.id === channel.guild_id)) return jsonResponse({ error: 'That Discord account does not manage the server of that channel.' }, { status: 400 })

  await storeIntegration(env.DB, organization.id, 'discord', {
    account_id: accountId, target_id: channel.id, target_name: channel.name,
  }, { revision: null })

  return jsonResponse({ success: true, channel_id: channel.id, channel_name: channel.name })
}
