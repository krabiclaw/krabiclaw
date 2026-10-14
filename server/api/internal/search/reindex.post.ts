import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { rebuildPlatformKnowledgeIndex, syncOrganizationSearchIndex } from '~/server/utils/public-search'
import { SEARCH_INTERNAL_CALLER, validateInternalRequest } from '~/server/utils/internal-secret'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.db) {
    return jsonResponse({ error: 'Database not available' }, { status: 500 })
  }

  const validation = await validateInternalRequest(event, env, SEARCH_INTERNAL_CALLER)
  if (!validation.ok) return jsonResponse({ error: validation.error }, { status: validation.status })

  // One request per pass keeps each under the Workers request ceiling: the
  // platform pass returns the live site ids, and the caller syncs each site.
  const organization = getQuery(event).organization
  try {
    const result = typeof organization === 'string' && organization
      ? await syncOrganizationSearchIndex(env, env.db, organization)
      : await rebuildPlatformKnowledgeIndex(env, env.db)
    return jsonResponse({ ok: true, ...result })
  } catch (error) {
    console.error('Failed to rebuild platform knowledge index:', error)
    // This route is internal and already secret-gated (same trust boundary as the
    // CI caller), so surfacing the real error message — not a full stack trace —
    // is a reasonable, minimal diagnostic aid rather than a public information leak.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return jsonResponse({ error: 'Failed to rebuild platform knowledge index', detail }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getQuery } from 'nitro/h3';
