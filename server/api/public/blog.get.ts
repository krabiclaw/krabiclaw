import { getSourceLocale } from '~/server/utils/organization-locales'
// GET /api/public/blog?collection=blog|docs — the requesting tenant's published articles
//
// This was two routes. `/api/public/blog` served KrabiClaw's own articles
// through `listPublicPlatformBlogPosts`, which was `listBlogPosts` with the
// platform site looked up and hardcoded; `/api/public/blog`
// served everyone else's from a near-identical query. The platform is an
// ordinary tenant, so that was one concept with two implementations, and the
// tenant half took its site id from the URL instead of from the host that had
// already identified it.
//
// One route now. The tenant comes from `event.context.organizationId`, which
// tenant-resolution sets from the host, so krabiclaw.com gets KrabiClaw's
// articles and a tenant domain gets that tenant's, by the same code.
import { cloudflareEnv, jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { getArticleCollectionIndex, listArticleCollectionRepresentations, listPublishedArticles } from '~/server/utils/content/publishing'
import { assertExactCanonicalLocale } from '~/server/utils/localization'
import { listPublicArticleCategories } from '~/server/utils/content/article-categories'
import { isArticleCollection } from '~/utils/article-collections'
import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  // Absent means the blog, the same collection `listPublishedArticles`
  // defaults to, because this route answers the blog index and that function
  // renders it server-side; a route that answered every collection put the
  // documentation in the platform's blog feed while its own SSR left it out.
  // Every article carries a collection, so no caller loses rows to the filter.
  const query = getQuery(event)
  const requested = query.collection
  if (requested !== undefined && !isArticleCollection(requested)) {
    return jsonResponse({ error: 'Unknown collection' }, { status: 400 })
  }
  const collection = requested === undefined ? 'blog' : requested
  const locale = assertExactCanonicalLocale(query.locale ?? await getSourceLocale(db, organizationId))

  try {
    const [posts, index, categories, localeRepresentations] = await Promise.all([
      listPublishedArticles(db, env, organizationId, collection, locale),
      getArticleCollectionIndex(db, organizationId, collection, locale),
      listPublicArticleCategories(env, db, organizationId, collection, locale),
      listArticleCollectionRepresentations(env, db, organizationId, collection),
    ])
    return jsonResponse({ posts, index, categories, localeRepresentations })
  } catch (err) {
    rethrowHttpError(err)
    console.error('Failed to fetch public blog posts:', err)
    return jsonResponse({ error: 'Failed to fetch posts' }, { status: 500 })
  }
})
