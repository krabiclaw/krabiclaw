// GET /api/user/notification-preferences — every category for the signed-in
// account, stored rows overlaying NOTIFICATION_CATEGORY_DEFAULTS, and each
// category's name in the words of that account's businesses, and the latest
// alert email to this account that bounced, which the inbox no longer shows
// inside a conversation.

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { getNotificationCategoryLabels, getNotificationPreferences } from '~/server/domain/notification-preferences'
import { queryFirst } from '~/server/db'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const [preferences, labels, bounced] = await Promise.all([
    getNotificationPreferences(db, session.user.id),
    getNotificationCategoryLabels(db, session.user.id),
    queryFirst<{ error: string | null; updated_at: string }>(db, `SELECT error, updated_at FROM guest_thread_deliveries
      WHERE purpose = 'owner_alert' AND channel = 'email' AND status = 'failed' AND json_extract(email_json, '$.message.to') = ?
        AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
      ORDER BY updated_at DESC LIMIT 1`, [session.user.email]),
  ])
  return jsonResponse({ preferences, labels, bouncedEmail: bounced ? { address: session.user.email, error: bounced.error, failedAt: bounced.updated_at } : null })
})
import { defineHandler } from 'nitro';
