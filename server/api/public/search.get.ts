import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { searchPublicResources } from '~/server/utils/public-search'
import { PUBLIC_SEARCH_TYPES, type PublicSearchTypeFilter } from '~/server/utils/platform-search-types'

const IP_HOURLY_LIMIT = 120

export default defineHandler(async (event) => {
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q : ''
  const type = typeof query.type === 'string' ? query.type : 'all'
  const surface = typeof query.surface === 'string' ? query.surface : 'public'
  const validTypes = new Set<string>(PUBLIC_SEARCH_TYPES)
  const validSurfaces = new Set(['public', 'docs', 'blog', 'help', 'chowbot', 'tenant_blog'])
  const isTenantRequest = event.context.tenantType === 'tenant' && Boolean(event.context.organizationId)

  if (!q.trim()) {
    return jsonResponse({ error: 'q is required' }, { status: 400 })
  }
  if (!validTypes.has(type)) {
    return jsonResponse({ error: 'type must be one of all, doc, blog, faq, route, platform_page' }, { status: 400 })
  }
  if (!validSurfaces.has(surface)) {
    return jsonResponse({ error: 'surface must be one of public, docs, blog, help, chowbot, tenant_blog' }, { status: 400 })
  }
  if (surface === 'tenant_blog' && !isTenantRequest) {
    return jsonResponse({ error: 'tenant_blog surface requires a tenant site' }, { status: 400 })
  }

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  try {
    if (!import.meta.dev) {
      const clientIp = getClientIp(event)
      const hourWindow = Math.floor(Date.now() / 3_600_000)
      const rateLimitOk = await incrementHourlyRateLimit(
        db, `rate:public-search:ip:${await hashClientIp(clientIp)}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000, )
      if (!rateLimitOk) {
        return jsonResponse({ error: 'Too many requests. Please try again later.' }, { status: 429 })
      }
    }

    const results = await searchPublicResources(db, q, {
      type: type as PublicSearchTypeFilter, surface: surface as 'public' | 'docs' | 'blog' | 'help' | 'chowbot' | 'tenant_blog', limit: 10,
      organizationId: isTenantRequest && surface === 'tenant_blog' ? String(event.context.organizationId) : null, })
    return jsonResponse({ query: q, surface, results })
  } catch (error) {
    console.error('Failed to run public search:', error)
    return jsonResponse({ error: 'Failed to search public resources' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getQuery } from 'nitro/h3';
