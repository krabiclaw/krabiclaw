import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'

import { cloudflareEnv } from '~/server/utils/api-response'
import { resolveLocalizedPublicRoute } from '~/server/utils/localization'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const path = getQuery(event).path
  if (!organizationId || typeof path !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Organization ID and localized path are required' })
  }
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) throw createError({ statusCode: 503, statusMessage: 'Database unavailable' })
  return { route: await resolveLocalizedPublicRoute(env, db, organizationId, path) }
})
