import { defineHandler, HTTPError } from 'nitro'
import { useNitroHooks } from 'nitro/app'
import { assertBodySize, readValidatedBody } from 'nitro/h3'
import { z } from 'zod'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'

const correlationId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/)
const nativeError = z.object({
  event_id: z.uuid(),
  app_version: z.string().regex(/^\d{1,5}(?:\.\d{1,5}){0,2}$/),
  app_build: z.string().regex(/^\d{1,8}(?:\.\d{1,8}){0,2}$/),
  operation: z.enum(['today', 'stay_homes', 'bookings_calendar', 'calendar_nights', 'bookings', 'airbnb_status', 'home_photo']),
  error_code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  field: z.string().max(120).regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\[\])*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])*)*$/).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  request_id: correlationId.optional(),
  ray_id: correlationId.optional(),
  error_domain: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/).optional(),
  error_number: z.number().int().optional(),
}).strict()

export default defineHandler(async (event) => {
  if (!event.req.headers.get('authorization')?.startsWith('Bearer ') || event.req.headers.has('cookie')) {
    throw new HTTPError({ statusCode: 401, message: 'Native error reporting requires a bearer session' })
  }
  if (!event.req.headers.get('content-type')?.startsWith('application/json')) {
    throw new HTTPError({ statusCode: 415, message: 'Native error reporting requires JSON' })
  }
  await assertBodySize(event, 2048)
  const report = await readValidatedBody(event, nativeError)
  const session = await getAuthSession(event, cloudflareEnv(event))
  if (!session?.user.id || session.user.isAnonymous) throw new HTTPError({ statusCode: 401, message: 'Native error reporting requires a signed-in user' })

  const { error_code, http_status, request_id, ray_id, ...clientError } = report
  event.context.clientError = clientError
  // The source request is separate from this report's own request ID and Ray ID.
  const error = Object.assign(new Error(error_code), { name: 'Native client error', code: error_code,
    status: http_status, request_id, ray_id, stack: undefined })
  await useNitroHooks().callHook('error', error, { event, tags: ['native', report.operation] })
  return { recorded: true, event_id: report.event_id }
})
