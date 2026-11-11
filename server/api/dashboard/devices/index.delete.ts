import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireDeviceSession, unregisterDevice } from '~/server/domain/devices'

export default defineHandler(async (event) => {
  const { db, userId, sessionId } = await requireDeviceSession(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { token: 'string', endpoint: 'string' })
  await unregisterDevice(db, 'endpoint' in body ? { kind: 'web', endpoint: body.endpoint } : { kind: 'apns', token: body.token }, { userId, sessionId })
  return jsonResponse({ status: 'unregistered' }, { headers: { 'cache-control': 'no-store' } })
})
