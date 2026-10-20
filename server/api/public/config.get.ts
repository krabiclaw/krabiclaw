// GET public site config: scalars every theme reads plus the universal announcement.
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getPublicConfig } from '~/server/utils/organization-config'
import { defineHandler } from 'nitro'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  return jsonResponse(await getPublicConfig(db, organizationId, { previewAuthorized: event.context.previewAuthorized === true }))
})
