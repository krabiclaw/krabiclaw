import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3';
import { jsonResponse } from '~/server/utils/api-response'
import { publishNotificationInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { acknowledgeNotification } from '~/server/utils/notification-acknowledgement'
import { getNotificationAccess } from '~/server/utils/notification-access'

export default defineHandler(async (event) => {
  const notificationId = getRouterParam(event, 'notificationId')?.trim()
  if (!notificationId) return jsonResponse({ error: 'Notification id is required' }, { status: 400 })

  const access = await getNotificationAccess(event)
  const read = await acknowledgeNotification(access.db, access, notificationId)
  if (!read) return jsonResponse({ error: 'Notification not found' }, { status: 404 })
  if (read.newlyRead && access.organization) {
    await publishNotificationInvalidation(access.env, {
      type: 'notification.read',
      organizationId: access.organization.id,
      locationId: null,
      targetUserId: access.userId,
    })
  }
  return jsonResponse({ success: true })
})
