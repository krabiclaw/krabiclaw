import { resolvePublicTemplate } from '~/utils/template-registry'
import { collectionArticlePath, type ArticleCollection } from '~/utils/article-collections'

/**
 * The public path of an article on a site. A blog article lives at the
 * template's own prefix — /blog or /article — and documentation, which only
 * KrabiClaw publishes, at /docs. Nothing stands between the prefix and the
 * slug on either.
 */
export function tenantBlogPostPath(
  template: Parameters<typeof resolvePublicTemplate>[0],
  slug: string,
  collection: ArticleCollection = 'blog',
) {
  if (collection === 'blog') return `${resolvePublicTemplate(template).serviceRoutes.articleDetailPrefix}/${encodeURIComponent(slug)}`
  return collectionArticlePath(collection, slug)
}
