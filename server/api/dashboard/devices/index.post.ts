import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { registerDevice, requireDeviceSession } from '~/server/domain/devices'

export default defineHandler(async (event) => {
  const { db, userId, sessionId } = await requireDeviceSession(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { deviceToken: 'string', environment: 'string' })
  await registerDevice(db, { token: body.deviceToken, environment: body.environment, userId, sessionId })
  return jsonResponse({ status: 'registered' }, { headers: { 'cache-control': 'no-store' } })
})
