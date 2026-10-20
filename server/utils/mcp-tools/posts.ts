import { postMutationJsonSchema, PostValidationError } from '~/shared/posts'
import type { McpToolDefinition } from './shared'
import { pageInfoObject, paginationInputSchema, postMutationResultObject, postObject, postPublishResultObject, organizationTool } from './shared'
import type { McpExecutorContext } from './execution'
import { MCP_ERROR, mcpProtocolError } from '~/server/utils/mcp-protocol'
import { HTTPError } from 'nitro'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createPost, deletePost, getPost, listPosts, updatePost, type Post } from '~/server/utils/post-management'
import { failureOf, getSocialConnections, parsePublishTargets, publishPost, reconcilePostPublication, SOCIAL_CHANNELS } from '~/server/utils/social-publication'
import { MetaGraphError } from '~/server/utils/meta-graph'
import { DiscordError } from '~/server/utils/discord-bot'
import { listChannelPosts, getChannelPost, deleteChannelPost, parseChannelTarget } from '~/server/utils/social-channel-posts'
import { dashboardOrigin } from '~/server/utils/dashboard-notification-links'
import { findOrganizationById } from '~/server/utils/member-access'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'
import { absolutizeOrganizationUrl, attachViewUrlToRecord, NOT_HANDLED, mutationContextPayload, omit, optionalString, requiredString } from './execution'

const { media: postMediaSchema, ...postUpdateProperties } = postMutationJsonSchema.properties

const publishTargetSchema = {
  anyOf: [
    { type: 'object', additionalProperties: false, properties: { channel: { enum: ['organization'] } }, required: ['channel'], description: 'The organization\'s website.' },
    {
      type: 'object', additionalProperties: false,
      properties: {
        channel: { enum: [...SOCIAL_CHANNELS] },
        target_id: { type: 'string', description: 'The Page, professional account or Discord channel id from get_social_connections.' },
        connection_revision: { type: 'string', description: 'The connection_revision get_social_connections returned with it.' },
      },
      required: ['channel', 'target_id', 'connection_revision'],
    },
  ],
} as const

const socialConnectionObject = {
  type: 'object',
  properties: {
    channel: { type: 'string', enum: [...SOCIAL_CHANNELS] },
    connected: { type: 'boolean' },
    target_id: { type: ['string', 'null'] },
    target_name: { type: ['string', 'null'] },
    connection_revision: { type: ['string', 'null'] },
    supported_formats: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } },
    supported_operations: { type: 'array', items: { type: 'string', enum: ['list', 'read', 'publish', 'delete'] } },
    deletion_unavailable_reason: { type: ['string', 'null'] },
    connect_url: { type: 'string', description: 'Where a person connects or changes this account in the dashboard.' },
  },
  required: ['channel', 'connected', 'target_id', 'target_name', 'connection_revision', 'supported_formats', 'problems', 'supported_operations', 'deletion_unavailable_reason', 'connect_url'],
}

const channelTargetProperties = {
  channel: { type: 'string', enum: [...SOCIAL_CHANNELS] },
  target_id: { type: 'string', description: 'The exact target_id returned by get_social_connections.' },
  connection_revision: { type: 'string', description: 'The connection_revision returned with that target.' },
} as const
const channelTargetRequired = ['channel', 'target_id', 'connection_revision']
const channelPostObject = {
  type: 'object', additionalProperties: false,
  properties: {
    channel: { type: 'string', enum: [...SOCIAL_CHANNELS] },
    target_id: { type: 'string' },
    provider_post_id: { type: 'string', description: 'Native provider identity, not a website post_id.' },
    body: { type: ['string', 'null'] },
    public_url: { type: ['string', 'null'], description: 'The provider link. A Discord message link opens only for members of that channel.' },
    published_at: { type: 'string' },
    media: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      provider_media_id: { type: ['string', 'null'] }, kind: { type: 'string', enum: ['image', 'video'] },
      public_url: { type: ['string', 'null'] }, thumbnail_url: { type: ['string', 'null'] },
    }, required: ['provider_media_id', 'kind', 'public_url', 'thumbnail_url'] } },
  },
  required: ['channel', 'target_id', 'provider_post_id', 'body', 'public_url', 'published_at', 'media'],
}

export const POSTS_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'get_social_connections',
    description: "Read the site’s website, Facebook Page, Instagram and Discord channel publishing connections before selecting a publication target. Returns target_id, connection_revision, supported formats and operations, setup links, and problems, including whether Meta currently accepts each connection and whether the KrabiClaw bot can still post to the connected Discord channel. Credentials are not returned.",
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: {},
    outputSchema: {
      type: 'object',
      properties: {
        website: { type: 'object', properties: { channel: { type: 'string', enum: ['organization'] }, target_id: { type: 'string' }, label: { type: 'string' } }, required: ['channel', 'target_id', 'label'] },
        channels: { type: 'array', items: socialConnectionObject },
      },
      required: ['website', 'channels'],
    },
  }),
  organizationTool({
    name: 'list_channel_posts',
    description: 'Read live posts directly from the explicitly selected connected Facebook Page, Instagram professional account or Discord channel; for Discord, the KrabiClaw bot\'s messages there. Does not import website posts or media. Read get_social_connections first and supply the exact channel, target_id and connection_revision. next_after is the provider\'s cursor; pass it as after for the next page.',
    domain: 'posts', minimumRole: 'admin', inputSchema: { ...channelTargetProperties, after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
    required: channelTargetRequired,
    outputSchema: { type: 'object', properties: { posts: { type: 'array', items: channelPostObject }, next_after: { type: ['string', 'null'] } }, required: ['posts', 'next_after'] },
  }),
  organizationTool({
    name: 'get_channel_post',
    description: "Read one post from the selected connected Facebook Page, Instagram professional account or Discord channel when the user wants its current caption, media or link. Use provider_post_id from list_channel_posts with the exact target from get_social_connections. Website content is unchanged.",
    domain: 'posts', minimumRole: 'admin', inputSchema: { ...channelTargetProperties, provider_post_id: { type: 'string' } },
    required: [...channelTargetRequired, 'provider_post_id'],
    outputSchema: { type: 'object', properties: { post: channelPostObject }, required: ['post'] },
  }),
  organizationTool({
    name: 'delete_channel_post',
    description: 'Permanently delete exactly the provider_post_id on the explicitly selected connected Facebook Page, or the KrabiClaw bot\'s message in the connected Discord channel. Keeps the website post and marks its publication receipt removed. Read get_social_connections and list_channel_posts first. Instagram deletion is unavailable with this app\'s Instagram Login connection; delete Instagram posts in Instagram. Use delete_post to remove website content separately.',
    domain: 'posts', minimumRole: 'admin', inputSchema: { ...channelTargetProperties, provider_post_id: { type: 'string' } },
    required: [...channelTargetRequired, 'provider_post_id'],
    outputSchema: { type: 'object', properties: {
      channel: { type: 'string', enum: ['facebook', 'discord'] }, target_id: { type: 'string' }, provider_post_id: { type: 'string' }, deleted: { type: 'boolean' },
      publication: { type: ['object', 'null'], properties: { id: { type: 'string' }, state: { type: 'string', enum: ['removed'] } }, required: ['id', 'state'] },
    }, required: ['channel', 'target_id', 'provider_post_id', 'deleted', 'publication'] },
  }),
  organizationTool({
    name: 'list_posts',
    description: "List draft or published short website posts when the user wants to find announcements to review or edit. Results are paginated, newest change first. Filter by location_id for one location. Use list_channel_posts for live Facebook or Instagram posts.",
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: {
      status: { type: 'string', enum: ['draft', 'published'] },
      location_id: { type: 'string', description: 'Only posts scoped to this location.' },
      ...paginationInputSchema,
    },
    outputSchema: {
      type: 'object',
      properties: { posts: { type: 'array', items: postObject }, page_info: pageInfoObject },
      required: ['posts', 'page_info'],
    },
  }),
  organizationTool({
    name: 'get_post',
    description: "Read a short website post before editing or publishing it. Returns its caption, call to action, ordered media, website status, draft preview link and stored Facebook, Instagram or Discord publication receipts. Use get_channel_post for current provider content.",
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: { post_id: { type: 'string' } },
    required: ['post_id'],
    outputSchema: { type: 'object', properties: { post: postObject }, required: ['post'] },
  }),
  organizationTool({
    name: 'create_post',
    description: "Create a draft short post when the user wants an announcement, event notice or offer. Supports a plain-text caption, ordered media, optional title, location and call to action. It stays private until publish_post. Use a new idempotency_key for each post and reuse it only for retries of that request. Long-form articles use create_blog_post.",
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: {
      idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'A value you make up once for this post, such as a UUID, and reuse only to retry this same request.' },
      ...postUpdateProperties,
      media: postMediaSchema,
    },
    required: ['idempotency_key'],
    outputSchema: postMutationResultObject,
  }),
  organizationTool({
    name: 'update_post',
    description: 'Change only supplied website post fields using its current revision. Published social posts are unchanged; unresolved publication prevents content edits.',
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: { post_id: { type: 'string' }, expected_updated_at: { type: 'string' }, ...postUpdateProperties },
    required: ['post_id', 'expected_updated_at'],
    outputSchema: postMutationResultObject,
  }),
  organizationTool({
    name: 'publish_post',
    description: 'Publish the post to the selected website or social destinations, returning one result per target. Retry processing with the same post; reconcile an unknown result before publishing again.',
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: {
      post_id: { type: 'string' },
      expected_updated_at: { type: 'string', description: 'The post\'s updated_at as you last read it.' },
      targets: { type: 'array', minItems: 1, maxItems: 1 + SOCIAL_CHANNELS.length, items: publishTargetSchema, description: 'One entry per destination, each channel at most once.' },
    },
    required: ['post_id', 'expected_updated_at', 'targets'],
    outputSchema: postPublishResultObject,
  }),
  organizationTool({
    name: 'reconcile_post_publication',
    description: 'Read an existing social publication and refresh its receipt without publishing. Supply provider_post_id only for the exact post on the connected destination; unproven outcomes remain unknown.',
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: {
      publication_id: { type: 'string', description: 'The publication id from get_post or a publish_post outcome.' },
      provider_post_id: { type: 'string', description: 'Optional: the Facebook post id, Instagram media id or Discord message id it became.' },
    },
    required: ['publication_id'],
    outputSchema: {
      type: 'object',
      properties: { state: { type: 'string' }, publication: { type: 'object' } },
      required: ['state', 'publication'],
    },
  }),
  organizationTool({
    name: 'delete_post',
    description: 'Delete a post from the website. Its Facebook, Instagram and Discord posts are not deleted; use delete_channel_post for an explicit supported channel deletion. Refused while a publication of it is in progress or unresolved.',
    domain: 'posts',
    minimumRole: 'admin',
    inputSchema: { post_id: { type: 'string' } },
    required: ['post_id'],
    outputSchema: {
      type: 'object',
      properties: { post_id: { type: 'string' }, deleted: { type: 'boolean' } },
      required: ['post_id', 'deleted'],
    },
  }),
]

/**
 * The MCP adapter for short posts: it authorizes nothing the domain does not,
 * and serializes the domain's own results. Every rule lives in
 * post-management, social-publication and social-channel-posts, which the dashboard
 * calls too.
 */

async function asMcpValidationError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof PostValidationError) throw mcpProtocolError(MCP_ERROR.invalidParams, error.message)
    throw error
  }
}

/** A draft has the path it will be published at, but no public URL until it is published. */
function forMcp(post: Post, organization: McpExecutorContext['organization']) {
  return {
    ...attachViewUrlToRecord(post, organization, { publicPath: post.status === 'published' ? post.public_path : null }),
    public_path: post.public_path,
    preview_url: absolutizeOrganizationUrl(organization, post.preview_url),
  }
}

export async function handlePostsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  const env = organization.env as CloudflareEnv
  switch (toolName) {
    case 'get_social_connections': {
      const record = await findOrganizationById(env, organization.organizationId)
      if (!record) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
      return await getSocialConnections(env, organization.organizationId, { dashboardBase: dashboardOrigin(env, { orgSlug: record.slug, locationSlug: null }) })
    }
    case 'list_posts': {
      const status = optionalString(args, 'status')
      const locationId = optionalString(args, 'location_id')
      const resource = { resource: `posts:${organization.organizationId}:${status ?? ''}:${locationId ?? ''}` }
      const page = await asMcpValidationError(() => listPosts(organization.db, env, organization.organizationId, { status, locationId },
        mcpPageWindow(args, resource), resource))
      return { posts: page.posts.map(post => forMcp(post, organization)), page_info: page.page_info }
    }
    case 'get_post': {
      const post = await getPost(organization.db, env, organization.organizationId, requiredString(args, 'post_id'))
      if (!post) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
      return { post: forMcp(post, organization) }
    }
    case 'create_post': {
      const { post, replayed } = await asMcpValidationError(() => createPost(organization.db, env, organization.organizationId,
        { post: omit(args, ['organization_id', 'idempotency_key']), idempotencyKey: requiredString(args, 'idempotency_key') }, organization.userId))
      return renderStructuredResponse(
        { ok: true, post: forMcp(post, organization), replayed, context: await mutationContextPayload(organization, { locationId: post.location_id }) },
        replayed ? `This idempotency_key already created the draft post ${post.id}.` : `Created draft post ${post.id}. It is not public until publish_post.`,
      )
    }
    case 'update_post': {
      const post = await asMcpValidationError(() => updatePost(organization.db, env, organization.organizationId, requiredString(args, 'post_id'),
        { changes: omit(args, ['post_id', 'organization_id', 'expected_updated_at']), expectedUpdatedAt: requiredString(args, 'expected_updated_at') }, organization.userId))
      if (!post) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
      return renderStructuredResponse(
        { ok: true, post: forMcp(post, organization), context: await mutationContextPayload(organization, { locationId: post.location_id }) },
        `Updated post ${post.id}.`,
      )
    }
    case 'publish_post': {
      let targets
      try { targets = parsePublishTargets(args.targets) } catch (error) {
        if (error instanceof HTTPError) throw mcpProtocolError(MCP_ERROR.invalidParams, error.message)
        throw error
      }
      const result = await publishPost(env, organization.organizationId, requiredString(args, 'post_id'),
        { expectedUpdatedAt: requiredString(args, 'expected_updated_at'), targets }, organization.userId)
      const summary = result.outcomes.map(outcome => `${outcome.channel}: ${outcome.status}${outcome.code ? ` (${outcome.code})` : ''}`).join('; ')
      return renderStructuredResponse(result as unknown as Record<string, unknown>, `${result.ok ? 'Published' : 'Not every target is published'} — ${summary}.`, undefined, !result.ok)
    }
    case 'reconcile_post_publication': {
      const result = await reconcilePostPublication(env, organization.organizationId, requiredString(args, 'publication_id'), optionalString(args, 'provider_post_id') ?? null)
      if (result.state !== 'published') throw new HTTPError({ statusCode: 409, statusMessage: ('message' in result ? result.message : undefined) ?? result.publication.message ?? `Publication is ${result.state}`, data: { code: 'POST_PUBLICATION_INCOMPLETE' } })
      return result
    }
    case 'list_channel_posts':
    case 'get_channel_post':
    case 'delete_channel_post': {
      try {
        const target = parseChannelTarget(args)
        if (toolName === 'list_channel_posts') {
          return await listChannelPosts(env, organization.organizationId, target, {
            after: optionalString(args, 'after') ?? null, limit: args.limit === undefined ? 25 : args.limit as number,
          })
        }
        if (toolName === 'get_channel_post') {
          return { post: await getChannelPost(env, organization.organizationId, target, requiredString(args, 'provider_post_id')) }
        }
        return await deleteChannelPost(env, organization.organizationId, target, requiredString(args, 'provider_post_id'), organization.userId)
      } catch (error) {
        if (error instanceof HTTPError && error.statusCode === 400) throw mcpProtocolError(MCP_ERROR.invalidParams, error.message)
        // The provider's own refusal, named the way publish_post names it, with
        // the place to reconnect when the connection itself is what failed.
        if (error instanceof MetaGraphError || error instanceof DiscordError) {
          const failure = failureOf(error)
          const channel = typeof args.channel === 'string' ? args.channel : null
          const record = failure.code === 'connection_error' && channel ? await findOrganizationById(env, organization.organizationId) : null
          const reconnect = record ? ` Reconnect ${channel} at ${dashboardOrigin(env, { orgSlug: record.slug, locationSlug: null })}/integrations/${channel}.` : ''
          throw new Error(`${failure.code}: ${failure.message}${reconnect}`, { cause: error })
        }
        throw error
      }
    }
    case 'delete_post': {
      const postId = requiredString(args, 'post_id')
      const deleted = await deletePost(organization.db, organization.organizationId, postId, organization.userId)
      if (!deleted) throw new HTTPError({ statusCode: 404, statusMessage: 'Post not found' })
      return { post_id: postId, deleted: true }
    }
    default:
      return NOT_HANDLED
  }
}
