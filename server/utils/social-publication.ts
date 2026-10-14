import { HTTPError } from 'nitro'
import { executeBatch, execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { linkedAccountAccessToken, readLinkedAccount, type CloudflareEnv } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { getPost, postPayloadFingerprint, type Post, type PostMedia } from '~/server/utils/post-management'
import { providerCaption } from '~/shared/posts'
import { MetaDeadline, MetaGraphError } from '~/server/utils/meta-graph'
import {
  createUnpublishedPhoto, createVideo, deletePageObject, facebookPageToken, finishReel, isFacebookReel, listLinkedFacebookPages,
  publishPagePost, readPagePost, readVideo, startReel, uploadReelFromUrl, type FacebookPageTarget,
} from '~/server/utils/facebook-pages'
import {
  createMediaContainer, getInstagramAccount, instagramAccessToken, publishContainer, readContainerStatus, readMedia, type InstagramTarget,
} from '~/server/utils/instagram'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { readIntegration } from '~/server/utils/organization-integrations'
import {
  createMessage, discordMessageLink, DiscordError, getMessage, listMessages, readMessageChannel,
  DISCORD_ATTACHMENT_LIMIT, DISCORD_CONTENT_LIMIT, DISCORD_DESCRIPTION_LIMIT, DISCORD_FILE_LIMIT_BYTES, DISCORD_MEDIA_TYPES, DISCORD_REQUEST_LIMIT_BYTES,
  type DiscordFile, type DiscordMessage,
} from '~/server/utils/discord-bot'

/**
 * Publishing a post to its website and to the Facebook Page, Instagram
 * professional account and Discord channel the organization connected — one
 * operation, shared by MCP and the dashboard, returning one result.
 *
 * External publication uses Meta's own primitives: prepare what can be
 * prepared without going public, save its identity, then make the one call
 * that publishes it. For Page photos that is the post attaching them; for an
 * Instagram container it is media_publish; for a Facebook Reel it is the
 * upload session's finish; for any other Facebook video it is the upload
 * itself. The saved identity is what makes a retry safe: a later call resumes
 * or reads the object it already has instead of creating another public post. There is no
 * scheduler and no queue; an invocation does what fits in its budget and says
 * what it left.
 *
 * Discord has nothing to prepare: the KrabiClaw bot, added to the server when
 * the owner linked Discord through Better Auth, creates the message in the
 * chosen channel. Discord answers with the message it saved, and the
 * publication's nonce makes a repeated create return that same message.
 */

export const PUBLISH_BUDGET_MS = 30_000
/** A preparation claim older than this belongs to an invocation that is gone. */
export const CLAIM_STALE_MS = 60_000

export type SocialChannel = 'facebook' | 'instagram' | 'discord'
export const SOCIAL_CHANNELS: readonly SocialChannel[] = ['facebook', 'instagram', 'discord']
const CHANNEL_NAMES: Record<SocialChannel, string> = { facebook: 'Facebook', instagram: 'Instagram', discord: 'Discord' }
export type PublishTarget =
  | { channel: 'organization' }
  | { channel: SocialChannel; target_id: string; connection_revision: string }

export type PublishOutcomeStatus = 'published' | 'already_published' | 'processing' | 'failed' | 'unknown' | 'skipped'

export interface PublishOutcome {
  channel: 'organization' | SocialChannel
  target_id: string
  status: PublishOutcomeStatus
  publication_id?: string
  public_url?: string | null
  code?: string
  message?: string
}

export interface PublishResult {
  ok: boolean
  post_id: string
  updated_at: string
  outcomes: PublishOutcome[]
}

// ── Targets and connections ───────────────────────────────────────────────

export function parsePublishTargets(value: unknown): PublishTarget[] {
  const fail = (message: string): never => { throw new HTTPError({ statusCode: 400, statusMessage: message }) }
  if (!Array.isArray(value) || value.length < 1 || value.length > 1 + SOCIAL_CHANNELS.length) fail(`targets must list one to ${1 + SOCIAL_CHANNELS.length} destinations`)
  const targets = (value as unknown[]).map((item, index): PublishTarget => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`targets[${index}] must be an object`)
    const record = item as Record<string, unknown>
    if (record.channel === 'organization') {
      if (Object.keys(record).some(key => key !== 'channel')) fail(`targets[${index}]: the website target takes only its channel`)
      return { channel: 'organization' }
    }
    if (!SOCIAL_CHANNELS.includes(record.channel as SocialChannel)) fail(`targets[${index}].channel must be organization, ${SOCIAL_CHANNELS.join(', ')}`)
    if (typeof record.target_id !== 'string' || !record.target_id.trim()) fail(`targets[${index}].target_id is required; read it from get_social_connections`)
    if (typeof record.connection_revision !== 'string' || !record.connection_revision.trim()) fail(`targets[${index}].connection_revision is required; read it from get_social_connections`)
    if (Object.keys(record).some(key => !['channel', 'target_id', 'connection_revision'].includes(key))) fail(`targets[${index}] has an unknown field`)
    return { channel: record.channel as SocialChannel, target_id: record.target_id as string, connection_revision: record.connection_revision as string }
  })
  if (new Set(targets.map(target => target.channel)).size !== targets.length) fail('targets names a channel more than once')
  return targets
}

interface ConnectionRead {
  channel: SocialChannel
  connected: boolean
  targetId: string | null
  targetName: string | null
  revision: string | null
  accountId: string | null
}

async function readConnection(env: CloudflareEnv, organizationId: string, channel: SocialChannel): Promise<ConnectionRead> {
  const connection = await readIntegration(env.DB, organizationId, channel)
  return {
    channel, connected: Boolean(connection), targetId: connection?.target_id ?? null,
    targetName: connection ? (channel === 'instagram' ? `@${connection.target_name}` : connection.target_name) : null,
    revision: connection?.revision ?? null, accountId: connection?.account_id ?? null,
  }
}

const SUPPORTED_FORMATS: Record<SocialChannel, string[]> = {
  facebook: ['text', 'link', 'image', 'multiple_images', 'video'],
  instagram: ['image', 'carousel', 'mixed_carousel', 'video_reel'],
  discord: ['text', 'link', 'image', 'multiple_images', 'video', 'mixed_media'],
}

const SUPPORTED_OPERATIONS: Record<SocialChannel, Array<'list' | 'read' | 'publish' | 'delete'>> = {
  facebook: ['list', 'read', 'publish', 'delete'],
  instagram: ['list', 'read', 'publish'],
  discord: ['list', 'read', 'publish', 'delete'],
}

const NOT_CONNECTED: Record<SocialChannel, string> = {
  facebook: 'No Facebook Page is connected.',
  instagram: 'No Instagram professional account is connected.',
  discord: 'No Discord channel is connected.',
}

export interface DiscordConnection { channelId: string; guildId: string }

/**
 * The connected channel as the bot sees it now. A channel the bot can no
 * longer see, or that stopped being a text or announcement channel, needs a
 * new connection; nothing is sent until then.
 */
async function discordTargetFor(env: CloudflareEnv, connection: ConnectionRead, deadline?: MetaDeadline): Promise<DiscordConnection> {
  if (connection.channel !== 'discord' || !connection.connected || !connection.targetId) throw new Error('The Discord connection is incomplete. Connect Discord again.')
  const channel = await readMessageChannel(env, connection.targetId, deadline)
  return { channelId: channel.id, guildId: channel.guild_id }
}

/**
 * What the organization can publish to, exactly: each channel's selected
 * target and the revision a publish call must present, what formats it takes,
 * what stands in the way, and where a person connects
 * it. Never a token.
 */
export async function getSocialConnections(env: CloudflareEnv, organizationId: string, links: { dashboardBase: string }) {
  const entitled = await hasOrganizationEntitlement(env, organizationId, 'managed_service')
  const channels = await Promise.all(SOCIAL_CHANNELS.map(async (channel) => {
    const connection = await readConnection(env, organizationId, channel)
    const problems: Array<{ code: string; message: string }> = []
    if (!entitled) problems.push({ code: 'growth_plan_required', message: GROWTH_PLAN_REQUIRED })
    if (!connection.connected) problems.push({ code: 'not_connected', message: NOT_CONNECTED[channel] })
    else if (!connection.accountId || !(await readLinkedAccount(env, connection.accountId))) problems.push({ code: 'account_unlinked', message: `The ${channel} account this connection was made through is no longer linked. Connect it again.` })
    else {
      const access = await currentAccessProblem(env, connection)
      if (access) problems.push(access)
    }
    return {
      channel,
      connected: connection.connected,
      target_id: connection.targetId,
      target_name: connection.targetName,
      connection_revision: connection.revision,
      supported_formats: SUPPORTED_FORMATS[channel],
      supported_operations: SUPPORTED_OPERATIONS[channel],
      deletion_unavailable_reason: channel === 'instagram' ? 'Meta supports media deletion only with Facebook Login; this account uses Instagram Login. Delete it in Instagram.' : null,
      problems,
      connect_url: `${links.dashboardBase}/integrations/${channel}`,
    }
  }))
  return { website: { channel: 'organization' as const, target_id: organizationId, label: 'Website' }, channels }
}

const GROWTH_PLAN_REQUIRED = 'Publishing to Facebook, Instagram and Discord requires the Growth plan.'

/**
 * Whether the saved connection still works, asked of Meta now: Facebook lists
 * the Pages assigned to the linked system user, Instagram reads the account
 * the token belongs to. A rejection from Meta is a connection problem the
 * owner can act on; any other failure is not, and is thrown.
 */
async function currentAccessProblem(env: CloudflareEnv, connection: ConnectionRead): Promise<{ code: string; message: string } | null> {
  try {
    if (connection.channel === 'discord') {
      // The bot still sees the connected channel as a text or announcement channel.
      await discordTargetFor(env, connection)
      return null
    }
    if (connection.channel === 'facebook') {
      const pages = await listLinkedFacebookPages(env, connection.accountId!)
      if (!pages.some(page => page.id === connection.targetId)) {
        return { code: 'page_not_assigned', message: `The linked Facebook system user has no assignment for Page ${connection.targetName}. Check its delegated Page access, or connect Facebook again.` }
      }
      return null
    }
    // The token as stored: a read never renews or writes it.
    const account = await getInstagramAccount((await linkedAccountAccessToken(env, connection.accountId!)).accessToken)
    if (account.id !== connection.targetId) {
      return { code: 'account_mismatch', message: `The linked Instagram login now belongs to @${account.username}, not ${connection.targetName}. Connect Instagram again.` }
    }
    return null
  } catch (error) {
    if (error instanceof MetaGraphError || error instanceof DiscordError) return failureOf(error)
    throw error
  }
}

/** Resolve exactly the connected target named by the caller. No default channel or account. */
export async function connectedSocialTarget(env: CloudflareEnv, organizationId: string, target: Extract<PublishTarget, { channel: SocialChannel }>) {
  if (!(await hasOrganizationEntitlement(env, organizationId, 'managed_service'))) throw new HTTPError({ statusCode: 403, statusMessage: 'Channel management requires the Growth plan.' })
  const connection = await readConnection(env, organizationId, target.channel)
  if (!connection.connected) throw new HTTPError({ statusCode: 409, statusMessage: NOT_CONNECTED[target.channel] })
  if (connection.targetId !== target.target_id || connection.revision !== target.connection_revision) throw new HTTPError({ statusCode: 409, statusMessage: 'The channel connection changed; read get_social_connections again.' })
  if (target.channel === 'facebook') return { channel: 'facebook' as const, target: await facebookTargetFor(env, connection) }
  if (target.channel === 'discord') return { channel: 'discord' as const, target: await discordTargetFor(env, connection) }
  if (!connection.targetName?.startsWith('@') || connection.targetName.length < 2) throw new Error('The Instagram connection has no username. Connect Instagram again.')
  return { channel: 'instagram' as const, target: await instagramTargetFor(env, connection), username: connection.targetName.slice(1) }
}

// ── Payload validation ────────────────────────────────────────────────────

interface AssetFacts { asset_id: string; mime_type: string | null; file_size: number | null; duration: number | null; kind: 'image' | 'video'; public_url: string; alt_text: string | null }

async function assetFacts(db: DbClient, organizationId: string, media: PostMedia[]): Promise<AssetFacts[]> {
  if (!media.length) return []
  const rows = await queryAll<{ id: string; file_size: number | null }>(db, 'SELECT id, file_size FROM media_assets WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))',
    [organizationId, d1JsonStringSet(media.map(item => item.asset_id))])
  const sizes = new Map(rows.map(row => [row.id, row.file_size]))
  return media.map(item => ({ asset_id: item.asset_id, mime_type: item.mime_type, file_size: sizes.get(item.asset_id) ?? null, duration: item.duration, kind: item.kind, public_url: item.public_url, alt_text: item.alt_text }))
}

const hashtagCount = (text: string) => (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length
const mentionCount = (text: string) => (text.match(/(^|\s)@[\w.]+/g) ?? []).length

/** The first rule this post breaks for this channel, precisely; null when it can be sent. */
export function formatViolation(channel: SocialChannel, caption: string, assets: AssetFacts[]): { code: string; message: string } | null {
  const images = assets.filter(asset => asset.kind === 'image')
  const videos = assets.filter(asset => asset.kind === 'video')
  const unreachable = assets.find(asset => !/^https:\/\//.test(asset.public_url))
  if (unreachable) return { code: 'media_not_public', message: `${channel} media is fetched from its public https URL; asset ${unreachable.asset_id} is at ${unreachable.public_url}` }
  if (channel === 'discord') {
    // UTF-16 code units: never fewer than the characters Discord counts, so nothing over its limit is sent.
    if (caption.length > DISCORD_CONTENT_LIMIT) return { code: 'caption_too_long', message: `A Discord message is limited to ${DISCORD_CONTENT_LIMIT} characters; this post's text and call to action are ${caption.length}. Shorten it; it is not truncated or split.` }
    if (assets.length > DISCORD_ATTACHMENT_LIMIT) return { code: 'too_many_media', message: `A Discord message carries at most ${DISCORD_ATTACHMENT_LIMIT} attachments; this post has ${assets.length}` }
    const unsupported = assets.find(asset => DISCORD_MEDIA_TYPES[asset.mime_type ?? ''] !== asset.kind)
    if (unsupported) return { code: 'unsupported_media_type', message: `Discord attachments here are JPEG, PNG, GIF or WebP images and MP4, MOV or WebM video; asset ${unsupported.asset_id} is ${unsupported.mime_type ?? 'of unknown type'}` }
    const large = assets.find(asset => (asset.file_size ?? 0) > DISCORD_FILE_LIMIT_BYTES)
    if (large) return { code: 'media_too_large', message: `Discord accepts files up to 20 MiB; asset ${large.asset_id} is ${((large.file_size ?? 0) / 1024 / 1024).toFixed(1)} MiB` }
    const total = assets.reduce((sum, asset) => sum + (asset.file_size ?? 0), 0)
    if (total > DISCORD_REQUEST_LIMIT_BYTES) return { code: 'media_too_large', message: `One Discord message carries at most 25 MiB of attachments; this post's media is ${(total / 1024 / 1024).toFixed(1)} MiB` }
    const described = assets.find(asset => (asset.alt_text?.length ?? 0) > DISCORD_DESCRIPTION_LIMIT)
    if (described) return { code: 'alt_text_too_long', message: `Discord attachment descriptions are limited to ${DISCORD_DESCRIPTION_LIMIT} characters; asset ${described.asset_id}'s alt text is ${described.alt_text!.length}` }
    return null
  }
  if (channel === 'facebook') {
    if (caption.length > 63_206) return { code: 'caption_too_long', message: `Facebook text is limited to 63206 characters; this is ${caption.length}` }
    if (videos.length && (videos.length > 1 || images.length)) return { code: 'unsupported_combination', message: 'A Facebook post carries photos or one video, not both and not several videos' }
    const image = images.find(asset => !['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff'].includes(asset.mime_type ?? ''))
    if (image) return { code: 'unsupported_media_type', message: `Facebook photos are JPEG, PNG, GIF, BMP or TIFF; asset ${image.asset_id} is ${image.mime_type ?? 'of unknown type'}` }
    const large = images.find(asset => (asset.file_size ?? 0) > 10 * 1024 * 1024)
    if (large) return { code: 'media_too_large', message: `Facebook photos are limited to 10 MB; asset ${large.asset_id} is ${Math.ceil((large.file_size ?? 0) / 1024 / 1024)} MB` }
    const video = videos.find(asset => !['video/mp4', 'video/quicktime'].includes(asset.mime_type ?? ''))
    if (video) return { code: 'unsupported_media_type', message: `Facebook video is MP4 or MOV; asset ${video.asset_id} is ${video.mime_type ?? 'of unknown type'}` }
    return null
  }
  if (!assets.length) return { code: 'media_required', message: 'Instagram posts need at least one image or video' }
  if (assets.length > 10) return { code: 'too_many_media', message: `An Instagram carousel holds at most 10 items; this post has ${assets.length}` }
  if (caption.length > 2200) return { code: 'caption_too_long', message: `Instagram captions are limited to 2200 characters; this is ${caption.length}` }
  if (hashtagCount(caption) > 30) return { code: 'too_many_hashtags', message: `Instagram allows 30 hashtags; this caption has ${hashtagCount(caption)}` }
  if (mentionCount(caption) > 20) return { code: 'too_many_mentions', message: `Instagram allows 20 @mentions; this caption has ${mentionCount(caption)}` }
  const image = images.find(asset => asset.mime_type !== 'image/jpeg')
  if (image) return { code: 'unsupported_media_type', message: `Instagram accepts JPEG images only; asset ${image.asset_id} is ${image.mime_type ?? 'of unknown type'}` }
  const largeImage = images.find(asset => (asset.file_size ?? 0) > 8 * 1024 * 1024)
  if (largeImage) return { code: 'media_too_large', message: `Instagram images are limited to 8 MB; asset ${largeImage.asset_id} is ${Math.ceil((largeImage.file_size ?? 0) / 1024 / 1024)} MB` }
  const video = videos.find(asset => !['video/mp4', 'video/quicktime'].includes(asset.mime_type ?? ''))
  if (video) return { code: 'unsupported_media_type', message: `Instagram video is MP4 or MOV; asset ${video.asset_id} is ${video.mime_type ?? 'of unknown type'}` }
  const [minimum, maximum] = assets.length > 1 ? [3, 60] : [3, 900]
  const outOfRange = videos.find(asset => asset.duration === null || asset.duration < minimum || asset.duration > maximum)
  if (outOfRange) return { code: 'video_duration', message: `Instagram ${assets.length > 1 ? 'carousel videos' : 'Reels'} run ${minimum}–${maximum} seconds; asset ${outOfRange.asset_id} is ${outOfRange.duration === null ? 'of unrecorded length' : `${outOfRange.duration} seconds`}` }
  return null
}

function publishable(post: Pick<Post, 'body' | 'media' | 'call_to_action'>): boolean {
  return Boolean(post.body?.trim()) || post.media.length > 0 || post.call_to_action !== null
}

// ── The publication relation ──────────────────────────────────────────────

interface PublicationRecord {
  id: string
  organization_id: string
  post_id: string | null
  channel: SocialChannel
  provider_app_id: string
  provider_subject_id: string
  provider_target_id: string
  state: 'preparing' | 'publishing' | 'published' | 'failed' | 'unknown' | 'removed'
  provider_post_id: string | null
  provider_permalink: string | null
  provider_handles_json: string
  payload_hash: string | null
  attempt_id: string | null
  error_code: string | null
  error_message: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

/** Native identities a publication saved, by channel. Identifiers only. */
interface Handles {
  photo_ids?: string[]
  post_id?: string
  video_id?: string
  children?: string[]
  container_id?: string
}

async function readPublication(db: DbClient, organizationId: string, where: { id: string } | { postId: string; channel: SocialChannel }) {
  return await queryFirst<PublicationRecord>(db, 'id' in where
    ? 'SELECT * FROM post_publications WHERE organization_id = ? AND id = ?'
    : 'SELECT * FROM post_publications WHERE organization_id = ? AND post_id = ? AND channel = ?',
  'id' in where ? [organizationId, where.id] : [organizationId, where.postId, where.channel])
}

const nowIso = () => new Date().toISOString()

class ClaimLost extends Error {}

/** Every update an invocation makes is fenced by its claim; losing it stops the invocation. */
function claimed(db: DbClient, publicationId: string, attemptId: string) {
  const write = async (sets: string, params: unknown[], states: readonly string[] = ['preparing']) => {
    const result = await execute(db, `UPDATE post_publications SET ${sets}, updated_at = ? WHERE id = ? AND attempt_id = ? AND state IN (SELECT value FROM json_each(?))`,
      [...params, nowIso(), publicationId, attemptId, JSON.stringify(states)])
    if (Number(result.meta?.changes ?? 0) !== 1) throw new ClaimLost(`Publication ${publicationId} is no longer claimed by this invocation`)
  }
  return {
    saveHandles: (handles: Handles, providerPostId?: string) =>
      write('provider_handles_json = ?, provider_post_id = COALESCE(?, provider_post_id)', [JSON.stringify(handles), providerPostId ?? null]),
    /** The prepared object named as the provider post is gone; the row stops naming it. */
    forgetProviderPost: (handles: Handles) => write('provider_handles_json = ?, provider_post_id = NULL', [JSON.stringify(handles)]),
    /** The boundary: after this commits, an interruption is `unknown`, never a retryable failure. */
    beginFinal: () => write("state = 'publishing'", []),
    published: (input: { providerPostId: string | null; permalink: string | null; publishedAt: string; handles: Handles }) =>
      write("state = 'published', attempt_id = NULL, provider_post_id = COALESCE(?, provider_post_id), provider_permalink = ?, published_at = ?, provider_handles_json = ?, error_code = NULL, error_message = NULL",
        [input.providerPostId, validPermalink(input.permalink), input.publishedAt, JSON.stringify(input.handles)], ['preparing', 'publishing']),
    failed: (code: string, message: string, handles: Handles) =>
      write("state = 'failed', attempt_id = NULL, error_code = ?, error_message = ?, provider_handles_json = ?", [code, message.slice(0, 1000), JSON.stringify(handles)], ['preparing', 'publishing']),
    unknown: (code: string, message: string) =>
      write("state = 'unknown', attempt_id = NULL, error_code = ?, error_message = ?", [code, message.slice(0, 1000)], ['publishing']),
    /** Hand the saved preparation to the next call: nothing is public, and nothing is lost. */
    release: (states: readonly string[] = ['preparing']) => write("state = 'preparing', attempt_id = NULL", [], states),
  }
}

/** Meta's times (`2026-09-28T10:00:00+0000`) as the canonical UTC instant the schema stores; now when Meta gave none. */
function instantOf(value: string | null | undefined): string {
  const parsed = value ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : nowIso()
}

/** A permalink is stored only as Meta returned it, and only when it is a public https URL. */
function validPermalink(value: string | null): string | null {
  if (!value) return null
  try { return new URL(value).protocol === 'https:' ? value : null } catch { return null }
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

// ── Channel operations ────────────────────────────────────────────────────

interface ChannelContext {
  db: DbClient
  env: CloudflareEnv
  organizationId: string
  post: Post
  caption: string
  publication: PublicationRecord
  attemptId: string
  handles: Handles
  deadline: MetaDeadline
}

type ChannelResult = PublishOutcome

async function facebookTargetFor(env: CloudflareEnv, connection: ConnectionRead): Promise<FacebookPageTarget> {
  if (connection.channel !== 'facebook' || !connection.connected || !connection.targetId || !connection.accountId || !connection.targetName) throw new Error('The Facebook connection is incomplete. Connect Facebook again.')
  return { pageId: connection.targetId, pageToken: await facebookPageToken(env, { target_id: connection.targetId, account_id: connection.accountId, target_name: connection.targetName }) }
}

async function instagramTargetFor(env: CloudflareEnv, connection: ConnectionRead): Promise<InstagramTarget> {
  if (connection.channel !== 'instagram' || !connection.connected || !connection.targetId || !connection.accountId) throw new Error('The Instagram connection is incomplete. Connect Instagram again.')
  return { userId: connection.targetId, accessToken: await instagramAccessToken(env, connection.accountId) }
}

/**
 * The final call starts only with time left for it and its read-back; with
 * less, the saved preparation is handed to the next call instead, so a budget
 * that ran out is `processing`, never an `unknown` the owner has to resolve.
 */
const FINAL_RESERVE_MS = 15_000
async function deferFinalWithoutTime(context: ChannelContext, fence: ReturnType<typeof claimed>): Promise<ChannelResult | null> {
  if (context.deadline.remaining() >= FINAL_RESERVE_MS) return null
  await fence.release()
  return outcome(context, 'processing', { code: 'budget_exhausted', message: `${context.publication.channel} is prepared; call publish_post again to publish this same post.` })
}

function outcome(context: ChannelContext, status: PublishOutcomeStatus, extra: Partial<PublishOutcome> = {}): ChannelResult {
  return { channel: context.publication.channel, target_id: context.publication.provider_target_id, status, publication_id: context.publication.id, ...extra }
}

/** The provider's failure, as publications and channel tools report it. */
export function failureOf(error: unknown): { code: string; message: string } {
  if (error instanceof MetaGraphError || error instanceof DiscordError) {
    if (error instanceof DiscordError && error.failure === 'rate_limited') {
      return { code: 'rate_limited', message: `${error.message}. Nothing was sent; try again${error.retryAfterMs !== null ? ` in ${Math.ceil(error.retryAfterMs / 1000)} seconds` : ' later'}.` }
    }
    return { code: error.failure === 'authorization' ? 'connection_error' : error.failure === 'transport' ? 'provider_unreachable' : 'provider_rejected',
      message: error.message }
  }
  return { code: 'provider_rejected', message: messageOf(error) }
}

/** The provider answered the request with an error, so it did not take effect. */
const providerRefused = (error: unknown) => (error instanceof MetaGraphError || error instanceof DiscordError) && error.failure !== 'transport'

async function publishToFacebook(context: ChannelContext, target: FacebookPageTarget): Promise<ChannelResult> {
  const { post, handles, deadline } = context
  const fence = claimed(context.db, context.publication.id, context.attemptId)
  const video = post.media.find(item => item.kind === 'video')
  if (video) return await publishVideoToFacebook(context, target, fence, video)
  // An unpublished feed post an earlier version prepared can never be
  // published; it goes, and the photos it carried go with it — Meta refuses
  // them as `attached_media` afterwards — so the real post gets new ones.
  if (handles.post_id) {
    try {
      await deletePageObject(target, handles.post_id, deadline)
    } catch (error) {
      // Already gone is the state this wants.
      if (!(error instanceof MetaGraphError && error.objectMissing)) throw error
    }
    delete handles.post_id
    delete handles.photo_ids
    await fence.forgetProviderPost(handles)
  }
  const images = post.media.filter(item => item.kind === 'image')
  handles.photo_ids ??= []
  for (const [index, image] of images.entries()) {
    if (handles.photo_ids[index]) continue
    handles.photo_ids[index] = await createUnpublishedPhoto(target, { url: image.public_url, altText: image.alt_text }, deadline)
    await fence.saveHandles(handles)
  }
  const deferred = await deferFinalWithoutTime(context, fence)
  if (deferred) return deferred
  await fence.beginFinal()
  const link = post.call_to_action && /^https?:/.test(post.call_to_action.url) ? post.call_to_action.url : null
  let postId: string | null = null
  return await finalize(context, async () => {
    postId = await publishPagePost(target, { message: context.caption, link, photoIds: handles.photo_ids! }, deadline)
    return postId
  }, async () => {
    // Without the answer there is no id to read: what happened is unknown.
    if (!postId) throw new Error('Facebook did not answer with the post it created')
    const read = await readPagePost(target, postId, deadline)
    // Calling again would create a second post: a created post is never sent again.
    return { published: read.isPublished, providerPostId: read.id, permalink: read.permalink, publishedAt: read.createdTime, retryable: false, createsAnother: true }
  })
}

/**
 * One Facebook video, published by Meta's own final call: a Reel's finish,
 * which answers with the Page post, or a published upload, which Facebook
 * posts once it has processed it. Meta's answer is the publication. A session
 * an earlier call left unfinished is never public; each call runs its own.
 */
async function publishVideoToFacebook(context: ChannelContext, target: FacebookPageTarget, fence: ReturnType<typeof claimed>, video: PostMedia): Promise<ChannelResult> {
  const { post, handles, deadline } = context
  const deferred = await deferFinalWithoutTime(context, fence)
  if (deferred) return deferred
  if (isFacebookReel(video)) {
    handles.video_id = await startReel(target, deadline)
    await uploadReelFromUrl(target, handles.video_id, video.public_url, deadline)
    await fence.saveHandles(handles)
    await fence.beginFinal()
    const { postId } = await finishReel(target, handles.video_id, { description: context.caption, title: post.title }, deadline)
    await fence.published({ providerPostId: postId ?? handles.video_id, permalink: null, publishedAt: nowIso(), handles })
    return outcome(context, 'published', { public_url: null })
  }
  await fence.beginFinal()
  handles.video_id = await createVideo(target, { fileUrl: video.public_url, description: context.caption, title: post.title }, deadline)
  await fence.published({ providerPostId: handles.video_id, permalink: null, publishedAt: nowIso(), handles })
  return outcome(context, 'published', { public_url: null })
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Waits for a container Instagram is still processing, within the invocation's budget. */
async function containerReady(target: InstagramTarget, containerId: string, deadline: MetaDeadline): Promise<'FINISHED' | 'IN_PROGRESS' | 'EXPIRED' | 'ERROR' | 'PUBLISHED'> {
  for (;;) {
    const { status } = await readContainerStatus(target, containerId, deadline)
    if (status !== 'IN_PROGRESS') return status
    if (deadline.remaining() < 8_000) return 'IN_PROGRESS'
    await pause(3_000)
  }
}

async function publishToInstagram(context: ChannelContext, target: InstagramTarget): Promise<ChannelResult> {
  const { post, handles, deadline } = context
  const fence = claimed(context.db, context.publication.id, context.attemptId)
  const notReady = async (status: string) => {
    if (status === 'IN_PROGRESS') {
      await fence.release()
      return outcome(context, 'processing', { code: 'container_processing', message: 'Instagram is still processing the media. Call publish_post again to finish it; it will publish these same containers.' })
    }
    // Instagram itself reports these containers as not published and unusable.
    await fence.failed(status === 'EXPIRED' ? 'container_expired' : 'provider_processing_failed', `Instagram reported the media container ${status}`, {})
    return outcome(context, 'failed', { code: status === 'EXPIRED' ? 'container_expired' : 'provider_processing_failed', message: `Instagram reported the media container ${status}; publish again to prepare new ones` })
  }
  const carousel = post.media.length > 1
  if (carousel) {
    handles.children ??= []
    for (const [index, item] of post.media.entries()) {
      if (handles.children[index]) continue
      handles.children[index] = await createMediaContainer(target, item.kind === 'image'
        ? { kind: 'image', url: item.public_url, carouselItem: true, altText: item.alt_text }
        : { kind: 'video', url: item.public_url, carouselItem: true }, deadline)
      await fence.saveHandles(handles)
    }
    for (const child of handles.children) {
      const status = await containerReady(target, child, deadline)
      if (status !== 'FINISHED') return await notReady(status)
    }
  }
  if (!handles.container_id) {
    const only = post.media[0]!
    handles.container_id = await createMediaContainer(target, carousel
      ? { kind: 'carousel', children: handles.children!, caption: context.caption }
      : only.kind === 'image'
        ? { kind: 'image', url: only.public_url, caption: context.caption, carouselItem: false, altText: only.alt_text }
        : { kind: 'video', url: only.public_url, caption: context.caption, carouselItem: false, coverUrl: only.thumbnail_url }, deadline)
    await fence.saveHandles(handles)
  }
  const status = await containerReady(target, handles.container_id, deadline)
  if (status === 'PUBLISHED') {
    // Only a container this publication saved can report its own publication.
    await fence.published({ providerPostId: null, permalink: null, publishedAt: nowIso(), handles })
    return outcome(context, 'published', { public_url: null })
  }
  if (status !== 'FINISHED') return await notReady(status)
  const deferred = await deferFinalWithoutTime(context, fence)
  if (deferred) return deferred
  await fence.beginFinal()
  let mediaId: string | null = null
  return await finalize(context, async () => { mediaId = await publishContainer(target, handles.container_id!, deadline); return mediaId }, async () => {
    if (mediaId) {
      const media = await readMedia(target, mediaId, deadline)
      return { published: true, providerPostId: media.id, permalink: media.permalink ?? null, publishedAt: media.timestamp }
    }
    const read = await readContainerStatus(target, handles.container_id!, deadline)
    return { published: read.status === 'PUBLISHED', providerPostId: null, permalink: null, retryable: read.status === 'FINISHED' }
  })
}

/**
 * The post's media as the files of one Discord message, in order, each checked
 * against what Discord accepts by the bytes actually fetched rather than by
 * what was recorded about the asset.
 */
async function discordFiles(post: Post, deadline: MetaDeadline): Promise<DiscordFile[] | { code: string; message: string }> {
  const files: DiscordFile[] = []
  let total = 0
  for (const [index, item] of post.media.entries()) {
    const remaining = deadline.remaining()
    if (remaining <= 250) throw new DiscordError('transport', 'The operation ran out of time while reading the post media')
    const response = await fetch(item.public_url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`Asset ${item.asset_id} could not be read from ${item.public_url}: HTTP ${response.status}`)
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (DISCORD_MEDIA_TYPES[type] !== item.kind) return { code: 'unsupported_media_type', message: `Asset ${item.asset_id} is served as ${type || 'an unknown type'}, which is not a Discord ${item.kind} format here` }
    // Never more than the file limit, nor the message's remaining allowance, is held in memory.
    const cap = Math.min(DISCORD_FILE_LIMIT_BYTES, DISCORD_REQUEST_LIMIT_BYTES - total)
    const tooLarge = { code: 'media_too_large', message: `Asset ${item.asset_id} is larger than Discord's 20 MiB file limit or the 25 MiB this message carries in all` }
    if (Number(response.headers.get('content-length') ?? 0) > cap) { await response.body?.cancel(); return tooLarge }
    if (!response.body) throw new Error(`Asset ${item.asset_id} answered without a body`)
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body.getReader()
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength
      if (size > cap) { await reader.cancel(); return tooLarge }
      chunks.push(read.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    total += size
    const extension = type.split('/')[1]!.replace('jpeg', 'jpg').replace('quicktime', 'mov')
    files.push({ name: `${index + 1}-${item.asset_id}.${extension}`, type, bytes: bytes.buffer, description: item.alt_text })
  }
  return files
}

/** A message is this publication's only when the KrabiClaw bot sent it to the connected channel. */
function discordMessageMismatch(env: CloudflareEnv, message: DiscordMessage, channelId: string): string | null {
  if (message.channel_id !== channelId) return `Discord message ${message.id} is in channel ${message.channel_id}, not the connected channel ${channelId}.`
  if (message.author.id !== env.DISCORD_CLIENT_ID) return `Discord message ${message.id} was not sent by the KrabiClaw bot.`
  return null
}

/** Discord's nonce is at most 25 characters; the publication id is its identity. */
const discordNonce = (publicationId: string) => publicationId.replaceAll('-', '').slice(0, 25)

async function publishToDiscord(context: ChannelContext, target: DiscordConnection): Promise<ChannelResult> {
  const { env, deadline } = context
  const fence = claimed(context.db, context.publication.id, context.attemptId)
  const files = await discordFiles(context.post, deadline)
  if (!Array.isArray(files)) {
    await fence.failed(files.code, files.message, {})
    return outcome(context, 'failed', files)
  }
  const deferred = await deferFinalWithoutTime(context, fence)
  if (deferred) return deferred
  await fence.beginFinal()
  let message: DiscordMessage
  try {
    message = await createMessage(env, target.channelId, { content: context.caption, files, nonce: discordNonce(context.publication.id) }, deadline)
  } catch (error) {
    if (error instanceof DiscordError && error.failure === 'rate_limited') {
      // Discord's 429 says nothing was sent: the publication is ready to send again.
      await fence.release(['publishing'])
      return outcome(context, 'processing', failureOf(error))
    }
    throw error
  }
  const mismatch = discordMessageMismatch(env, message, target.channelId)
  if (mismatch) {
    await fence.failed('destination_mismatch', mismatch, {})
    return outcome(context, 'failed', { code: 'destination_mismatch', message: mismatch })
  }
  const link = discordMessageLink(target.guildId, message.channel_id, message.id)
  await fence.published({ providerPostId: message.id, permalink: link, publishedAt: instantOf(message.timestamp), handles: {} })
  return outcome(context, 'published', { public_url: link })
}

/**
 * The irreversible call and what is known after it. A confirmed call is
 * published. Anything else re-reads the same object: published is published;
 * a definite "not published" may repeat the call on that same object, once;
 * a read that also fails is `unknown`, for reconcile_post_publication.
 */
async function finalize(
  context: ChannelContext,
  call: () => Promise<string | null>,
  read: () => Promise<{ published: boolean; providerPostId: string | null; permalink: string | null; publishedAt?: string | null; retryable?: boolean; createsAnother?: boolean }>,
): Promise<ChannelResult> {
  const fence = claimed(context.db, context.publication.id, context.attemptId)
  let callError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    callError = null
    let confirmedId: string | null = null
    try { confirmedId = await call() } catch (error) { callError = error }
    let state
    try {
      state = await read()
    } catch (readError) {
      if (callError === null) {
        // The call was confirmed; only its details could not be read back.
        await fence.published({ providerPostId: confirmedId, permalink: null, publishedAt: nowIso(), handles: context.handles })
        return outcome(context, 'published', { public_url: null, code: 'details_unavailable', message: messageOf(readError) })
      }
      if (callError instanceof MetaGraphError && callError.failure !== 'transport') {
        // Meta answered the final call with an error: it did not take effect.
        const failure = failureOf(callError)
        await fence.failed(failure.code, failure.message, context.handles)
        return outcome(context, 'failed', failure)
      }
      const message = `The final ${context.publication.channel} call was not confirmed (${messageOf(callError)}) and the post could not be read back (${messageOf(readError)}). Reconcile it; it is not sent again.`
      await fence.unknown('final_unconfirmed', message)
      return outcome(context, 'unknown', { code: 'final_unconfirmed', message })
    }
    if (state.published) {
      const publishedAt = instantOf(state.publishedAt)
      await fence.published({ providerPostId: state.providerPostId, permalink: state.permalink, publishedAt, handles: context.handles })
      return outcome(context, 'published', { public_url: validPermalink(state.permalink) })
    }
    if (callError instanceof MetaGraphError && callError.failure !== 'transport') {
      // Meta refused the call, and the object reads as not published.
      const failure = failureOf(callError)
      await fence.failed(failure.code, failure.message, context.handles)
      return outcome(context, 'failed', failure)
    }
    if (state.createsAnother) {
      // The call created a post that does not read as published, and calling
      // again would create another: only reconciliation may say what it is.
      const message = `${context.publication.channel} answered the final call with ${state.providerPostId ?? 'an object'} that does not read as published. Reconcile it; it is not sent again.`
      await fence.unknown('final_unconfirmed', message)
      return outcome(context, 'unknown', { code: 'final_unconfirmed', message })
    }
    if (!state.retryable || context.deadline.remaining() < 5_000) break
  }
  // Not published, and not refused: the same object is still ready for its final call.
  await fence.release(['publishing'])
  return outcome(context, 'processing', { code: 'final_not_confirmed', message: `${context.publication.channel} did not confirm the final call and still reads as unpublished. Call publish_post again; it finishes this same post.${callError ? ` (${messageOf(callError)})` : ''}` })
}

/** Unpublished objects this publication created for a payload it no longer sends. */
async function discardPreparation(env: CloudflareEnv, organizationId: string, publication: PublicationRecord, deadline: MetaDeadline): Promise<void> {
  const handles = JSON.parse(publication.provider_handles_json) as Handles
  // Instagram expires an unpublished container itself and offers no delete; Discord prepares nothing.
  if (publication.channel !== 'facebook') return
  const ids = [handles.post_id, handles.video_id, ...(handles.photo_ids ?? [])].filter((id): id is string => Boolean(id))
  if (!ids.length) return
  const connection = await readConnection(env, organizationId, 'facebook')
  if (connection.targetId !== publication.provider_target_id) throw new Error('The Facebook Page that owns this preparation is no longer connected.')
  const target = await facebookTargetFor(env, connection)
  for (const id of ids) await deletePageObject(target, id, deadline)
}

/** The provider application a publication is made through: Meta's app, or KrabiClaw's Discord application. */
function providerAppId(env: CloudflareEnv, channel: SocialChannel): string {
  const [name, value] = channel === 'facebook' ? ['FACEBOOK_APP_ID', env.FACEBOOK_APP_ID] : channel === 'instagram' ? ['INSTAGRAM_APP_ID', env.INSTAGRAM_APP_ID] : ['DISCORD_CLIENT_ID', env.DISCORD_CLIENT_ID]
  if (typeof value !== 'string' || !value) throw new Error(`${name} is not configured`)
  return value
}

/** Claims the publication row for this invocation, or says why it cannot. */
async function claimPublication(
  db: DbClient, env: CloudflareEnv, organizationId: string, post: Post,
  target: Extract<PublishTarget, { channel: SocialChannel }>, identity: { appId: string; subjectId: string }, payloadHash: string, deadline: MetaDeadline,
): Promise<{ publication: PublicationRecord; attemptId: string } | PublishOutcome> {
  const attemptId = crypto.randomUUID()
  const existing = await readPublication(db, organizationId, { postId: post.id, channel: target.channel })
  if (!existing) {
    const id = crypto.randomUUID()
    try {
      // A batch, so the unique index's refusal reaches here as D1 states it.
      await executeBatch(db, [{ query: `INSERT INTO post_publications (id, organization_id, post_id, channel, provider_app_id, provider_subject_id, provider_target_id,
          state, payload_hash, attempt_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?)`,
      params: [id, organizationId, post.id, target.channel, identity.appId, identity.subjectId, target.target_id, payloadHash, attemptId, nowIso(), nowIso()] }])
    } catch (error) {
      if (!/UNIQUE constraint failed/.test(messageOf(error))) throw error
      // A concurrent call claimed it first; it does the work.
      return { channel: target.channel, target_id: target.target_id, status: 'processing', code: 'in_progress', message: 'Another call is publishing this post to this channel' }
    }
    return { publication: (await readPublication(db, organizationId, { id }))!, attemptId }
  }
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString()
  if (existing.state === 'failed' && existing.payload_hash !== payloadHash) {
    // What was prepared belongs to a payload this call no longer sends.
    try { await discardPreparation(env, organizationId, existing, deadline) } catch (error) {
      return { channel: target.channel, target_id: target.target_id, status: 'failed', publication_id: existing.id, code: 'cleanup_failed',
        message: `The unpublished objects of the earlier attempt could not be removed, so nothing new was prepared: ${messageOf(error)}` }
    }
  }
  const reclaim = await execute(db, `UPDATE post_publications SET state = 'preparing', attempt_id = ?, payload_hash = ?, error_code = NULL, error_message = NULL,
      provider_handles_json = CASE WHEN state = 'failed' AND payload_hash IS NOT ? THEN '{}' ELSE provider_handles_json END,
      provider_post_id = CASE WHEN state = 'failed' AND payload_hash IS NOT ? THEN NULL ELSE provider_post_id END, updated_at = ?
    WHERE id = ? AND updated_at = ? AND (state = 'failed' OR (state = 'preparing' AND (attempt_id IS NULL OR updated_at < ?)))`,
  [attemptId, payloadHash, payloadHash, payloadHash, nowIso(), existing.id, existing.updated_at, staleBefore])
  if (Number(reclaim.meta?.changes ?? 0) !== 1) {
    return { channel: target.channel, target_id: target.target_id, status: 'processing', publication_id: existing.id, code: 'in_progress', message: 'Another call is publishing this post to this channel' }
  }
  return { publication: (await readPublication(db, organizationId, { id: existing.id }))!, attemptId }
}

async function publishExternal(
  db: DbClient, env: CloudflareEnv, organizationId: string, post: Post,
  target: Extract<PublishTarget, { channel: SocialChannel }>, deadline: MetaDeadline,
): Promise<PublishOutcome> {
  const connection = await readConnection(env, organizationId, target.channel)
  if (!connection.connected || connection.targetId !== target.target_id || connection.revision !== target.connection_revision) return { channel: target.channel, target_id: target.target_id, status: 'failed', code: 'connection_changed', message: 'The channel connection changed; read get_social_connections again.' }
  const account = connection.accountId ? await readLinkedAccount(env, connection.accountId) : null
  if (!account) return { channel: target.channel, target_id: target.target_id, status: 'skipped', code: 'account_unlinked', message: `The ${target.channel} account behind this connection is no longer linked. Connect it again.` }
  const appId = providerAppId(env, target.channel)
  const payloadHash = await postPayloadFingerprint(post, { channel: target.channel, target_id: target.target_id })
  const claim = await claimPublication(db, env, organizationId, post, target, { appId, subjectId: account.accountId }, payloadHash, deadline)
  if (!('attemptId' in claim)) return claim
  const context: ChannelContext = {
    db, env, organizationId, post, caption: providerCaption(post.body, post.call_to_action), publication: claim.publication,
    attemptId: claim.attemptId, handles: JSON.parse(claim.publication.provider_handles_json) as Handles, deadline,
  }
  const fence = claimed(db, claim.publication.id, claim.attemptId)
  try {
    if (target.channel === 'facebook') return await publishToFacebook(context, await facebookTargetFor(env, connection))
    if (target.channel === 'discord') return await publishToDiscord(context, await discordTargetFor(env, connection, deadline))
    return await publishToInstagram(context, await instagramTargetFor(env, connection))
  } catch (error) {
    if (error instanceof ClaimLost) return outcome(context, 'processing', { code: 'claim_lost', message: error.message })
    // Before the final call nothing can be public, so this is a definite
    // non-publication; the objects already prepared stay saved for the retry.
    const failure = failureOf(error)
    const current = await readPublication(db, organizationId, { id: claim.publication.id })
    // The provider answering the final call with an error is the provider
    // saying nothing was published; only a final call it never answered is unknown.
    if (current?.state === 'publishing' && current.attempt_id === claim.attemptId && !providerRefused(error)) {
      await fence.unknown('final_unconfirmed', `The publication stopped after its final call began: ${failure.message}`)
      return outcome(context, 'unknown', { code: 'final_unconfirmed', message: failure.message })
    }
    await fence.failed(failure.code, failure.message, context.handles)
    return outcome(context, 'failed', failure)
  }
}

/** A receipt for a publication that already exists, read without changing anything. */
function receipt(publication: PublicationRecord): PublishOutcome {
  const base = { channel: publication.channel, target_id: publication.provider_target_id, publication_id: publication.id }
  if (publication.state === 'published') return { ...base, status: 'already_published', public_url: publication.provider_permalink }
  if (publication.state === 'failed') return { ...base, status: 'failed', code: publication.error_code ?? undefined, message: publication.error_message ?? undefined }
  if (publication.state === 'unknown') return { ...base, status: 'unknown', code: publication.error_code ?? 'unresolved', message: `${publication.error_message ?? 'The outcome of this publication is unresolved.'} Resolve it with reconcile_post_publication.` }
  if (publication.state === 'removed') return { ...base, status: 'failed', code: 'removed', message: `The ${CHANNEL_NAMES[publication.channel]} post was removed. Create a new post to publish again.` }
  if (publication.state === 'preparing' && publication.attempt_id === null) return { ...base, status: 'processing', code: 'preparation_ready', message: 'This publication is unpublished and ready to resume. Call publish_post again to finish it.' }
  return { ...base, status: 'processing', code: 'in_progress', message: 'This publication is being prepared by another call' }
}

/**
 * Publishes one post to the targets the caller named, and nothing else.
 *
 * Existing results are read first, so a repeat returns the same receipts
 * without needing a fresh revision. A new target, or a first website
 * publication, needs the caller's current `expected_updated_at` and the
 * connection revision it read. Every target is evaluated; `ok` is true only
 * when all of them are published.
 */
export async function publishPost(
  env: CloudflareEnv,
  organizationId: string,
  postId: string,
  input: { expectedUpdatedAt: string; targets: PublishTarget[] },
  actorId: string | null,
): Promise<PublishResult> {
  const db = env.DB as DbClient
  const deadline = new MetaDeadline(PUBLISH_BUDGET_MS)
  const post = await getPost(db, env, organizationId, postId)
  if (!post) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
  const stale = post.updated_at !== input.expectedUpdatedAt
  const staleOutcome = (channel: PublishOutcome['channel'], targetId: string): PublishOutcome => ({ channel, target_id: targetId, status: 'failed', code: 'stale_revision',
    message: `The post changed since it was read (now ${post.updated_at}); read it again and publish with the current expected_updated_at` })
  const assets = await assetFacts(db, organizationId, post.media)
  const caption = providerCaption(post.body, post.call_to_action)
  const entitled = await hasOrganizationEntitlement(env, organizationId, 'managed_service')
  const outcomes: PublishOutcome[] = []
  const external: Array<Extract<PublishTarget, { channel: SocialChannel }>> = []
  let publishWebsite = false

  for (const target of input.targets) {
    if (target.channel === 'organization') {
      if (post.status === 'published') outcomes.push(post.canonical_url
        ? { channel: 'organization', target_id: organizationId, status: 'already_published', public_url: post.canonical_url }
        : { channel: 'organization', target_id: organizationId, status: 'failed', code: 'website_publication_incomplete', message: 'The post has no published website URL' })
      else if (stale) outcomes.push(staleOutcome('organization', organizationId))
      else if (!publishable(post)) outcomes.push({ channel: 'organization', target_id: organizationId, status: 'failed', code: 'empty_post', message: 'A post needs words, media or a call to action before it can be published' })
      else publishWebsite = true
      continue
    }
    const existing = post.publications.find(publication => publication.channel === target.channel)
    let record = existing ? await readPublication(db, organizationId, { id: existing.id }) : null
    if (existing && !record) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
    // An invocation that died after its final call began left `publishing`
    // behind; once its claim is stale that is an unconfirmed final call, and
    // only reconciliation may say what became of it.
    if (record?.state === 'publishing' && Date.parse(record.updated_at) < Date.now() - CLAIM_STALE_MS) {
      await execute(db, `UPDATE post_publications SET state = 'unknown', attempt_id = NULL, error_code = 'final_unconfirmed',
          error_message = 'The call that was publishing this stopped before it confirmed the result', updated_at = ?
        WHERE id = ? AND state = 'publishing' AND updated_at = ?`, [nowIso(), record.id, record.updated_at])
      record = await readPublication(db, organizationId, { id: record.id })
      if (!record) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
    }
    if (record && record.provider_target_id !== target.target_id) {
      outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', publication_id: record.id, code: 'target_conflict',
        message: `This post's ${target.channel} publication is to ${record.provider_target_id}; a post is published to one ${target.channel} target. Create a new post for another.` })
      continue
    }
    if (record && record.state !== 'failed' && !(record.state === 'preparing' && record.attempt_id === null) && !(record.state === 'preparing' && Date.parse(record.updated_at) < Date.now() - CLAIM_STALE_MS)) {
      outcomes.push(receipt(record))
      continue
    }
    const resuming = record?.state === 'preparing'
    const connection = await readConnection(env, organizationId, target.channel)
    if (!entitled) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'skipped', code: 'growth_plan_required', message: GROWTH_PLAN_REQUIRED }); continue }
    if (!connection.connected) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'skipped', code: 'not_connected', message: NOT_CONNECTED[target.channel] }); continue }
    if (connection.targetId !== target.target_id || connection.revision !== target.connection_revision) {
      outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', code: 'connection_changed',
        message: `The ${target.channel} connection is now ${connection.targetName ?? connection.targetId} at revision ${connection.revision}; read get_social_connections again` })
      continue
    }
    // A resumed preparation sends the payload it pinned; it needs no fresh content revision.
    if (stale && !resuming) { outcomes.push(staleOutcome(target.channel, target.target_id)); continue }
    if (!publishable(post)) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', code: 'empty_post', message: 'A post needs words, media or a call to action before it can be published' }); continue }
    const violation = formatViolation(target.channel, caption, assets)
    if (violation) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', ...violation }); continue }
    external.push(target)
  }

  if (publishWebsite) {
    const now = new Date(Math.max(Date.now(), Date.parse(post.updated_at) + 1)).toISOString()
    const [result] = await executeBatch(db, [{
      query: `UPDATE content_documents SET status = 'published', published_at = COALESCE(published_at, ?), first_published_at = COALESCE(first_published_at, ?), updated_at = ?
        WHERE kind = 'social_post' AND row_role = 'root' AND id = ? AND organization_id = ? AND updated_at = ? AND status = 'draft'`,
      params: [now, now, now, postId, organizationId, input.expectedUpdatedAt],
    }, organizationEventQuery({ organizationId, locationId: post.location_id, actorId, eventType: 'post.published', entityType: 'post', entityId: postId,
      metadata: { channel: 'organization' }, onlyIfPreviousChangedOneRow: true }),
    publicResourceCacheInvalidationQuery(organizationId, 'post-publish')])
    if (Number(result?.meta.changes ?? 0) === 1) {
      const published = await getPost(db, env, organizationId, postId)
      if (!published) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
      outcomes.push(published.status === 'published' && published.canonical_url
        ? { channel: 'organization', target_id: organizationId, status: 'published', public_url: published.canonical_url }
        : { channel: 'organization', target_id: organizationId, status: 'failed', code: 'website_publication_incomplete', message: 'The post has no published website URL' })
    } else {
      outcomes.push(staleOutcome('organization', organizationId))
    }
  }
  for (const target of external) outcomes.push(await publishExternal(db, env, organizationId, post, target, deadline))

  const order = input.targets.map(target => target.channel)
  outcomes.sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel))
  const current = await queryFirst<{ updated_at: string }>(db, 'SELECT updated_at FROM content_documents WHERE id = ?', [postId])
  if (!current) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
  return {
    ok: outcomes.length === input.targets.length && outcomes.every(item => item.status === 'published' || item.status === 'already_published'),
    post_id: postId,
    updated_at: current.updated_at,
    outcomes,
  }
}

// ── Reconciliation ────────────────────────────────────────────────────────

/**
 * Reads the provider for one publication and records what it proves. It never
 * publishes, and it takes no one's word that something is published: a
 * supplied `provider_post_id` is read and must belong to this publication's
 * target. What stays ambiguous stays `unknown`.
 */
export async function reconcilePostPublication(env: CloudflareEnv, organizationId: string, publicationId: string, providerPostId: string | null) {
  const db = env.DB as DbClient
  const publication = await readPublication(db, organizationId, { id: publicationId })
  if (!publication) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
  if (providerPostId && publication.provider_post_id && providerPostId !== publication.provider_post_id) {
    throw new HTTPError({ statusCode: 409, statusMessage: `This publication is ${publication.provider_post_id}; ${providerPostId} is a different ${publication.channel} post` })
  }
  const connection = await readConnection(env, organizationId, publication.channel)
  const account = connection.accountId ? await readLinkedAccount(env, connection.accountId) : null
  if (!connection.connected || connection.targetId !== publication.provider_target_id || !account
    || account.accountId !== publication.provider_subject_id || providerAppId(env, publication.channel) !== publication.provider_app_id) {
    throw new HTTPError({ statusCode: 409, statusMessage: `Reconciling needs the ${publication.channel} connection that made this publication (target ${publication.provider_target_id}); it is not connected now` })
  }
  if (publication.channel === 'discord') return await reconcileDiscordPublication(env, organizationId, publication, await discordTargetFor(env, connection), providerPostId)
  const deadline = new MetaDeadline(PUBLISH_BUDGET_MS)
  const handles = JSON.parse(publication.provider_handles_json) as Handles
  const record = async (state: 'published' | 'preparing' | 'failed', fields: { providerPostId?: string | null; permalink?: string | null; publishedAt?: string | null; code?: string; message?: string }) => {
    const result = await execute(db, `UPDATE post_publications SET state = ?, attempt_id = NULL, provider_post_id = COALESCE(?, provider_post_id),
        provider_permalink = COALESCE(?, provider_permalink), published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
        error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`,
    [state, fields.providerPostId ?? null, validPermalink(fields.permalink ?? null), state, instantOf(fields.publishedAt),
      state === 'failed' ? fields.code ?? 'provider_rejected' : null, state === 'failed' ? fields.message ?? null : null, nowIso(), publication.id, publication.updated_at])
    if (Number(result.meta?.changes ?? 0) !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'The publication changed while it was being reconciled; read it again' })
  }
  if (publication.channel === 'facebook') {
    const target = await facebookTargetFor(env, connection)
    const postId = providerPostId ?? publication.provider_post_id ?? handles.post_id ?? null
    if (postId && postId !== handles.video_id) {
      if (!postId.startsWith(`${target.pageId}_`)) throw new HTTPError({ statusCode: 409, statusMessage: `${postId} is not a post of the Page ${target.pageId}` })
      const read = await readPagePost(target, postId, deadline)
      if (read.isPublished) await record('published', { providerPostId: read.id, permalink: read.permalink, publishedAt: read.createdTime })
      else if (publication.state === 'failed') await record('failed', { providerPostId: read.id, code: publication.error_code ?? undefined, message: publication.error_message ?? undefined })
      else await record('preparing', { providerPostId: read.id })
    } else if (handles.video_id) {
      const read = await readVideo(target, handles.video_id, deadline)
      if (read.published) await record('published', { providerPostId: read.postId ?? handles.video_id, permalink: read.permalink })
      else if (read.processing === 'error') await record('failed', { code: 'provider_processing_failed', message: read.error ?? undefined })
      else await record('preparing', {})
    }
  } else {
    const target = await instagramTargetFor(env, connection)
    const mediaId = providerPostId ?? publication.provider_post_id
    if (mediaId) {
      const media = await readMedia(target, mediaId, deadline)
      const username = connection.targetName?.slice(1) ?? null
      if (!username || media.username !== username) throw new HTTPError({ statusCode: 409, statusMessage: `${media.id} belongs to @${media.username ?? 'another account'}, not @${username}` })
      await record('published', { providerPostId: media.id, permalink: media.permalink ?? null, publishedAt: media.timestamp })
    } else if (handles.container_id) {
      const { status } = await readContainerStatus(target, handles.container_id, deadline)
      if (status === 'PUBLISHED') await record('published', {})
      else if (status === 'FINISHED' || status === 'IN_PROGRESS') await record('preparing', {})
      else await record('failed', { code: status === 'EXPIRED' ? 'container_expired' : 'provider_processing_failed', message: `Instagram reported the media container ${status}` })
    }
  }
  const updated = await readPublication(db, organizationId, { id: publicationId })
  if (!updated) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
  return { publication: receipt(updated), state: updated.state }
}

/**
 * Reads the connected channel for what one Discord publication sent. A
 * supplied `provider_post_id` is read and must be the bot's message in that
 * channel. Without one, the bot's messages sent since the publication began
 * are searched for exactly this post's text and media in order; one match is
 * the publication, and none or several leaves it unknown.
 */
async function reconcileDiscordPublication(env: CloudflareEnv, organizationId: string, publication: PublicationRecord, target: DiscordConnection, providerPostId: string | null) {
  const db = env.DB as DbClient
  if (publication.state !== 'unknown' && publication.state !== 'published') {
    throw new HTTPError({ statusCode: 409, statusMessage: `This Discord publication is ${publication.state}; only an unknown or published one is reconciled` })
  }
  const deadline = new MetaDeadline(PUBLISH_BUDGET_MS)
  const messageId = providerPostId ?? publication.provider_post_id
  let message: DiscordMessage | null
  if (messageId) {
    message = await readDiscordMessage(env, target, messageId, deadline)
  } else {
    const post = publication.post_id ? await getPost(db, env, organizationId, publication.post_id) : null
    if (!post || await postPayloadFingerprint(post, { channel: 'discord', target_id: publication.provider_target_id }) !== publication.payload_hash) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'The post changed or is gone since this attempt, so the channel cannot be searched for what it sent. Supply the Discord message id.' })
    }
    const caption = providerCaption(post.body, post.call_to_action)
    const since = Date.parse(publication.created_at)
    const matches = (candidate: DiscordMessage) => !discordMessageMismatch(env, candidate, target.channelId) && Date.parse(candidate.timestamp) >= since
      && candidate.content === caption && candidate.attachments.length === post.media.length
      && candidate.attachments.every((attachment, index) => attachment.filename.startsWith(`${index + 1}-${post.media[index]!.asset_id}.`))
    // Newest first, page by page, back to when the publication began.
    const sent: DiscordMessage[] = []
    let before: string | null = null
    let complete = false
    while (deadline.remaining() > 5_000) {
      const page = await listMessages(env, target.channelId, { before, limit: 100 }, deadline)
      sent.push(...page.filter(matches))
      if (page.length < 100 || Date.parse(page.at(-1)!.timestamp) < since) { complete = true; break }
      before = page.at(-1)!.id
    }
    message = complete && sent.length === 1 ? sent[0]! : null
    if (!message) {
      return { publication: receipt(publication), state: publication.state, message: !complete
        ? 'The channel has more messages since this attempt than one check can read; check again.'
        : sent.length ? `${sent.length} messages match this post; supply the Discord message id.` : 'No message of this post is in the channel; it stays unknown.' }
    }
  }
  const result = await execute(db, `UPDATE post_publications SET state = 'published', attempt_id = NULL, provider_post_id = ?, provider_permalink = ?,
      published_at = COALESCE(published_at, ?), error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND updated_at = ? AND state IN ('published', 'unknown')`,
  [message.id, discordMessageLink(target.guildId, message.channel_id, message.id), instantOf(message.timestamp), nowIso(), publication.id, publication.updated_at])
  if (Number(result.meta?.changes ?? 0) !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'The publication changed while it was being reconciled; read it again' })
  const updated = await readPublication(db, organizationId, { id: publication.id })
  if (!updated) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
  return { publication: receipt(updated), state: updated.state }
}

/** One message the KrabiClaw bot sent to the connected channel; anything else is refused. */
export async function readDiscordMessage(env: CloudflareEnv, target: DiscordConnection, messageId: string, deadline: MetaDeadline): Promise<DiscordMessage> {
  if (!/^\d{15,25}$/.test(messageId)) throw new HTTPError({ statusCode: 400, statusMessage: 'A Discord message id is a numeric snowflake.' })
  let message: DiscordMessage
  try {
    message = await getMessage(env, target.channelId, messageId, deadline)
  } catch (error) {
    if (error instanceof DiscordError && error.objectMissing) throw new HTTPError({ statusCode: 404, statusMessage: `The connected Discord channel has no message ${messageId}` })
    throw error
  }
  const mismatch = discordMessageMismatch(env, message, target.channelId)
  if (mismatch) throw new HTTPError({ statusCode: 409, statusMessage: mismatch })
  return message
}
