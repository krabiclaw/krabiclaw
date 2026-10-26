import type { McpToolDefinition } from './shared'
import { articleCategoryObject, blogPostMutationResultObject, blogPostObject, blogPostSummaryObject, contentBlockMediaInputRef, contentBlockTypeBranches, contentBlockUpdatedAtInput, pageInfoObject, paginationInputSchema, organizationTool } from './shared'
import { PUBLICATION_CONTENT_BLOCK_TYPES, contentBlockDataSchema } from '~/shared/content-registries'
import type { McpExecutorContext } from './execution'
import { BLOG_UPDATE_MUTATION_FIELDS, createBlogPost, deleteBlogPost, getBlogPost, listBlogPosts, reorderArticles, updateBlogLifecycle, updateBlogPost } from '~/server/utils/content/publishing'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { isArticleCollection, type ArticleCollection } from '~/utils/article-collections'
import { mcpProtocolError, MCP_ERROR } from '~/server/utils/mcp-protocol'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'
import { absolutizeOrganizationUrl, NOT_HANDLED, omit, optionalString, requiredString } from './execution'
import { CONTENT_BLOCK_TYPES } from '~/server/utils/content/documents'
import { createArticleCategory, deleteArticleCategory, listArticleCategories, reorderArticleCategories, updateArticleCategory, type ArticleCategory } from '~/server/utils/content/article-categories'

// A block's place is its index in the array; there is no position to state.
// An image block carries exactly one media item, or it is refused.
const blogContentBlockProperties = {
  id: { type: 'string' },
  type: { type: 'string', enum: [...PUBLICATION_CONTENT_BLOCK_TYPES] },
  source_block_id: { type: ['string', 'null'] },
  parent_block_id: { type: ['string', 'null'] },
  level: { type: ['number', 'null'] },
  data: { anyOf: PUBLICATION_CONTENT_BLOCK_TYPES.map(type => ({ ...contentBlockDataSchema(type), title: type })) },
  media: { type: 'array', items: contentBlockMediaInputRef, description: 'Required on image blocks: one item, the picture. A block read back keeps its media by sending it as read.' },
  updated_at: contentBlockUpdatedAtInput,
}

const blogContentBlockSchema = {
  type: 'object',
  properties: blogContentBlockProperties,
  required: ['type', 'data'],
  additionalProperties: false,
  anyOf: contentBlockTypeBranches({ properties: blogContentBlockProperties, required: ['type', 'data'], additionalProperties: false }, PUBLICATION_CONTENT_BLOCK_TYPES),
} as const

const articleCategoryResult = {
  type: 'object',
  properties: { category: articleCategoryObject },
  required: ['category'],
  additionalProperties: false,
} as const

const articleCategoryListResult = {
  type: 'object',
  properties: { categories: { type: 'array', items: articleCategoryObject } },
  required: ['categories'],
  additionalProperties: false,
} as const

const publicationFields = ['id', 'title', 'collection', 'visibility', 'status', 'published', 'published_at', 'updated_at', 'public_url'] as const
const articlePublicationResult = {
  type: 'object',
  properties: {
    post: { type: 'object', properties: Object.fromEntries(publicationFields.map(field => [field, blogPostSummaryObject.properties[field]])), required: [...publicationFields], additionalProperties: false },
    changed: { type: 'boolean' },
  },
  required: ['post', 'changed'],
  additionalProperties: false,
} as const

export const BLOG_TOOLS: McpToolDefinition[] = [
  organizationTool({
      name: 'list_blog_posts',
      description: "List draft and published long-form articles in the selected site’s blog or documentation collection. Results are paginated in public display order. Short website posts are listed separately by list_posts.",
      domain: 'blog',
      minimumRole: 'admin',
      inputSchema: { status: { type: 'string', enum: ['draft', 'published'] }, collection: { type: 'string', enum: ['blog', 'docs'] }, ...paginationInputSchema },
      outputSchema: {
        type: 'object',
        properties: { posts: { type: 'array', items: blogPostSummaryObject }, page_info: pageInfoObject },
        required: ['posts', 'page_info'],
        additionalProperties: false,
      },
    }),
  organizationTool({
      name: 'get_blog_post',
      description: "Read one blog or documentation article by ID or slug, including its ordered content_blocks and updated_at token. Use that token when editing or publishing the article.",
      domain: 'blog',
      minimumRole: 'admin',
      inputSchema: { post_id: { type: 'string', description: 'Post id or slug.' } },
      required: ['post_id'],
      outputSchema: {
        type: 'object',
        properties: {
          post: blogPostObject,
        },
        required: ['post'],
        additionalProperties: false,
      },
    }),
  organizationTool({
      name: 'create_blog_post',
      description: "Create a draft blog or documentation article with ordered content_blocks. It stays private until published. A category in the selected collection is required for publication. Use a new idempotency_key for each article; retrying the same key returns the same article. The preview_url allows draft review. When linking to dashboard settings in markdown copy, use /dashboard/app/<path> (e.g. /dashboard/app/products) so the link dynamically resolves to the reader's active organization.",
      domain: 'blog',
      minimumRole: 'admin',
      inputSchema: {
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'A value you make up once for this article, such as a UUID, and reuse only to retry this same request.' },
        title: { type: 'string' },
        excerpt: { type: 'string' },
        collection: { type: 'string', enum: ['blog', 'docs'], description: "Which of the site's collections the article belongs to: its blog, or its documentation. Defaults to the blog." },
        category_id: { type: 'string', description: "The article's category: the id of one of its collection's categories (list_article_categories). Required before publish_blog_post. To use a category that does not exist yet, create it with create_article_category first." },
        content_blocks: { type: 'array', minItems: 1, description: 'The article, in order. Any number of blocks of any type, images wherever they belong. The first block, when it is an image, is the cover.', items: blogContentBlockSchema },
        visibility: { type: 'string', enum: ['listed', 'unlisted'], description: 'Unlisted posts work by direct URL but are excluded from indexes, search, feeds, and sitemap.' },
      },
      required: ['idempotency_key', 'title', 'content_blocks'],
      outputSchema: blogPostMutationResultObject,
    }),
  organizationTool({
      name: 'update_blog_post',
      description: "Edit the selected blog or documentation article. Only supplied metadata changes; content_blocks replaces the entire body and requires expected_updated_at from the latest read. Stale tokens conflict. Changes to a published article are public immediately. When linking to dashboard settings in markdown copy, use /dashboard/app/<path> (e.g. /dashboard/app/products) so the link dynamically resolves to the reader's active organization.",
      domain: 'blog',
      minimumRole: 'admin',
      inputSchema: {
        post_id: { type: 'string', description: 'Post id or slug.' },
        title: { type: 'string' },
        excerpt: { type: 'string' },
        collection: { type: 'string', enum: ['blog', 'docs'], description: "Move the article to the site's blog or its documentation. Omit to leave it where it is." },
        category_id: { type: 'string', description: "The article's category: the id of one of its collection's categories (list_article_categories). Required before publish_blog_post. To use a category that does not exist yet, create it with create_article_category first." },
        content_blocks: { type: 'array', minItems: 1, description: 'The whole article, in order, replacing every block. Blocks read back keep their id. The first block, when it is an image, is the cover.', items: blogContentBlockSchema },
        expected_updated_at: { type: 'string', description: 'Required with content_blocks. Use updated_at returned by get_blog_post; stale tokens are rejected with a conflict.' },
        visibility: { type: 'string', enum: ['listed', 'unlisted'] },
        anyOf: ['title', 'excerpt', 'collection', 'category_id', 'content_blocks', 'visibility'].map(field => ({ required: [field] })),
        allOf: [{ if: { required: ['content_blocks'] }, then: { required: ['expected_updated_at'] } }],
      },
      required: ['post_id'],
      outputSchema: {
        ...blogPostMutationResultObject,
        properties: {
          ...blogPostMutationResultObject.properties,
          changed: { type: 'boolean', description: 'Whether this request changed the stored article. An equivalent save leaves its revision unchanged.' },
        },
        required: ['post', 'changed'],
      },
    }),
  organizationTool({
      name: 'publish_blog_post',
      description: "Publish the selected draft blog or documentation article when publication is requested. Requires expected_updated_at from the latest read. An already published article is unchanged, including its date and announcement. Returns its publication state, revision and website URL; this does not publish to Facebook or Instagram.",
      domain: 'blog', minimumRole: 'admin', inputSchema: {
        post_id: { type: 'string', description: 'Post id or slug.' },
        expected_updated_at: { type: 'string', description: 'Exact post.updated_at concurrency token from the latest get_blog_post or successful blog mutation.' },
      },
      required: ['post_id', 'expected_updated_at'],
      outputSchema: articlePublicationResult,
    }),
  organizationTool({
      name: 'reorder_blog_posts',
      description: "Replace the public display order of articles in one blog or documentation collection. Supply every article ID in that collection exactly once, including drafts. New articles with sort_order 0 appear first until ordered; category ordering is separate.",
      domain: 'blog',
      minimumRole: 'admin',
      inputSchema: {
        collection: { type: 'string', enum: ['blog', 'docs'] },
        post_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['collection', 'post_ids'],
      outputSchema: {
        type: 'object',
        properties: { posts: { type: 'array', items: blogPostSummaryObject } },
        required: ['posts'],
      },
    }),
  organizationTool({
      name: 'delete_blog_post',
      description: "Permanently delete the selected blog or documentation article and its owned content. Use only when the user requests removing that article; a published article is removed from the website.",
      domain: 'blog',
      minimumRole: 'admin',
      inputSchema: { post_id: { type: 'string', description: 'Post id or slug.' } },
      required: ['post_id'],
      outputSchema: {
        type: 'object',
        properties: { post_id: { type: 'string' }, deleted: { type: 'boolean' } },
        required: ['post_id', 'deleted'],
        additionalProperties: false,
      },
    }),
  organizationTool({
      name: 'list_article_categories',
      description: "List categories and subcategories in one site blog or documentation collection, in public display order, with article and child-category counts. Published articles require a category in their collection.",
      domain: 'blog', minimumRole: 'admin', inputSchema: { collection: { type: 'string', enum: ['blog', 'docs'] } },
      required: ['collection'],
      outputSchema: articleCategoryListResult,
    }),
  organizationTool({
      name: 'create_article_category',
      description: 'Create a category in the blog or the documentation, at the top level or under another category (parent_id). It goes last among its siblings; place it with reorder_article_categories. Its slug comes from the name and does not change later. Returns the category and ID; articles are assigned separately.',
      domain: 'blog', minimumRole: 'admin', inputSchema: {
        collection: { type: 'string', enum: ['blog', 'docs'] },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        parent_id: { type: ['string', 'null'], description: 'The category this one sits under, in the same collection; null or omitted for the top level. Categories nest at most 3 levels deep.' },
        description: { type: ['string', 'null'], maxLength: 500, description: 'What the category covers, shown on its page and used as the page description.' },
      },
      required: ['collection', 'name'],
      outputSchema: articleCategoryResult,
    }),
  organizationTool({
      name: 'update_article_category',
      description: "Rename a category, change its description, or move it under another category (parent_id; null moves it to the top level, where it goes last). Its page's address (slug) stays the same. Omitted fields stay unchanged; returns the updated category without moving its articles.",
      domain: 'blog', minimumRole: 'admin', inputSchema: {
        category_id: { type: 'string' },
        parent_id: { type: ['string', 'null'], description: 'Omit to retain the current parent; null moves the category to the top level. A supplied parent must be in the same collection. Categories nest at most 3 levels deep.' },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        description: { type: ['string', 'null'], maxLength: 500 },
        anyOf: ['parent_id', 'name', 'description'].map(field => ({ required: [field] })),
      },
      required: ['category_id'],
      outputSchema: articleCategoryResult,
    }),
  organizationTool({
      name: 'delete_article_category',
      description: 'Delete an empty category. A category that still has articles or subcategories is refused with how many it holds: ask the user where they should go, move each article with update_blog_post (category_id) and each subcategory with update_article_category (parent_id), then delete it.',
      domain: 'blog', minimumRole: 'admin', inputSchema: { category_id: { type: 'string' } },
      required: ['category_id'],
      outputSchema: {
        type: 'object',
        properties: { category_id: { type: 'string' }, deleted: { type: 'boolean' } },
        required: ['category_id', 'deleted'],
        additionalProperties: false,
      },
    }),
  organizationTool({
      name: 'reorder_article_categories',
      description: "Set the order of one set of sibling categories on the public site — the index, its sidebar and the menu: the collection's top level (parent_id null or omitted), or one category's subcategories. Send every sibling id exactly once; a partial order is rejected.",
      domain: 'blog', minimumRole: 'admin', inputSchema: {
        collection: { type: 'string', enum: ['blog', 'docs'] },
        parent_id: { type: ['string', 'null'], description: 'Whose subcategories are being ordered; null or omitted for the top level.' },
        category_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['collection', 'category_ids'],
      outputSchema: articleCategoryListResult,
    }),
]

const ARTICLE_COLLECTIONS_SET = new Set(['blog', 'docs'])

function optionalArticleCollection(args: Record<string, unknown>): ArticleCollection | null {
  if (args.collection === undefined || args.collection === null) return null
  if (!isArticleCollection(args.collection)) throw mcpProtocolError(MCP_ERROR.invalidParams, 'collection must be blog or docs.')
  return args.collection
}

const BLOG_CONTENT_BLOCK_TYPES = new Set<string>(CONTENT_BLOCK_TYPES)

const BLOG_POST_STATUSES = new Set(['draft', 'published'])
const BLOG_VISIBILITIES = new Set(['listed', 'unlisted'])

function hasAnyField(args: Record<string, unknown>, fields: readonly string[]) {
  return fields.some(field => Object.prototype.hasOwnProperty.call(args, field))
}

function requireAtLeastOneField(args: Record<string, unknown>, fields: readonly string[], message: string) {
  if (!hasAnyField(args, fields)) throw mcpProtocolError(MCP_ERROR.invalidParams, message)
}

function invalidBlogResponse(path: string, expected: string): never {
  throw mcpProtocolError(MCP_ERROR.internal, `Blog service returned invalid ${path}; expected ${expected}.`)
}

function responseRecord(value: unknown, path: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidBlogResponse(path, 'an object')
  return value as Record<string, unknown>
}

function responseString(value: unknown, path: string) {
  if (typeof value !== 'string' || !value) invalidBlogResponse(path, 'a non-empty string')
  return value
}

function responseEnumString(value: unknown, path: string, allowed: Set<string>) {
  const result = responseString(value, path)
  if (!allowed.has(result)) invalidBlogResponse(path, `one of ${[...allowed].join(', ')}`)
  return result
}

function responseNullableString(value: unknown, path: string) {
  if (value === null) return null
  if (typeof value !== 'string') invalidBlogResponse(path, 'a string or null')
  return value
}

function responseNullableNumber(value: unknown, path: string) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidBlogResponse(path, 'a finite number or null')
  return value
}

function responseInteger(value: unknown, path: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidBlogResponse(path, 'an integer')
  return value
}

function responseBoolean(value: unknown, path: string) {
  if (typeof value !== 'boolean') invalidBlogResponse(path, 'a boolean')
  return value
}

function toMedia(value: unknown) {
  if (!Array.isArray(value)) invalidBlogResponse('post.media', 'an array')
  return value.map((item, index) => {
    const path = `post.media[${index}]`
    const media = responseRecord(item, path)
    return {
      asset_id: responseString(media.asset_id, `${path}.asset_id`),
      slot: responseString(media.slot, `${path}.slot`),
      public_url: responseNullableString(media.public_url, `${path}.public_url`),
      kind: responseNullableString(media.kind, `${path}.kind`),
      width: responseNullableNumber(media.width, `${path}.width`),
      height: responseNullableNumber(media.height, `${path}.height`),
    }
  })
}

function toCover(value: unknown) {
  if (value === null || value === undefined) return null
  const cover = responseRecord(value, 'post.cover')
  return {
    asset_id: responseString(cover.asset_id, 'post.cover.asset_id'),
    public_url: responseNullableString(cover.public_url, 'post.cover.public_url'),
    thumbnail_url: responseNullableString(cover.thumbnail_url, 'post.cover.thumbnail_url'),
    kind: responseNullableString(cover.kind, 'post.cover.kind'),
    alt_text: responseNullableString(cover.alt_text, 'post.cover.alt_text'),
    width: responseNullableNumber(cover.width, 'post.cover.width'),
    height: responseNullableNumber(cover.height, 'post.cover.height'),
  }
}

function toContentBlockProjection(value: unknown, index: number) {
  const path = `post.content_document.blocks[${index}]`
  const block = responseRecord(value, path)
  const data = responseRecord(block.data, `${path}.data`)
  return {
    id: responseString(block.id, `${path}.id`),
    parent_block_id: responseNullableString(block.parent_block_id, `${path}.parent_block_id`),
    type: responseEnumString(block.type, `${path}.type`, BLOG_CONTENT_BLOCK_TYPES),
    level: responseNullableNumber(block.level, `${path}.level`),
    data,
    media: toMedia(block.media),
    updated_at: responseString(block.updated_at, `${path}.updated_at`),
  }
}

function toCategoryRef(value: unknown) {
  if (value === null) return null
  const category = responseRecord(value, 'post.category')
  return { id: responseString(category.id, 'post.category.id'), name: responseString(category.name, 'post.category.name'), slug: responseString(category.slug, 'post.category.slug') }
}

function toArticleCategory(category: ArticleCategory) {
  return { id: category.id, collection: category.collection, name: category.name, slug: category.slug,
    description: category.description, parent_id: category.parent_id, sort_order: category.sort_order,
    article_count: category.article_count, child_count: category.child_count }
}

function requiredArticleCollection(args: Record<string, unknown>): ArticleCollection {
  const collection = optionalArticleCollection(args)
  if (!collection) throw mcpProtocolError(MCP_ERROR.invalidParams, 'collection is required.')
  return collection
}

function toBlogPostSummary(post: Record<string, unknown>, organization: McpExecutorContext['organization']) {
  const publicUrl = absolutizeOrganizationUrl(organization, responseNullableString(post.public_url, 'post.public_url'))
  return {
    id: responseString(post.id, 'post.id'),
    title: responseString(post.title, 'post.title'),
    slug: responseString(post.slug, 'post.slug'),
    excerpt: responseNullableString(post.excerpt, 'post.excerpt'),
    collection: responseEnumString(post.collection ?? 'blog', 'post.collection', ARTICLE_COLLECTIONS_SET),
    category: toCategoryRef(post.category),
    sort_order: responseInteger(post.sort_order, 'post.sort_order'),
    seo_keywords: responseNullableString(post.seo_keywords, 'post.seo_keywords'),
    published: responseBoolean(post.published, 'post.published'),
    published_at: responseNullableString(post.published_at, 'post.published_at'),
    status: responseEnumString(post.status, 'post.status', BLOG_POST_STATUSES),
    visibility: responseEnumString(post.visibility, 'post.visibility', BLOG_VISIBILITIES),
    created_at: responseString(post.created_at, 'post.created_at'),
    updated_at: responseString(post.updated_at, 'post.updated_at'),
    cover: toCover(post.cover),
    admin_edit_url: responseNullableString(post.admin_edit_url, 'post.admin_edit_url'),
    edit_url: responseNullableString(post.edit_url, 'post.edit_url'),
    public_path: responseNullableString(post.public_path, 'post.public_path'),
    public_url: publicUrl,
    preview_url: absolutizeOrganizationUrl(organization, responseNullableString(post.preview_url, 'post.preview_url')),
    view_url: publicUrl,
  }
}

export function projectBlogPostForMcp(post: Record<string, unknown>, organization: McpExecutorContext['organization']) {
  const contentDocument = responseRecord(post.content_document, 'post.content_document')
  if (!Array.isArray(contentDocument.blocks)) invalidBlogResponse('post.content_document.blocks', 'an array')
  return {
    ...toBlogPostSummary(post, organization),
    content_blocks: contentDocument.blocks.map((block, index) => toContentBlockProjection(block, index)),
  }
}

export async function handleBlogTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case "list_blog_posts":
      {
        const status = optionalString(args, "status");
        const collection = optionalArticleCollection(args);
        const resource = { resource: `blog-posts:${organization.organizationId}:${status ?? ''}:${collection ?? ''}` };
        const page = await listBlogPosts(organization.db, organization.organizationId, status, organization.env, mcpPageWindow(args, resource), resource, collection);
        return { posts: page.posts.map((post) => toBlogPostSummary(post, organization)), page_info: page.page_info };
      }
    case "get_blog_post":
      {
        const post = await getBlogPost(
          organization.db,
          requiredString(args, "post_id"),
          organization.organizationId,
          organization.env,
        );
        return {
          post: projectBlogPostForMcp(post, organization),
        };
      }
    case "create_blog_post": {
      const result = await createBlogPost(
        organization.db,
        organization.userId,
        args as never,
        { organization_id: organization.organizationId, },
        organization.env,
      );
      return renderStructuredResponse(
        { post: projectBlogPostForMcp(result.post, organization) },
        `Created draft blog article "${result.post.title ?? result.post.id}". It is not public until publish_blog_post.`,
      );
    }
    case "update_blog_post": {
      requireAtLeastOneField(args, BLOG_UPDATE_MUTATION_FIELDS, "At least one blog mutation field is required.")
      const result = await updateBlogPost(
        organization.db,
        requiredString(args, "post_id"),
        omit(args, ["post_id", "organization_id"]) as never,
        organization.organizationId,
        organization.userId,
        organization.env,
      );
      return renderStructuredResponse(
        { post: projectBlogPostForMcp(result.post, organization), changed: result.changed },
        result.changed ? `Saved changes to blog article "${result.post.title ?? result.post.id}".` : `Blog article "${result.post.title ?? result.post.id}" is unchanged.`,
      );
    }
    case "publish_blog_post": {
      const postId = requiredString(args, "post_id")
      const lifecycle = await updateBlogLifecycle(organization.db, postId, {
        expected_updated_at: requiredString(args, 'expected_updated_at'),
      }, organization.organizationId, organization.userId)
      const result = await getBlogPost(organization.db, postId, organization.organizationId, organization.env)
      const summary = toBlogPostSummary(result, organization)
      return renderStructuredResponse(
        { post: Object.fromEntries(publicationFields.map(field => [field, summary[field]])), changed: lifecycle.changed },
        lifecycle.changed ? `Published blog article "${result.title}".` : `Blog article "${result.title}" was already published; nothing changed.`,
      )
    }
    case "reorder_blog_posts": {
      const collection = requiredArticleCollection(args)
      if (!Array.isArray(args.post_ids) || args.post_ids.some(id => typeof id !== 'string' || !id.trim())) {
        throw mcpProtocolError(MCP_ERROR.invalidParams, 'post_ids must contain non-empty post ids.')
      }
      await reorderArticles(organization.db, organization.organizationId, collection, args.post_ids.map(id => String(id).trim()))
      // The order that was set, read back whole: every article in the collection, in it.
      const posts: Awaited<ReturnType<typeof listBlogPosts>>['posts'] = []
      const resource = { resource: `article-order:${organization.organizationId}:${collection}` }
      for (let offset = 0, more = true; more; offset += 100) {
        const page = await listBlogPosts(organization.db, organization.organizationId, null, organization.env, { limit: 100, offset }, resource, collection)
        posts.push(...page.posts)
        more = page.page_info.has_more
      }
      return { posts: posts.map(post => toBlogPostSummary(post, organization)) }
    }
    case "list_article_categories": {
      const categories = await listArticleCategories(organization.db, organization.organizationId, requiredArticleCollection(args))
      return { categories: categories.map(toArticleCategory) }
    }
    case "create_article_category": {
      const category = await createArticleCategory(organization.db, { organizationId: organization.organizationId,
        collection: requiredArticleCollection(args), name: args.name, description: args.description, parentId: args.parent_id, actorId: organization.userId })
      return renderStructuredResponse({ category: toArticleCategory(category) }, `Created ${category.collection} category "${category.name}".`)
    }
    case "update_article_category": {
      const category = await updateArticleCategory(organization.db, { organizationId: organization.organizationId,
        categoryId: requiredString(args, 'category_id'), name: args.name, description: args.description, parentId: args.parent_id, actorId: organization.userId })
      return renderStructuredResponse({ category: toArticleCategory(category) }, `Saved category "${category.name}".`)
    }
    case "delete_article_category": {
      const categoryId = requiredString(args, 'category_id')
      await deleteArticleCategory(organization.db, { organizationId: organization.organizationId, categoryId })
      return { category_id: categoryId, deleted: true }
    }
    case "reorder_article_categories": {
      const categories = await reorderArticleCategories(organization.db, { organizationId: organization.organizationId,
        collection: requiredArticleCollection(args), parentId: args.parent_id, categoryIds: args.category_ids, actorId: organization.userId })
      return { categories: categories.map(toArticleCategory) }
    }
    case "delete_blog_post": {
      const postId = requiredString(args, "post_id");
      await deleteBlogPost(organization.db, postId, organization.organizationId);
      return { post_id: postId, deleted: true };
    }
    default:
      return NOT_HANDLED
  }
}
