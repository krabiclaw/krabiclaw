import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { registerDevice, requireDeviceSession } from '~/server/domain/devices'

// The app registers its APNs token; a browser registers its push subscription.
export default defineHandler(async (event) => {
  const { db, userId, sessionId } = await requireDeviceSession(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { deviceToken: 'string', environment: 'string', endpoint: 'string', p256dh: 'string', auth: 'string' })
  await registerDevice(db, {
    ...('endpoint' in body
      ? { kind: 'web' as const, endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth }
      : { kind: 'apns' as const, deviceToken: body.deviceToken, environment: body.environment }),
    userId,
    sessionId,
  })
  return jsonResponse({ status: 'registered' }, { headers: { 'cache-control': 'no-store' } })
})
