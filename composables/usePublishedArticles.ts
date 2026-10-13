import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { collectionCategoryPath, type ArticleCollection } from '~/utils/article-collections'
import { isRecord, publicApiRequest } from '~/utils/api-clients'
import { validateApiShape } from '~/utils/api-validation'
import { resolveSeoUrl } from '~/composables/useSeoUrls'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import type { SocialImageSource } from '~/utils/social-metadata'
import type { BlogEditorBlock } from '~/lib/components/workspace/blog/types'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'

export interface PublishedArticle {
  id: string
  slug: string
  title: string
  excerpt?: string | null
  /** Its category, with the category page's path in the page's language. */
  category: (PublishedArticleCategoryRef & { path: string }) | null
  published_at?: string | null
  updated_at?: string | null
  sort_order: number
  cover?: { asset_id: string; public_url: string | null; thumbnail_url: string | null; kind: string | null; alt_text: string | null; width: number | null; height: number | null } | null
  /** Where this site serves the article, in the page's language. */
  path: string
}

/** An article's category as the article carries it. */
export interface PublishedArticleCategoryRef { id: string; name: string; slug: string }

interface PublishedArticlesResponse {
  posts: Array<Omit<PublishedArticle, 'path' | 'category'> & { category: PublishedArticleCategoryRef | null }>
  /** The page the site publishes at the collection's index path, if any. */
  index: { title: string; summary: string | null } | null
  /** The collection's categories that hold a published article, or sit above one, depth-first in the owner's order. */
  categories: Array<{ id: string; name: string; slug: string; description: string | null; parent_id: string | null; locales: string[] }>
  /** The languages the index is read in; a category page is the same prefix under its own path. */
  localeRepresentations: PublicLocaleRepresentation[]
}

export interface PublishedArticleCategory {
  id: string
  name: string
  slug: string
  description: string | null
  parent_id: string | null
  /** 1 at the top of the collection. */
  depth: number
  locales: string[]
  /** The category's own page, in the page's language. */
  path: string
  /** Its own articles, in the collection's order. */
  posts: PublishedArticle[]
  /** Its subcategories that hold an article in the page's language, in the owner's order. */
  children: PublishedArticleCategory[]
}

/** A category and the categories above it, from the top of the collection down to it. */
export function categoryTrail(categories: readonly PublishedArticleCategory[], id: string): PublishedArticleCategory[] {
  const byId = new Map(categories.map(category => [category.id, category]))
  const trail: PublishedArticleCategory[] = []
  for (let current = byId.get(id); current; current = current.parent_id ? byId.get(current.parent_id) : undefined) trail.unshift(current)
  return trail
}

/** A category and everything under it, depth-first. */
export function categorySubtree(category: PublishedArticleCategory): PublishedArticleCategory[] {
  return [category, ...category.children.flatMap(categorySubtree)]
}

/**
 * The site's published articles in one collection, in the page's language —
 * the one list every blog, the docs, the sidebar, previous/next and the
 * indexes read. It is what list_blog_posts returns, published and listed.
 * Categories keep the list's own order: the order the owner set, then newest
 * first.
 */
export async function usePublishedArticles(collection: MaybeRefOrGetter<ArticleCollection>) {
  const requestEvent = useRequestEvent()
  const { organizationId, template } = useTenantOrganization()
  if (!organizationId) throw createError({ statusCode: 404, statusMessage: 'Unknown tenant' })
  const { localePath } = useI18n()
  const locale = useState<string>('public-locale', () => 'en')

  const { data, pending, error } = await useAsyncData(
    () => `published-articles:${toValue(collection)}:${locale.value}`,
    async () => {
      if (import.meta.server) {
        if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
        const [{ cloudflareEnv }, { getArticleCollectionIndex, listArticleCollectionRepresentations, listPublishedArticles }, { listPublicArticleCategories }] = await Promise.all([
          import('~/server/utils/api-response'),
          import('~/server/utils/content/publishing'),
          import('~/server/utils/content/article-categories'),
        ])
        const env = cloudflareEnv(requestEvent)
        if (!env.db) throw createError({ statusCode: 503, statusMessage: 'Articles are temporarily unavailable' })
        const [posts, index, categories, localeRepresentations] = await Promise.all([
          listPublishedArticles(env.db, env, organizationId, toValue(collection), locale.value),
          getArticleCollectionIndex(env.db, organizationId, toValue(collection), locale.value),
          listPublicArticleCategories(env, env.db, organizationId, toValue(collection), locale.value),
          listArticleCollectionRepresentations(env, env.db, organizationId, toValue(collection)),
        ])
        return { posts, index, categories, localeRepresentations } as unknown as PublishedArticlesResponse
      }
      return await publicApiRequest<PublishedArticlesResponse>('/api/public/blog', {
        query: { collection: toValue(collection), locale: locale.value },
        validate: validateApiShape({ posts: { arrayOf: { id: 'string', slug: 'string', title: 'string', sort_order: 'number' } }, index: 'nullable-object',
          categories: { arrayOf: { id: 'string', name: 'string', slug: 'string', parent_id: 'nullable-string', locales: { arrayOf: 'string' } } }, localeRepresentations: { arrayOf: { locale: 'string', route_path: 'string' } } }),
      })
    },
  )
  const posts = computed<PublishedArticle[]>(() => (data.value?.posts ?? []).map(post => ({
    ...post,
    path: localePath(tenantBlogPostPath(template, post.slug, toValue(collection))),
    category: post.category ? { ...post.category, path: localePath(collectionCategoryPath(toValue(collection), post.category.slug)) } : null,
  })))

  // The owner's category tree, each category holding its own articles in the
  // collection's order — only the branches with an article in the page's language.
  const categoryTree = computed<PublishedArticleCategory[]>(() => {
    const nodes = (data.value?.categories ?? []).map((category): PublishedArticleCategory => ({
      ...category,
      depth: 1,
      path: localePath(collectionCategoryPath(toValue(collection), category.slug)),
      posts: posts.value.filter(post => post.category?.id === category.id),
      children: [],
    }))
    const byId = new Map(nodes.map(node => [node.id, node]))
    // The server lists parents before their children, so each parent's depth is known when its children arrive.
    for (const node of nodes) {
      const parent = node.parent_id ? byId.get(node.parent_id) : undefined
      if (!parent) continue
      node.depth = parent.depth + 1
      parent.children.push(node)
    }
    const holdsArticles = (node: PublishedArticleCategory): boolean => node.posts.length > 0 || node.children.some(holdsArticles)
    const prune = (list: PublishedArticleCategory[]): PublishedArticleCategory[] => list.filter(holdsArticles).map(node => Object.assign(node, { children: prune(node.children) }))
    return prune(nodes.filter(node => !node.parent_id || !byId.has(node.parent_id)))
  })
  /** Every category that is shown, depth-first. */
  const categories = computed(() => categoryTree.value.flatMap(categorySubtree))
  /** Uncategorized articles first, then each category's own articles and its subcategories'. */
  const readingOrder = computed(() => [
    ...posts.value.filter(post => !post.category),
    ...categories.value.flatMap(category => category.posts),
  ])

  if (error.value) throw error.value
  return { posts, categories, categoryTree, readingOrder, pending, index: computed(() => data.value?.index ?? null),
    localeRepresentations: computed(() => data.value?.localeRepresentations ?? []) }
}

export interface PublishedArticleDetail {
  id: string
  title: string
  slug: string
  excerpt?: string | null
  category: PublishedArticleCategoryRef | null
  seo_keywords?: string | null
  visibility?: 'listed' | 'unlisted'
  published_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  author?: { id: string; name: string | null; image: string | null } | null
  cover?: PublishedArticle['cover']
  social_image?: SocialImageSource | null
  content_blocks: BlogEditorBlock[]
  localeRepresentations: PublicLocaleRepresentation[]
}

const isArticleResponse = (value: unknown): value is { post: PublishedArticleDetail } =>
  isRecord(value) && isRecord(value.post)
  && typeof value.post.id === 'string' && typeof value.post.title === 'string' && typeof value.post.slug === 'string'
  && Array.isArray(value.post.content_blocks) && Array.isArray(value.post.localeRepresentations)

/**
 * One published article of a collection, in the page's language — the read
 * every article page on every template makes, through getPublishedBlogPost on
 * the server and its public route in the browser. A missing article is a 404;
 * a failed read is the failure it was, not a 404.
 */
export async function usePublishedArticle(collection: ArticleCollection, slug: MaybeRefOrGetter<string>) {
  const requestEvent = useRequestEvent()
  const { organizationId } = useTenantOrganization()
  if (!organizationId) throw createError({ statusCode: 404, statusMessage: 'Unknown tenant' })
  const locale = useState<string>('public-locale', () => 'en')
  // Taken before the read: after an await the component's context is gone.
  const localeRepresentations = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])

  const { data, error } = await useAsyncData(
    () => `published-article:${collection}:${locale.value}:${toValue(slug)}`,
    async () => {
      if (import.meta.server) {
        if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
        const [{ cloudflareEnv }, { getPublishedBlogPost }] = await Promise.all([
          import('~/server/utils/api-response'),
          import('~/server/utils/content/publishing'),
        ])
        const env = cloudflareEnv(requestEvent)
        if (!env.db) throw createError({ statusCode: 503, statusMessage: 'Articles are temporarily unavailable' })
        // Preview authorization is the site's, resolved once by tenant resolution from the preview cookie.
        const post = await getPublishedBlogPost(env.db, organizationId, collection, toValue(slug), locale.value, env, Boolean(requestEvent.context.previewAuthorized))
        if (!post) throw createError({ statusCode: 404, statusMessage: 'Article not found' })
        return post as unknown as PublishedArticleDetail
      }
      const response = await publicApiRequest<{ post: PublishedArticleDetail }>(`/api/public/blog/${encodeURIComponent(toValue(slug))}`, {
        query: { collection, locale: locale.value },
        validate: isArticleResponse,
      })
      return response.post
    },
  )
  if (error.value) throw error.value
  if (!data.value) throw createError({ statusCode: 404, statusMessage: 'Article not found', fatal: true })
  if (!data.value.content_blocks.length) throw createError({ statusCode: 500, statusMessage: 'Published article content is missing its canonical blocks' })
  // The language switcher offers this article's own translations.
  localeRepresentations.value = data.value.localeRepresentations
  return computed(() => data.value!)
}

/**
 * The `ItemList` an index or a category page publishes, on every template: the
 * articles it lists, in its order, by their absolute URLs on this site. Tenant
 * pages publish their lists this way too (a product collection's ItemList).
 */
export function useArticleItemList(listPath: MaybeRefOrGetter<string>, name: MaybeRefOrGetter<string>, articles: MaybeRefOrGetter<readonly PublishedArticle[]>) {
  const { template } = useTenantOrganization()
  const requestURL = useRequestURL()
  const runtimeConfig = useRuntimeConfig()
  return computed(() => {
    const origin = template.slug === 'platform' ? runtimeConfig.public.siteUrl : requestURL.origin
    return {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      '@id': `${resolveSeoUrl(toValue(listPath), origin)}#articles`,
      url: resolveSeoUrl(toValue(listPath), origin),
      name: toValue(name),
      numberOfItems: toValue(articles).length,
      mainEntityOfPage: { '@id': `${resolveSeoUrl(toValue(listPath), origin)}#webpage` },
      itemListElement: toValue(articles).map((article, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'WebPage',
          '@id': `${resolveSeoUrl(article.path, origin)}#webpage`,
          name: article.title,
          url: resolveSeoUrl(article.path, origin),
        },
      })),
    }
  })
}
