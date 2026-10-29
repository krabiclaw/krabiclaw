// GET /api/user/notification-preferences — every category for the signed-in
// account, stored rows overlaying NOTIFICATION_CATEGORY_DEFAULTS, and each
// category's name in the words of that account's businesses.

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { getNotificationCategoryLabels, getNotificationPreferences } from '~/server/domain/notification-preferences'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const [preferences, labels] = await Promise.all([getNotificationPreferences(db, session.user.id), getNotificationCategoryLabels(db, session.user.id)])
  return jsonResponse({ preferences, labels })
})
import { defineHandler } from 'nitro';
