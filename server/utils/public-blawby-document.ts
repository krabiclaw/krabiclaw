import { getSourceLocale } from '~/server/utils/organization-locales'
import { HTTPError, type H3Event } from 'nitro'
import { setHeader } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { resolvePublicBlawbyDocumentOrThrow } from '~/server/utils/professional-services'
import {
  buildPublicBlawbyDocumentCacheKey,
  getPublicResourceCache,
  putPublicResourceCache,
} from '~/server/utils/public-resource-cache'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import { isNonProductionHost } from '~/server/utils/tenant-hosts'
import { assertExactCanonicalLocale } from '~/server/utils/localization'
import { BLAWBY_ROUTE_RECIPES, type BlawbyRouteRecipe } from '~/types/blawby'
import {
  isBlawbyDocumentPayload,
  type BlawbyDocumentPayload,
} from '~/utils/blawby-document-contract'

const RECIPES = new Set<BlawbyRouteRecipe>(BLAWBY_ROUTE_RECIPES)
const SLUG_PATTERN = /^[a-z0-9_-]+$/
const PAGE_PATH_PATTERN = /^\/[a-z0-9/_-]*$/

export interface PublicBlawbyDocumentLoadOptions {
  previewAuthorized?: boolean
  slug?: string | null
  locale?: string
  mutateResponseHeaders?: boolean
  signal?: AbortSignal
}

export async function loadPublicBlawbyDocument(
  event: H3Event,
  organizationId: string,
  recipe: BlawbyRouteRecipe,
  options: PublicBlawbyDocumentLoadOptions = {},
): Promise<BlawbyDocumentPayload> {
  options.signal?.throwIfAborted()
  const slug = options.slug?.trim() || null
  if (!RECIPES.has(recipe)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Valid Blawby route recipe required' })
  }
  if (recipe === 'page' && !slug) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Blawby route slug required' })
  }
  // A generic page is addressed by its path; every other recipe by a slug.
  if (slug && !(recipe === 'page' ? PAGE_PATH_PATTERN : SLUG_PATTERN).test(slug)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid Blawby route slug' })
  }

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })
  const locale = assertExactCanonicalLocale(options.locale ?? await getSourceLocale(db, organizationId))

  const host = event.req.headers.get('host') ?? ''
  const cache = env.ORGANIZATION_CACHE
  const useCache = !options.previewAuthorized && !isNonProductionHost(host) && Boolean(cache)
  const cacheKey = buildPublicBlawbyDocumentCacheKey(organizationId, recipe, slug, locale)
  const mutateResponseHeaders = options.mutateResponseHeaders ?? true

  if (useCache && cache) {
    const cacheStartedAt = performance.now()
    const cached = await getPublicResourceCache(cache, cacheKey)
    recordRequestPhase(event, 'cache', cacheStartedAt)
    options.signal?.throwIfAborted()
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as unknown
        if (!isBlawbyDocumentPayload(parsed, recipe)) throw new Error('Blawby document cache contract mismatch')
        if (mutateResponseHeaders) setHeader(event, 'x-bootstrap-cache', 'HIT')
        return parsed
      } catch (error) {
        await cache.delete(cacheKey)
        throw error
      }
    }
    if (mutateResponseHeaders) setHeader(event, 'x-bootstrap-cache', 'MISS')
  } else if (mutateResponseHeaders) {
    setHeader(event, 'x-bootstrap-cache', cache ? 'SKIP' : 'NO-KV')
  }

  const loadStartedAt = performance.now()
  const payload = await resolvePublicBlawbyDocumentOrThrow(db, organizationId, recipe, { slug, locale, previewAuthorized: options.previewAuthorized }, env)
  recordRequestPhase(event, 'document', loadStartedAt)
  options.signal?.throwIfAborted()

  if (useCache && cache) {
    await putPublicResourceCache(cache, cacheKey, JSON.stringify(payload))
  }
  return payload
}
