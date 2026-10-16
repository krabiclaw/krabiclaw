// PATCH /api/user/notification-preferences — set one category for the
// signed-in account.
//
// One category per request, because the settings leaf edits one category. The
// body is rejected rather than coerced: every channel is stated explicitly, and
// account_security email is not a switchable value — a request that tries to
// turn it off is a bug in the caller, not a preference to honour.

import { defineHandler, HTTPError } from 'nitro'
import { cloudflareEnv, jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { getNotificationPreferences, setNotificationPreference } from '~/server/domain/notification-preferences'
import { isMandatoryEmailCategory, isNotificationCategory } from '~/shared/notification-categories'

const CHANNELS = ['email', 'whatsapp', 'push'] as const

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, message: 'Database is not available', data: { code: 'DATABASE_UNAVAILABLE', field: 'DB' } })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })

  const body = await readStrictBody<Record<string, unknown>>(event, { category: 'string', email: 'boolean', whatsapp: 'boolean', push: 'boolean' })
  if (!isNotificationCategory(body.category)) {
    throw new HTTPError({ statusCode: 422, message: 'A known notification category is required', data: { code: 'INVALID_NOTIFICATION_CATEGORY', field: 'category' } })
  }
  for (const channel of CHANNELS) {
    if (typeof body[channel] !== 'boolean') {
      throw new HTTPError({ statusCode: 422, message: `${channel} must be a boolean`, data: { code: 'NOTIFICATION_CHANNEL_REQUIRED', field: channel } })
    }
  }
  const setting = { email: body.email as boolean, whatsapp: body.whatsapp as boolean, push: body.push as boolean }
  if (isMandatoryEmailCategory(body.category) && !setting.email) {
    throw new HTTPError({ statusCode: 422, message: `${body.category} email cannot be switched off`, data: { code: 'MANDATORY_EMAIL_CATEGORY', field: 'email' } })
  }

  await setNotificationPreference(db, env, session.user.id, body.category, setting)
  return jsonResponse({ preferences: await getNotificationPreferences(db, session.user.id) })
})
