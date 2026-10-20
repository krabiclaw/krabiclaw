// Read-only diagnostic: reports how many items currently exist in the platform AI
// Search instance and how long listing them takes, without doing any uploads/deletes.
// Added to test whether listAllItems() (which runs before any upload in
// rebuildPlatformKnowledgeIndex) is itself a bottleneck — several prior production
// reindex runs died from a raw connection failure before ever reaching the
// delete-stale-items step, so orphaned items from earlier key formats may have
// accumulated without ever being cleaned up.
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { SEARCH_INTERNAL_CALLER, validateInternalRequest } from '~/server/utils/internal-secret'
import { listAllItems } from '~/server/utils/public-search'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)

  const validation = await validateInternalRequest(event, env, SEARCH_INTERNAL_CALLER)
  if (!validation.ok) return jsonResponse({ error: validation.error }, { status: validation.status })

  const startedAt = Date.now()
  try {
    const items = await listAllItems(env)
    return jsonResponse({
      ok: true, itemCount: items.length, elapsedMs: Date.now() - startedAt, })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return jsonResponse({ error: 'Failed to list AI Search items', detail, elapsedMs: Date.now() - startedAt }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
