import type { CloudflareEnv } from '~/server/utils/auth'
import type { MetaDeadline } from '~/server/utils/meta-graph'

/**
 * The one HTTP boundary to Discord's API. An organization connects Discord
 * through Better Auth's Discord provider, which links the owner's Discord
 * account and, with the `bot` scope, adds the KrabiClaw bot to the server
 * they choose. The linked account's token lists the servers the owner
 * manages; the platform's bot token reads channels and sends, reads and
 * deletes the bot's own messages. No organization holds a Discord credential.
 *
 * Failures are classified the way the Meta boundary classifies its own:
 *
 * - `rejected`: Discord answered with an error. The request did not take effect.
 * - `authorization`: the bot or the linked account no longer has access.
 * - `rate_limited`: Discord answered 429; nothing was created.
 * - `transport`: no answer, a timeout, or a server error. The request may or may
 *   not have taken effect.
 * - `invalid-response`: Discord answered successfully with an unexpected shape.
 *
 * https://docs.discord.com/developers/resources/message
 */

const DISCORD_API = 'https://discord.com/api/v10'

/** View Channel, Send Messages, Embed Links, Attach Files and Read Message History: what the bot is added with. */
export const DISCORD_BOT_PERMISSIONS = 1024 + 2048 + 16384 + 32768 + 65536

/** Discord's documented limits for one message. */
export const DISCORD_CONTENT_LIMIT = 2000
export const DISCORD_FILE_LIMIT_BYTES = 20 * 1024 * 1024
export const DISCORD_ATTACHMENT_LIMIT = 10
export const DISCORD_DESCRIPTION_LIMIT = 1024
/**
 * The most attachment bytes one message carries. The Worker holds the whole
 * multipart request in memory, so this is the runtime's limit, not Discord's.
 */
export const DISCORD_REQUEST_LIMIT_BYTES = 25 * 1024 * 1024
export const DISCORD_MEDIA_TYPES: Record<string, 'image' | 'video'> = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video',
}

/** Text and announcement channels: where a post is an ordinary message. */
const MESSAGE_CHANNEL_TYPES = new Set([0, 5])

export type DiscordFailure = 'rejected' | 'authorization' | 'rate_limited' | 'transport' | 'invalid-response'

export class DiscordError extends Error {
  readonly failure: DiscordFailure
  readonly status: number | null
  readonly code: number | null
  readonly retryAfterMs: number | null
  constructor(failure: DiscordFailure, message: string, details: { status?: number | null; code?: number | null; retryAfterMs?: number | null } = {}, options?: { cause?: unknown }) {
    super(details.code ? `${message} (Discord code ${details.code})` : message, options)
    this.name = 'DiscordError'
    this.failure = failure
    this.status = details.status ?? null
    this.code = details.code ?? null
    this.retryAfterMs = details.retryAfterMs ?? null
  }

  /** Unknown Message or Unknown Channel: what was named is not there for the bot. */
  get objectMissing(): boolean { return this.code === 10008 || this.code === 10003 }
}

function botToken(env: CloudflareEnv): string {
  if (!env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN is not configured')
  return env.DISCORD_BOT_TOKEN
}

async function discordRequest<T>(path: string, init: { authorization: string; method?: string; body?: BodyInit; query?: Record<string, string>; deadline?: MetaDeadline }): Promise<T | null> {
  const url = new URL(`${DISCORD_API}${path}`)
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
  if (init.deadline && init.deadline.remaining() <= 250) throw new DiscordError('transport', 'The operation ran out of time before the Discord request could be sent')
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET', body: init.body,
      headers: { authorization: init.authorization, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) },
      // Workers support follow and manual; a redirect is refused below, never followed.
      redirect: 'manual',
    })
  } catch (error) {
    throw new DiscordError('transport', 'Discord could not be reached', {}, { cause: error })
  }
  if (response.status >= 300 && response.status < 400) throw new DiscordError('rejected', `Discord answered with a redirect (${response.status}), which is not followed`, { status: response.status })
  if (response.status === 204) return null
  const text = await response.text()
  let body: Record<string, unknown> | null
  try { body = text ? JSON.parse(text) as Record<string, unknown> : null } catch { body = null }
  if (response.ok) {
    if (!body) throw new DiscordError('invalid-response', `Discord answered ${response.status} without a JSON body`, { status: response.status })
    return body as T
  }
  const code = typeof body?.code === 'number' ? body.code : null
  const message = typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`
  if (response.status === 429) {
    const seconds = typeof body?.retry_after === 'number' ? body.retry_after : Number(response.headers.get('retry-after'))
    throw new DiscordError('rate_limited', `Discord rate limited the request: ${message}`, { status: 429, code, retryAfterMs: Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null })
  }
  if (response.status >= 500 || !body) throw new DiscordError('transport', `Discord answered ${response.status}`, { status: response.status, code })
  // Missing Access, Missing Permissions, Unknown Guild, invalid token: the bot or the account lost access.
  if (response.status === 401 || code === 50001 || code === 50013 || code === 10004) throw new DiscordError('authorization', `Discord refused access: ${message}`, { status: response.status, code })
  throw new DiscordError('rejected', `Discord refused the request: ${message}`, { status: response.status, code })
}

const asBot = (env: CloudflareEnv) => `Bot ${botToken(env)}`

export interface DiscordGuild { id: string; name: string }
export interface DiscordChannel { id: string; guild_id: string; name: string; type: number }

/**
 * The servers the linked Discord account manages that the bot is in: the
 * servers this organization can choose a channel from.
 */
export async function listConnectableGuilds(env: CloudflareEnv, userAccessToken: string): Promise<DiscordGuild[]> {
  type Guild = DiscordGuild & { owner?: boolean; permissions?: string }
  const [mine, bots] = await Promise.all([
    discordRequest<Guild[]>('/users/@me/guilds', { authorization: `Bearer ${userAccessToken}` }),
    discordRequest<Guild[]>('/users/@me/guilds', { authorization: asBot(env) }),
  ])
  if (!Array.isArray(mine) || !Array.isArray(bots)) throw new DiscordError('invalid-response', 'Discord answered without a server list')
  const botIn = new Set(bots.map(guild => guild.id))
  // Manage Server (0x20) or Administrator (0x8): who may choose where the bot posts.
  const manages = (guild: Guild) => guild.owner === true || (BigInt(guild.permissions ?? '0') & 0x28n) !== 0n
  return mine.filter(guild => manages(guild) && botIn.has(guild.id)).map(guild => ({ id: guild.id, name: guild.name }))
}

/** The server's text and announcement channels the bot can see. */
export async function listMessageChannels(env: CloudflareEnv, guildId: string): Promise<DiscordChannel[]> {
  const channels = await discordRequest<DiscordChannel[]>(`/guilds/${guildId}/channels`, { authorization: asBot(env) })
  if (!Array.isArray(channels)) throw new DiscordError('invalid-response', 'Discord answered without a channel list')
  return channels.filter(channel => MESSAGE_CHANNEL_TYPES.has(channel.type)).map(channel => ({ id: channel.id, guild_id: guildId, name: channel.name, type: channel.type }))
}

/** The channel as the bot sees it now; refused when it is no longer an ordinary message channel. */
export async function readMessageChannel(env: CloudflareEnv, channelId: string, deadline?: MetaDeadline): Promise<DiscordChannel> {
  const channel = await discordRequest<DiscordChannel>(`/channels/${channelId}`, { authorization: asBot(env), deadline })
  if (!channel?.id || !channel.guild_id) throw new DiscordError('invalid-response', 'Discord answered without the channel')
  if (!MESSAGE_CHANNEL_TYPES.has(channel.type)) throw new DiscordError('rejected', `Discord channel ${channel.name} is not a text or announcement channel`)
  return channel
}

export interface DiscordAttachment { id: string; filename: string; description?: string | null; content_type?: string | null; size: number; url: string }
export interface DiscordMessage { id: string; channel_id: string; author: { id: string }; content: string; timestamp: string; attachments: DiscordAttachment[] }

function messageOf(value: DiscordMessage | null): DiscordMessage {
  if (!value || typeof value.id !== 'string' || typeof value.channel_id !== 'string' || !value.author?.id || typeof value.timestamp !== 'string' || !Array.isArray(value.attachments)) {
    throw new DiscordError('invalid-response', 'Discord answered without the message')
  }
  return value
}

export interface DiscordFile { name: string; type: string; bytes: ArrayBuffer; description: string | null }

/**
 * Create Message as the bot. `nonce` with `enforce_nonce` makes Discord return
 * the message it already created for that nonce instead of a second one, and
 * mentions are never parsed from the content. A 429 is Discord saying nothing
 * was sent, so it is sent again after Discord's delay while the deadline allows.
 */
export async function createMessage(env: CloudflareEnv, channelId: string, input: { content: string; files: DiscordFile[]; nonce: string }, deadline: MetaDeadline): Promise<DiscordMessage> {
  const payload = {
    content: input.content,
    nonce: input.nonce,
    enforce_nonce: true,
    allowed_mentions: { parse: [] },
    attachments: input.files.map((file, index) => ({ id: index, filename: file.name, ...(file.description ? { description: file.description } : {}) })),
  }
  for (;;) {
    let body: BodyInit
    if (input.files.length) {
      const form = new FormData()
      form.set('payload_json', JSON.stringify(payload))
      input.files.forEach((file, index) => form.set(`files[${index}]`, new Blob([file.bytes], { type: file.type }), file.name))
      body = form
    } else {
      body = JSON.stringify(payload)
    }
    try {
      return messageOf(await discordRequest<DiscordMessage>(`/channels/${channelId}/messages`, { authorization: asBot(env), method: 'POST', body, deadline }))
    } catch (error) {
      if (!(error instanceof DiscordError) || error.failure !== 'rate_limited' || error.retryAfterMs === null) throw error
      if (deadline.remaining() - error.retryAfterMs < 10_000) throw error
      await new Promise(resolve => setTimeout(resolve, error.retryAfterMs!))
    }
  }
}

export async function getMessage(env: CloudflareEnv, channelId: string, messageId: string, deadline?: MetaDeadline): Promise<DiscordMessage> {
  return messageOf(await discordRequest<DiscordMessage>(`/channels/${channelId}/messages/${messageId}`, { authorization: asBot(env), deadline }))
}

/** The channel's messages, newest first; `before` pages backwards. */
export async function listMessages(env: CloudflareEnv, channelId: string, page: { before: string | null; limit: number }, deadline?: MetaDeadline): Promise<DiscordMessage[]> {
  const messages = await discordRequest<DiscordMessage[]>(`/channels/${channelId}/messages`, {
    authorization: asBot(env), deadline, query: { limit: String(page.limit), ...(page.before ? { before: page.before } : {}) },
  })
  if (!Array.isArray(messages)) throw new DiscordError('invalid-response', 'Discord answered without the channel messages')
  return messages.map(messageOf)
}

export async function deleteMessage(env: CloudflareEnv, channelId: string, messageId: string, deadline?: MetaDeadline): Promise<void> {
  await discordRequest(`/channels/${channelId}/messages/${messageId}`, { authorization: asBot(env), method: 'DELETE', deadline })
}

/** Where the message is, for the people who can open that channel. Not a public URL. */
export function discordMessageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}
