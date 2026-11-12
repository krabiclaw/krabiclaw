// Read-only diagnostic: reports a breakdown of the platform knowledge corpus by record
// type before any surface-expansion or upload happens, plus the raw static config array
// lengths for comparison. Secret-gated like the other server/api/internal/search/* routes —
// even though the counts alone are low-sensitivity, this still triggers a real D1 query
// (buildPlatformKnowledgeDocuments) on every request and shouldn't be a public,
// unauthenticated way to do that.
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { SEARCH_INTERNAL_CALLER, validateInternalRequest } from '~/server/utils/internal-secret'
import { buildPlatformKnowledgeDocuments } from '~/server/utils/public-search'
import {
  PLATFORM_KNOWLEDGE_FAQ_ENTRIES, PLATFORM_KNOWLEDGE_ROUTE_ENTRIES, PLATFORM_KNOWLEDGE_PAGE_ENTRIES, } from '~/config/platform-knowledge'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const validation = await validateInternalRequest(event, env, SEARCH_INTERNAL_CALLER)
  if (!validation.ok) return jsonResponse({ error: validation.error }, { status: validation.status })

  const static_counts = {
    faq_entries: PLATFORM_KNOWLEDGE_FAQ_ENTRIES.length, route_entries: PLATFORM_KNOWLEDGE_ROUTE_ENTRIES.length, page_entries: PLATFORM_KNOWLEDGE_PAGE_ENTRIES.length, }

  try {
    const baseRecords = await buildPlatformKnowledgeDocuments(env.db)
    const by_type: Record<string, number> = {}
    for (const record of baseRecords) {
      by_type[record.type] = (by_type[record.type] ?? 0) + 1
    }
    return jsonResponse({ ok: true, total_base_records: baseRecords.length, by_type, static_counts })
  } catch (error) {
    console.error('Failed to build corpus stats:', error)
    return jsonResponse({ error: 'Failed to build corpus' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
