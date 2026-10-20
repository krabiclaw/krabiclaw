import { HTTPError } from 'nitro'
import { executeBatch, queryFirst } from '~/server/db'
import type { CloudflareEnv } from './auth'
import { deletePageObject, listPagePosts, readPagePostRecord, type FacebookAttachment, type FacebookPagePostRecord } from './facebook-pages'
import { listMedia, readMedia, type InstagramMediaRecord } from './instagram'
import { MetaDeadline } from './meta-graph'
import { organizationEventQuery } from './organization-events'
import { publicResourceCacheInvalidationQuery } from './public-resource-cache'
import { connectedSocialTarget, parsePublishTargets, readDiscordMessage, type DiscordConnection, type PublishTarget, type SocialChannel } from './social-publication'
import { deleteMessage, discordMessageLink, listMessages, type DiscordMessage } from './discord-bot'

type ChannelTarget = Extract<PublishTarget, { channel: SocialChannel }>
export function parseChannelTarget(args: Record<string, unknown>): ChannelTarget {
  const target = parsePublishTargets([{ channel: args.channel, target_id: args.target_id, connection_revision: args.connection_revision }])[0]!
  if (target.channel === 'organization') throw new HTTPError({ statusCode: 400, statusMessage: 'Use website post tools for the organization channel.' })
  return target
}

export interface ChannelPost {
  channel: SocialChannel
  target_id: string
  provider_post_id: string
  body: string | null
  public_url: string | null
  published_at: string
  media: Array<{ provider_media_id: string | null; kind: 'image' | 'video'; public_url: string | null; thumbnail_url: string | null }>
}

function timestamp(value: string): string {
  const parsed = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (!Number.isFinite(parsed)) throw new Error('The provider post has no valid publication timestamp')
  return new Date(parsed).toISOString()
}

function facebookMedia(attachment: FacebookAttachment): ChannelPost['media'] {
  if (attachment.subattachments?.data?.length) return attachment.subattachments.data.flatMap(facebookMedia)
  const type = attachment.media_type ?? attachment.type ?? ''
  if (type.startsWith('video')) return [{ provider_media_id: attachment.target?.id ?? null, kind: 'video', public_url: attachment.media?.source ?? null, thumbnail_url: attachment.media?.image?.src ?? null }]
  if (['photo', 'cover_photo', 'profile_media'].includes(type)) return [{ provider_media_id: attachment.target?.id ?? null, kind: 'image', public_url: attachment.media?.image?.src ?? null, thumbnail_url: null }]
  return []
}
function facebookPost(record: FacebookPagePostRecord, targetId: string): ChannelPost {
  if (!record.id.startsWith(`${targetId}_`)) throw new HTTPError({ statusCode: 409, statusMessage: 'The post does not belong to the selected Facebook Page.' })
  return { channel: 'facebook', target_id: targetId, provider_post_id: record.id, body: record.message ?? null,
    public_url: record.permalink_url ?? null, published_at: timestamp(record.created_time), media: (record.attachments?.data ?? []).flatMap(facebookMedia) }
}
function discordPost(message: DiscordMessage, target: DiscordConnection): ChannelPost {
  return { channel: 'discord', target_id: target.channelId, provider_post_id: message.id, body: message.content || null,
    // The message's place in Discord, which only people who can open that channel can follow.
    public_url: discordMessageLink(target.guildId, message.channel_id, message.id), published_at: timestamp(message.timestamp),
    media: message.attachments.map(attachment => ({ provider_media_id: attachment.id, kind: attachment.content_type?.startsWith('video/') ? 'video' : 'image', public_url: attachment.url, thumbnail_url: null })) }
}
function instagramPost(record: InstagramMediaRecord, targetId: string, username: string): ChannelPost {
  if (record.username !== username) throw new HTTPError({ statusCode: 409, statusMessage: 'The media does not belong to the selected Instagram account.' })
  const items = record.media_type === 'CAROUSEL_ALBUM' ? record.children?.data : [record]
  if (!items?.length) throw new Error('Instagram returned media without its carousel items')
  return { channel: 'instagram', target_id: targetId, provider_post_id: record.id, body: record.caption ?? null,
    public_url: record.permalink ?? null, published_at: timestamp(record.timestamp), media: items.map(item => ({
      provider_media_id: item.id, kind: item.media_type === 'VIDEO' ? 'video' : 'image', public_url: item.media_url ?? null, thumbnail_url: item.thumbnail_url ?? null,
    })) }
}

/** Read provider inventory without importing documents, media or progress state. */
export async function listChannelPosts(env: CloudflareEnv, organizationId: string, input: ChannelTarget, page: { after: string | null; limit: number }) {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new HTTPError({ statusCode: 400, statusMessage: 'limit must be an integer between 1 and 100' })
  const connection = await connectedSocialTarget(env, organizationId, input)
  const deadline = new MetaDeadline(30_000)
  if (connection.channel === 'facebook') {
    const result = await listPagePosts(connection.target, page, deadline)
    return { posts: result.items.map(item => facebookPost(item, input.target_id)), next_after: result.after }
  }
  if (connection.channel === 'discord') {
    // The channel's messages newest first; only the KrabiClaw bot's are channel posts. `after` is the oldest message id read.
    const messages = await listMessages(env, connection.target.channelId, { before: page.after, limit: page.limit }, deadline)
    return {
      posts: messages.filter(message => message.author.id === env.DISCORD_CLIENT_ID).map(message => discordPost(message, connection.target)),
      next_after: messages.length === page.limit ? messages.at(-1)!.id : null,
    }
  }
  const result = await listMedia(connection.target, page, deadline)
  return { posts: result.items.map(item => instagramPost(item, input.target_id, connection.username)), next_after: result.after }
}

export async function getChannelPost(env: CloudflareEnv, organizationId: string, input: ChannelTarget, providerPostId: string): Promise<ChannelPost> {
  const connection = await connectedSocialTarget(env, organizationId, input)
  const deadline = new MetaDeadline(30_000)
  if (connection.channel === 'facebook') {
    if (!providerPostId.startsWith(`${input.target_id}_`)) throw new HTTPError({ statusCode: 400, statusMessage: 'provider_post_id must belong to the explicitly selected Page.' })
    return facebookPost(await readPagePostRecord(connection.target, providerPostId, deadline), input.target_id)
  }
  if (connection.channel === 'discord') return discordPost(await readDiscordMessage(env, connection.target, providerPostId, deadline), connection.target)
  return instagramPost(await readMedia(connection.target, providerPostId, deadline), input.target_id, connection.username)
}

/** Explicit channel deletion retains website content and the publication receipt. */
export async function deleteChannelPost(env: CloudflareEnv, organizationId: string, input: ChannelTarget, providerPostId: string, actorId: string) {
  if (input.channel === 'instagram') throw new HTTPError({ statusCode: 400, statusMessage: 'Meta media deletion requires Facebook Login. This connection uses Instagram Login; delete the post in Instagram.' })
  const connection = await connectedSocialTarget(env, organizationId, input)
  if (connection.channel === 'instagram') throw new Error('The selected channel changed')
  if (connection.channel === 'facebook' && !providerPostId.startsWith(`${input.target_id}_`)) throw new HTTPError({ statusCode: 400, statusMessage: 'provider_post_id must belong to the explicitly selected Page.' })
  const receiptQuery = `SELECT id, state FROM post_publications WHERE organization_id = ? AND channel = ? AND provider_target_id = ? AND provider_post_id = ?`
  const receiptParams = [organizationId, input.channel, input.target_id, providerPostId]
  const previous = await queryFirst<{ id: string; state: string }>(env.DB, receiptQuery, receiptParams)
  if (previous?.state === 'removed') return { channel: input.channel, target_id: input.target_id, provider_post_id: providerPostId, deleted: true, publication: previous }
  if (previous && previous.state !== 'published') throw new HTTPError({ statusCode: 409, statusMessage: 'Resolve the existing publication before deleting its provider post.' })
  const deadline = new MetaDeadline(30_000)
  if (connection.channel === 'facebook') {
    facebookPost(await readPagePostRecord(connection.target, providerPostId, deadline), input.target_id)
    await deletePageObject(connection.target, providerPostId, deadline)
  } else {
    // Only the bot's own message in the connected channel is read, and only that one is deleted.
    await readDiscordMessage(env, connection.target, providerPostId, deadline)
    await deleteMessage(env, connection.target.channelId, providerPostId, deadline)
  }
  const now = new Date().toISOString()
  await executeBatch(env.DB, [
    { query: `UPDATE post_publications SET state = 'removed', attempt_id = NULL, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE organization_id = ? AND channel = ? AND provider_target_id = ? AND provider_post_id = ? AND state IN ('published','removed')`,
      params: [now, ...receiptParams] },
    organizationEventQuery({ organizationId, actorId, eventType: 'post.channel_deleted', entityType: 'post', entityId: providerPostId, metadata: { channel: input.channel, target_id: input.target_id } }),
    publicResourceCacheInvalidationQuery(organizationId, 'channel-post-deleted'),
  ])
  const publication = await queryFirst<{ id: string; state: string }>(env.DB, receiptQuery, receiptParams)
  if (publication && publication.state !== 'removed') throw new HTTPError({ statusCode: 409, statusMessage: 'The provider deleted the post, but its publication changed. Read its receipt before continuing.' })
  return { channel: input.channel, target_id: input.target_id, provider_post_id: providerPostId, deleted: true, publication }
}
