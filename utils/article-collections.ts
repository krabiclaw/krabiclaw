/**
 * An article belongs to a collection. Every site has a blog; KrabiClaw's own
 * site (the platform template) also publishes documentation. Both collections
 * share the article model, the editor, the renderer, the feeds and the
 * markdown mirror; the collection decides the URL prefix and nothing else.
 *
 * Both used to file articles under a fixed list of category labels written in
 * code, and to put the matching slug in the URL. Neither list was a hierarchy:
 * `/docs/{category}` only ever resolved when some article's slug happened to
 * equal the category slug, and four of documentation's six declared categories
 * held no article at all. What the list did do was make the category a
 * required field an author could not add to — and, because an article filed
 * under an undeclared category had no URL, drop it from every index silently.
 *
 * A category is now a record of its collection (server/utils/content/article-categories.ts):
 * the owner names and orders them, every published article is in one, and
 * each has its own page at `{prefix}/category/{slug}`.
 */
export type ArticleCollection = 'blog' | 'docs'

export interface ArticleCollectionDefinition {
  slug: ArticleCollection
  label: string
  pathPrefix: string
}

export const ARTICLE_COLLECTIONS: Record<ArticleCollection, ArticleCollectionDefinition> = {
  blog: { slug: 'blog', label: 'Blog', pathPrefix: '/blog' },
  docs: { slug: 'docs', label: 'Documentation', pathPrefix: '/docs' },
}

export const ARTICLE_COLLECTION_SLUGS = Object.keys(ARTICLE_COLLECTIONS) as ArticleCollection[]

export function isArticleCollection(value: unknown): value is ArticleCollection {
  return typeof value === 'string' && Object.hasOwn(ARTICLE_COLLECTIONS, value)
}

/** The public path of a collection's category page: `{prefix}/category/{slug}`. */
export function collectionCategoryPath(collection: ArticleCollection, slug: string): string {
  return `${ARTICLE_COLLECTIONS[collection].pathPrefix}/category/${encodeURIComponent(slug)}`
}

/** The public path of an article in a collection: `{prefix}/{slug}`. */
export function collectionArticlePath(collection: ArticleCollection, slug: string): string {
  return `${ARTICLE_COLLECTIONS[collection].pathPrefix}/${encodeURIComponent(slug)}`
}
