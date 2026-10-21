import { collectionArticlePath, type ArticleCollection } from '~/utils/article-collections'

/**
 * The public path of an article on a site: every site's blog articles live at
 * /blog/<slug>, and documentation, which only KrabiClaw publishes, at /docs.
 */
export function tenantBlogPostPath(slug: string, collection: ArticleCollection = 'blog') {
  if (collection === 'blog') return `/blog/${encodeURIComponent(slug)}`
  return collectionArticlePath(collection, slug)
}
