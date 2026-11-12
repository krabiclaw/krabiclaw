import { opportunityDoneQuery } from '~/server/domain/tasks'
import { HTTPError } from 'nitro'
import { executeBatch, execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { linkedAccountAccessToken, readLinkedAccount, type CloudflareEnv } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { getPost, postPayloadFingerprint, type Post, type PostMedia } from '~/server/utils/post-management'
import { providerCaption } from '~/shared/posts'
import { MetaGraphError } from '~/server/utils/meta-graph'
import { buildImageUrl } from '~/server/utils/cloudflare-images'
import {
  createUnpublishedPhoto, createVideo, facebookPageToken, finishReel, isFacebookReel, listLinkedFacebookPages,
  publishPagePost, readPagePost, readVideo, startReel, uploadReelFromUrl, type FacebookPageTarget,
} from '~/server/utils/facebook-pages'
import {
  createMediaContainer, getInstagramAccount, instagramAccessToken, publishContainer, readContainerStatus, readMedia, type InstagramTarget,
} from '~/server/utils/instagram'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { readIntegration } from '~/server/utils/organization-integrations'
import {
  createMessage, discordMessageLink, DiscordError, getMessage, readMessageChannel,
  type DiscordFile, type DiscordMessage,
} from '~/server/utils/discord-bot'

/**
 * Publishing a post to its website and to the Facebook Page, Instagram
 * professional account and Discord channel the organization connected — one
 * operation, shared by MCP and the dashboard, returning one result.
 *
 * External publication uses Meta's own primitives: for Page photos, unpublished
 * photos then the post attaching them; for Instagram, a media container then
 * media_publish once Instagram reports it FINISHED; for a Facebook Reel, the
 * upload session's finish; for any other Facebook video, the upload itself.
 * One call per channel: the provider's post id is recorded on success and the
 * provider's error on failure. There is no scheduler and no queue.
 *
 * Discord has nothing to prepare: the KrabiClaw bot, added to the server when
 * the owner linked Discord through Better Auth, creates the message in the
 * chosen channel and answers with the message it saved.
 */

export type SocialChannel = 'facebook' | 'instagram' | 'discord'
export const SOCIAL_CHANNELS: readonly SocialChannel[] = ['facebook', 'instagram', 'discord']
const CHANNEL_NAMES: Record<SocialChannel, string> = { facebook: 'Facebook', instagram: 'Instagram', discord: 'Discord' }
export type PublishTarget =
  | { channel: 'organization' }
  | { channel: SocialChannel; target_id: string; connection_revision: string }

export type PublishOutcomeStatus = 'published' | 'already_published' | 'failed' | 'skipped'

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

/** The connected channel as the bot sees it now. */
async function discordTargetFor(env: CloudflareEnv, connection: ConnectionRead): Promise<DiscordConnection> {
  if (connection.channel !== 'discord' || !connection.connected || !connection.targetId) throw new Error('The Discord connection is incomplete. Connect Discord again.')
  const channel = await readMessageChannel(env, connection.targetId)
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
    // Better Auth refreshes the linked account's access token when needed.
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

interface AssetFacts {
  asset_id: string; mime_type: string | null; file_size: number | null; duration: number | null; kind: 'image' | 'video'; public_url: string; alt_text: string | null
  /** Where this image is served as a JPEG: itself, or its Cloudflare Images rendition; null when nothing serves one. */
  jpeg_url: string | null
}

async function assetFacts(db: DbClient, env: CloudflareEnv, organizationId: string, media: PostMedia[]): Promise<AssetFacts[]> {
  if (!media.length) return []
  const rows = await queryAll<{ id: string; file_size: number | null; cloudflare_image_id: string | null }>(db,
    'SELECT id, file_size, cloudflare_image_id FROM media_assets WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))',
    [organizationId, d1JsonStringSet(media.map(item => item.asset_id))])
  const stored = new Map(rows.map(row => [row.id, row]))
  return media.map((item) => {
    const row = stored.get(item.asset_id)
    const jpegUrl = item.kind !== 'image' ? null
      : item.mime_type === 'image/jpeg' ? item.public_url
        : row?.cloudflare_image_id ? buildImageUrl(env, row.cloudflare_image_id, 'format=jpeg') : null
    return { asset_id: item.asset_id, mime_type: item.mime_type, file_size: row?.file_size ?? null, duration: item.duration, kind: item.kind, public_url: item.public_url, alt_text: item.alt_text, jpeg_url: jpegUrl }
  })
}

const hashtagCount = (text: string) => (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length
const mentionCount = (text: string) => (text.match(/(^|\s)@[\w.]+/g) ?? []).length

/** The first rule this post breaks for this channel, precisely; null when it can be sent. */
export function formatViolation(channel: SocialChannel, caption: string, assets: AssetFacts[]): { code: string; message: string } | null {
  const images = assets.filter(asset => asset.kind === 'image')
  const videos = assets.filter(asset => asset.kind === 'video')
  const unreachable = assets.find(asset => !/^https:\/\//.test(asset.public_url))
  if (unreachable) return { code: 'media_not_public', message: `${channel} media is fetched from its public https URL; asset ${unreachable.asset_id} is at ${unreachable.public_url}` }
  if (channel === 'discord') return null
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
  const image = images.find(asset => !asset.jpeg_url)
  if (image) return { code: 'unsupported_media_type', message: `Instagram accepts JPEG images only; asset ${image.asset_id} is ${image.mime_type ?? 'of unknown type'} and has no JPEG rendition` }
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
  state: 'published' | 'failed' | 'removed'
  provider_post_id: string | null
  provider_permalink: string | null
  payload_hash: string | null
  initiating_activity_id: string | null
  error_code: string | null
  error_message: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

async function readPublication(db: DbClient, organizationId: string, where: { id: string } | { postId: string; channel: SocialChannel }) {
  return await queryFirst<PublicationRecord>(db, 'id' in where
    ? 'SELECT * FROM post_publications WHERE organization_id = ? AND id = ?'
    : 'SELECT * FROM post_publications WHERE organization_id = ? AND post_id = ? AND channel = ?',
  'id' in where ? [organizationId, where.id] : [organizationId, where.postId, where.channel])
}

const nowIso = () => new Date().toISOString()

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

/** The provider reported that what it was asked to publish will not be published, in its own words. */
class PublicationFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ── Channel operations ────────────────────────────────────────────────────

interface ChannelContext {
  env: CloudflareEnv
  post: Post
  caption: string
  assets: AssetFacts[]
}

/** What the provider answered the publishing call with, and the link it shows for it. */
interface Published { providerPostId: string; permalink: string | null; publishedAt: string; detail?: string }

async function facebookTargetFor(env: CloudflareEnv, connection: ConnectionRead): Promise<FacebookPageTarget> {
  if (connection.channel !== 'facebook' || !connection.connected || !connection.targetId || !connection.accountId || !connection.targetName) throw new Error('The Facebook connection is incomplete. Connect Facebook again.')
  return { pageId: connection.targetId, pageToken: await facebookPageToken(env, { target_id: connection.targetId, account_id: connection.accountId, target_name: connection.targetName }) }
}

async function instagramTargetFor(env: CloudflareEnv, connection: ConnectionRead): Promise<InstagramTarget> {
  if (connection.channel !== 'instagram' || !connection.connected || !connection.targetId || !connection.accountId) throw new Error('The Instagram connection is incomplete. Connect Instagram again.')
  return { userId: connection.targetId, accessToken: await instagramAccessToken(env, connection.accountId) }
}

/** The provider's failure, as publications and channel tools report it. */
export function failureOf(error: unknown): { code: string; message: string } {
  if (error instanceof PublicationFailure) return { code: error.code, message: error.message }
  if (error instanceof MetaGraphError || error instanceof DiscordError) {
    if (error instanceof DiscordError && error.failure === 'rate_limited') {
      return { code: 'rate_limited', message: `${error.message}. Nothing was sent; try again${error.retryAfterMs !== null ? ` in ${Math.ceil(error.retryAfterMs / 1000)} seconds` : ' later'}.` }
    }
    return { code: error.failure === 'authorization' ? 'connection_error' : error.failure === 'transport' ? 'provider_unreachable' : 'provider_rejected',
      message: error.message }
  }
  return { code: 'provider_rejected', message: messageOf(error) }
}

/**
 * The link and time of an object the provider has already published. The
 * publication stands on the provider's answer to the publishing call; a read
 * of its details that fails is reported with it, not as a failure to publish.
 */
async function detailsOf(providerPostId: string, read: () => Promise<{ permalink: string | null; publishedAt: string | null | undefined }>): Promise<Published> {
  let details: { permalink: string | null; publishedAt: string | null | undefined }
  try {
    details = await read()
  } catch (error) {
    return { providerPostId, permalink: null, publishedAt: nowIso(), detail: `Published; its link could not be read back: ${messageOf(error)}` }
  }
  return { providerPostId, permalink: details.permalink, publishedAt: instantOf(details.publishedAt) }
}

async function publishToFacebook(context: ChannelContext, target: FacebookPageTarget): Promise<Published> {
  const { post } = context
  const video = post.media.find(item => item.kind === 'video')
  if (video) return await publishVideoToFacebook(context, target, video)
  const photoIds: string[] = []
  for (const image of post.media.filter(item => item.kind === 'image')) {
    photoIds.push(await createUnpublishedPhoto(target, { url: image.public_url, altText: image.alt_text }))
  }
  const link = post.call_to_action && /^https?:/.test(post.call_to_action.url) ? post.call_to_action.url : null
  const postId = await publishPagePost(target, { message: context.caption, link, photoIds })
  return await detailsOf(postId, async () => {
    const read = await readPagePost(target, postId)
    return { permalink: read.permalink, publishedAt: read.createdTime }
  })
}

/**
 * One Facebook video, published by Meta's own final call: a Reel's finish,
 * which answers with the Page post, or a published upload, which Facebook
 * posts once it has processed it. Meta's answer is the publication.
 */
async function publishVideoToFacebook(context: ChannelContext, target: FacebookPageTarget, video: PostMedia): Promise<Published> {
  const { post } = context
  if (isFacebookReel(video)) {
    const videoId = await startReel(target)
    await uploadReelFromUrl(target, videoId, video.public_url)
    const { postId } = await finishReel(target, videoId, { description: context.caption, title: post.title })
    return { providerPostId: postId ?? videoId, permalink: null, publishedAt: nowIso() }
  }
  const videoId = await createVideo(target, { fileUrl: video.public_url, description: context.caption, title: post.title })
  return { providerPostId: videoId, permalink: null, publishedAt: nowIso() }
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Meta's publishing guide: check a container's status for no more than five minutes.
const CONTAINER_WAIT_MS = 5 * 60_000

/** Waits until Instagram finishes processing a container (docs: poll status_code until it leaves IN_PROGRESS). */
async function containerReady(target: InstagramTarget, containerId: string): Promise<'FINISHED' | 'EXPIRED' | 'ERROR' | 'PUBLISHED'> {
  const until = Date.now() + CONTAINER_WAIT_MS
  for (;;) {
    const { status } = await readContainerStatus(target, containerId)
    if (status !== 'IN_PROGRESS') return status
    if (Date.now() >= until) throw new PublicationFailure('provider_processing_failed', 'Instagram was still processing the media after five minutes')
    await pause(3_000)
  }
}

async function publishToInstagram(context: ChannelContext, target: InstagramTarget): Promise<Published> {
  const { post } = context
  // Instagram itself reports these containers as not published and unusable.
  const notReady = (status: 'EXPIRED' | 'ERROR' | 'PUBLISHED'): never => {
    throw new PublicationFailure(status === 'EXPIRED' ? 'container_expired' : 'provider_processing_failed', `Instagram reported the media container ${status}`)
  }
  // Instagram fetches images as JPEG; validation refused any image without a JPEG URL.
  const jpegUrl = (assetId: string) => context.assets.find(asset => asset.asset_id === assetId)!.jpeg_url!
  const carousel = post.media.length > 1
  const children: string[] = []
  if (carousel) {
    for (const item of post.media) {
      children.push(await createMediaContainer(target, item.kind === 'image'
        ? { kind: 'image', url: jpegUrl(item.asset_id), carouselItem: true, altText: item.alt_text }
        : { kind: 'video', url: item.public_url, carouselItem: true }))
    }
    for (const child of children) {
      const status = await containerReady(target, child)
      if (status !== 'FINISHED') notReady(status)
    }
  }
  const only = post.media[0]!
  const containerId = await createMediaContainer(target, carousel
    ? { kind: 'carousel', children, caption: context.caption }
    : only.kind === 'image'
      ? { kind: 'image', url: jpegUrl(only.asset_id), caption: context.caption, carouselItem: false, altText: only.alt_text }
      : { kind: 'video', url: only.public_url, caption: context.caption, carouselItem: false, coverUrl: only.thumbnail_url })
  const status = await containerReady(target, containerId)
  if (status !== 'FINISHED') notReady(status)
  // Meta can answer media_publish with 9007/2207027, "media not ready", after the container
  // reads FINISHED; that is the same readiness wait, so it waits on the container again.
  let mediaId: string
  const until = Date.now() + CONTAINER_WAIT_MS
  for (;;) {
    try { mediaId = await publishContainer(target, containerId); break } catch (error) {
      if (!(error instanceof MetaGraphError) || error.details.code !== 9007 || error.details.subcode !== 2207027 || Date.now() >= until) throw error
      await pause(3_000)
      const { status } = await readContainerStatus(target, containerId)
      if (status !== 'FINISHED' && status !== 'IN_PROGRESS') throw error
    }
  }
  return await detailsOf(mediaId, async () => {
    const media = await readMedia(target, mediaId)
    return { permalink: media.permalink ?? null, publishedAt: media.timestamp }
  })
}

/** The post's media as the files of one Discord message, in order. */
async function discordFiles(post: Post): Promise<DiscordFile[]> {
  return Promise.all(post.media.map(async (item, index) => {
    const response = await fetch(item.public_url)
    if (!response.ok) throw new Error(`Asset ${item.asset_id} could not be read from ${item.public_url}: HTTP ${response.status}`)
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const extension = type.split('/')[1]!.replace('jpeg', 'jpg').replace('quicktime', 'mov')
    return { name: `${index + 1}-${item.asset_id}.${extension}`, type, bytes: await response.arrayBuffer(), description: item.alt_text }
  }))
}

/** Discord's nonce is at most 25 characters; the publication id is its identity. */
const discordNonce = (publicationId: string) => publicationId.replaceAll('-', '').slice(0, 25)

async function publishToDiscord(context: ChannelContext, target: DiscordConnection, publicationId: string): Promise<Published> {
  const files = await discordFiles(context.post)
  const message: DiscordMessage = await createMessage(context.env, target.channelId, { content: context.caption, files, nonce: discordNonce(publicationId) })
  return { providerPostId: message.id, permalink: discordMessageLink(target.guildId, message.channel_id, message.id), publishedAt: instantOf(message.timestamp) }
}

/** The provider application a publication is made through: Meta's app, or KrabiClaw's Discord application. */
function providerAppId(env: CloudflareEnv, channel: SocialChannel): string {
  const [name, value] = channel === 'facebook' ? ['FACEBOOK_APP_ID', env.FACEBOOK_APP_ID] : channel === 'instagram' ? ['INSTAGRAM_APP_ID', env.INSTAGRAM_APP_ID] : ['DISCORD_CLIENT_ID', env.DISCORD_CLIENT_ID]
  if (typeof value !== 'string' || !value) throw new Error(`${name} is not configured`)
  return value
}

/**
 * Publishes the post to one connected channel and records what the provider
 * answered: its post id, or its error. A failed publication is replaced by the
 * next call for the same post and channel.
 */
async function publishExternal(
  db: DbClient, env: CloudflareEnv, organizationId: string, post: Post, assets: AssetFacts[],
  target: Extract<PublishTarget, { channel: SocialChannel }>, existing: PublicationRecord | null,
  actorId: string | null,
): Promise<PublishOutcome> {
  const connection = await readConnection(env, organizationId, target.channel)
  if (!connection.connected || connection.targetId !== target.target_id || connection.revision !== target.connection_revision) return { channel: target.channel, target_id: target.target_id, status: 'failed', code: 'connection_changed', message: 'The channel connection changed; read get_social_connections again.' }
  const account = connection.accountId ? await readLinkedAccount(env, connection.accountId) : null
  if (!account) return { channel: target.channel, target_id: target.target_id, status: 'skipped', code: 'account_unlinked', message: `The ${target.channel} account behind this connection is no longer linked. Connect it again.` }
  const appId = providerAppId(env, target.channel)
  const payloadHash = await postPayloadFingerprint(post, { channel: target.channel, target_id: target.target_id })
  const id = existing?.id ?? crypto.randomUUID()
  const activityId = crypto.randomUUID()
  const started = organizationEventQuery({ id: activityId, organizationId, locationId: post.location_id, actorId,
    eventType: 'post.publication_started', entityType: 'post_publication', entityId: id,
    metadata: { post_id: post.id, channel: target.channel, target_id: target.target_id, payload_hash: payloadHash } })
  await execute(db, started.query, started.params ?? [])
  const context: ChannelContext = { env, post, caption: providerCaption(post.body, post.call_to_action), assets }
  let published: Published | null = null
  let failure: { code: string; message: string } | null = null
  try {
    published = target.channel === 'facebook' ? await publishToFacebook(context, await facebookTargetFor(env, connection))
      : target.channel === 'discord' ? await publishToDiscord(context, await discordTargetFor(env, connection), id)
        : await publishToInstagram(context, await instagramTargetFor(env, connection))
  } catch (error) {
    failure = failureOf(error)
  }
  const at = nowIso()
  await execute(db, `INSERT INTO post_publications (id, organization_id, post_id, channel, provider_app_id, provider_subject_id, provider_target_id, state,
      provider_post_id, provider_permalink, payload_hash, initiating_activity_id, error_code, error_message, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET provider_app_id = excluded.provider_app_id, provider_subject_id = excluded.provider_subject_id, provider_target_id = excluded.provider_target_id,
      state = excluded.state, provider_post_id = excluded.provider_post_id, provider_permalink = excluded.provider_permalink, payload_hash = excluded.payload_hash,
      initiating_activity_id = excluded.initiating_activity_id, error_code = excluded.error_code, error_message = excluded.error_message, published_at = excluded.published_at, updated_at = excluded.updated_at
      WHERE post_publications.state <> 'published' OR excluded.state = 'published'`,
  [id, organizationId, post.id, target.channel, appId, account.accountId, target.target_id, published ? 'published' : 'failed',
    published?.providerPostId ?? null, validPermalink(published?.permalink ?? null), payloadHash, activityId,
    failure?.code ?? null, failure ? failure.message.slice(0, 1000) : null, published?.publishedAt ?? null, at, at])
  const base = { channel: target.channel, target_id: target.target_id, publication_id: id }
  if (failure) return { ...base, status: 'failed', ...failure }
  return { ...base, status: 'published', public_url: validPermalink(published!.permalink), ...(published!.detail ? { code: 'details_unavailable', message: published!.detail } : {}) }
}

/** A receipt for a publication that already exists, read without changing anything. */
function receipt(publication: PublicationRecord): PublishOutcome {
  const base = { channel: publication.channel, target_id: publication.provider_target_id, publication_id: publication.id }
  if (publication.state === 'published') return { ...base, status: 'already_published', public_url: publication.provider_permalink }
  if (publication.state === 'removed') return { ...base, status: 'failed', code: 'removed', message: `The ${CHANNEL_NAMES[publication.channel]} post was removed. Create a new post to publish again.` }
  return { ...base, status: 'failed', code: publication.error_code ?? undefined, message: publication.error_message ?? undefined }
}

/**
 * Publishes one post to the targets the caller named, and nothing else.
 *
 * Existing results are read first, so a repeat returns the same receipts
 * without needing a fresh revision. A new target, or a first website
 * publication, needs the caller's current `updated_at` and the
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
  const post = await getPost(db, env, organizationId, postId)
  if (!post) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
  const stale = post.updated_at !== input.expectedUpdatedAt
  const staleOutcome = (channel: PublishOutcome['channel'], targetId: string): PublishOutcome => ({ channel, target_id: targetId, status: 'failed', code: 'stale_revision',
    message: `The post changed since it was read (now ${post.updated_at}); read it again and publish with the current updated_at` })
  const assets = await assetFacts(db, env, organizationId, post.media)
  const caption = providerCaption(post.body, post.call_to_action)
  const entitled = await hasOrganizationEntitlement(env, organizationId, 'managed_service')
  const outcomes: PublishOutcome[] = []
  const external: Array<{ target: Extract<PublishTarget, { channel: SocialChannel }>; record: PublicationRecord | null }> = []
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
    const record = existing ? await readPublication(db, organizationId, { id: existing.id }) : null
    if (existing && !record) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
    if (record && record.provider_target_id !== target.target_id) {
      outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', publication_id: record.id, code: 'target_conflict',
        message: `This post's ${target.channel} publication is to ${record.provider_target_id}; a post is published to one ${target.channel} target. Create a new post for another.` })
      continue
    }
    if (record && record.state !== 'failed') {
      outcomes.push(receipt(record))
      continue
    }
    const connection = await readConnection(env, organizationId, target.channel)
    if (!entitled) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'skipped', code: 'growth_plan_required', message: GROWTH_PLAN_REQUIRED }); continue }
    if (!connection.connected) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'skipped', code: 'not_connected', message: NOT_CONNECTED[target.channel] }); continue }
    if (connection.targetId !== target.target_id || connection.revision !== target.connection_revision) {
      outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', code: 'connection_changed',
        message: `The ${target.channel} connection is now ${connection.targetName ?? connection.targetId} at revision ${connection.revision}; read get_social_connections again` })
      continue
    }
    if (stale) { outcomes.push(staleOutcome(target.channel, target.target_id)); continue }
    if (!publishable(post)) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', code: 'empty_post', message: 'A post needs words, media or a call to action before it can be published' }); continue }
    const violation = formatViolation(target.channel, caption, assets)
    if (violation) { outcomes.push({ channel: target.channel, target_id: target.target_id, status: 'failed', ...violation }); continue }
    external.push({ target, record })
  }

  if (publishWebsite) {
    const now = new Date(Math.max(Date.now(), Date.parse(post.updated_at) + 1)).toISOString()
    const [result] = await executeBatch(db, [{
      query: `UPDATE content_documents SET status = 'published', published_at = COALESCE(published_at, ?), first_published_at = COALESCE(first_published_at, ?), updated_at = ?
        WHERE kind = 'social_post' AND row_role = 'root' AND id = ? AND organization_id = ? AND updated_at = ? AND status = 'draft'`,
      params: [now, now, now, postId, organizationId, input.expectedUpdatedAt],
    }, organizationEventQuery({ organizationId, locationId: post.location_id, actorId, eventType: 'post.published', entityType: 'post', entityId: postId,
      metadata: { channel: 'organization' }, onlyIfPreviousChangedOneRow: true }),
    opportunityDoneQuery(organizationId, ['post.publish'], postId, now),
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
  for (const { target, record } of external) outcomes.push(await publishExternal(db, env, organizationId, post, assets, target, record, actorId))

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
 * Reads the provider for one publication the owner asks about and records
 * what it proves. It never publishes, and it takes no one's word that
 * something is published: a supplied `provider_post_id` is read and must
 * belong to this publication's target.
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
  const postId = providerPostId ?? publication.provider_post_id
  if (!postId) return { publication: receipt(publication), state: publication.state, message: `Supply the ${CHANNEL_NAMES[publication.channel]} post id to read.` }
  const record = async (state: 'published' | 'failed', fields: { providerPostId: string; permalink?: string | null; publishedAt?: string | null; code?: string; message?: string }) => {
    const result = await execute(db, `UPDATE post_publications SET state = ?, provider_post_id = ?, provider_permalink = COALESCE(?, provider_permalink),
        published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`,
    [state, fields.providerPostId, validPermalink(fields.permalink ?? null), state, instantOf(fields.publishedAt),
      state === 'failed' ? fields.code ?? 'not_published' : null, state === 'failed' ? fields.message ?? null : null, nowIso(), publication.id, publication.updated_at])
    if (Number(result.meta?.changes ?? 0) !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'The publication changed while it was being reconciled; read it again' })
  }
  if (publication.channel === 'facebook') {
    const target = await facebookTargetFor(env, connection)
    if (postId.startsWith(`${target.pageId}_`)) {
      const read = await readPagePost(target, postId)
      if (read.isPublished) await record('published', { providerPostId: read.id, permalink: read.permalink, publishedAt: read.createdTime })
      else await record('failed', { providerPostId: read.id, code: publication.error_code ?? 'not_published', message: publication.error_message ?? `Facebook reads ${read.id} as not published` })
    } else {
      // A video id: a published upload, or a Reel whose finish named no Page post.
      const read = await readVideo(target, postId)
      if (read.published) await record('published', { providerPostId: read.postId ?? postId, permalink: read.permalink })
      else await record('failed', { providerPostId: postId, code: read.processing === 'error' ? 'provider_processing_failed' : 'not_published', message: read.error ?? `Facebook reads video ${postId} as not published` })
    }
  } else {
    const target = await instagramTargetFor(env, connection)
    const media = await readMedia(target, postId)
    const username = connection.targetName?.slice(1) ?? null
    if (!username || media.username !== username) throw new HTTPError({ statusCode: 409, statusMessage: `${media.id} belongs to @${media.username ?? 'another account'}, not @${username}` })
    await record('published', { providerPostId: media.id, permalink: media.permalink ?? null, publishedAt: media.timestamp })
  }
  const updated = await readPublication(db, organizationId, { id: publicationId })
  if (!updated) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
  return { publication: receipt(updated), state: updated.state }
}

/** Records the bot's message that one Discord publication became. */
async function reconcileDiscordPublication(env: CloudflareEnv, organizationId: string, publication: PublicationRecord, target: DiscordConnection, providerPostId: string | null) {
  const db = env.DB as DbClient
  if (publication.state === 'removed') throw new HTTPError({ statusCode: 409, statusMessage: 'This Discord publication was removed; create a new post to publish again' })
  const messageId = providerPostId ?? publication.provider_post_id
  if (!messageId) return { publication: receipt(publication), state: publication.state, message: 'Supply the Discord message id from list_channel_posts.' }
  const message = await readDiscordMessage(env, target, messageId)
  const result = await execute(db, `UPDATE post_publications SET state = 'published', provider_post_id = ?, provider_permalink = ?,
      published_at = COALESCE(published_at, ?), error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND updated_at = ? AND state IN ('published', 'failed')`,
  [message.id, discordMessageLink(target.guildId, message.channel_id, message.id), instantOf(message.timestamp), nowIso(), publication.id, publication.updated_at])
  if (Number(result.meta?.changes ?? 0) !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'The publication changed while it was being reconciled; read it again' })
  const updated = await readPublication(db, organizationId, { id: publication.id })
  if (!updated) throw new HTTPError({ statusCode: 404, statusMessage: 'Publication not found' })
  return { publication: receipt(updated), state: updated.state }
}

/** One message the KrabiClaw bot sent to the connected channel; anything else is refused. */
export async function readDiscordMessage(env: CloudflareEnv, target: DiscordConnection, messageId: string): Promise<DiscordMessage> {
  if (!/^\d{15,25}$/.test(messageId)) throw new HTTPError({ statusCode: 400, statusMessage: 'A Discord message id is a numeric snowflake.' })
  let message: DiscordMessage
  try {
    message = await getMessage(env, target.channelId, messageId)
  } catch (error) {
    if (error instanceof DiscordError && error.objectMissing) throw new HTTPError({ statusCode: 404, statusMessage: `The connected Discord channel has no message ${messageId}` })
    throw error
  }
  if (message.author.id !== env.DISCORD_CLIENT_ID) throw new HTTPError({ statusCode: 409, statusMessage: `Discord message ${message.id} was not sent by the KrabiClaw bot.` })
  return message
}
