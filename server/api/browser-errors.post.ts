import { HTTPError, defineHandler } from 'nitro'
import { useNitroHooks } from 'nitro/app'
import { assertBodySize, readValidatedBody } from 'nitro/h3'
import { z } from 'zod'
import { BROWSER_ERROR_LIMITS, BROWSER_ERROR_SOURCES, ERROR_TELEMETRY_LIMITS, redactErrorText } from '~/shared/error-telemetry'

const errorEntry = z.object({
  name: z.string().max(ERROR_TELEMETRY_LIMITS.name),
  message: z.string().max(ERROR_TELEMETRY_LIMITS.message),
  code: z.string().max(ERROR_TELEMETRY_LIMITS.code).optional(),
  status: z.number().int().min(100).max(599).optional(),
  stack: z.string().max(ERROR_TELEMETRY_LIMITS.stack).optional(),
  request_id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/).optional(),
  ray_id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/).optional(),
}).strict()
const browserError = z.object({
  event_id: z.uuid(),
  source: z.enum(BROWSER_ERROR_SOURCES),
  page_path: z.string().max(BROWSER_ERROR_LIMITS.pagePath).regex(/^\/(?!\/)[^?#]*$/).refine(path => [...path].every(character => character.charCodeAt(0) >= 32)),
  context: z.string().max(BROWSER_ERROR_LIMITS.context).optional(),
  error_chain: z.array(errorEntry).min(1).max(ERROR_TELEMETRY_LIMITS.depth),
}).strict()

export default defineHandler(async (event) => {
  if (event.req.headers.get('origin') !== event.url.origin) {
    throw new HTTPError({ statusCode: 403, statusMessage: 'Browser error reporting requires a same-origin request' })
  }
  if (!event.req.headers.get('content-type')?.startsWith('application/json')) {
    throw new HTTPError({ statusCode: 415, statusMessage: 'Browser error reporting requires JSON' })
  }
  await assertBodySize(event, BROWSER_ERROR_LIMITS.bodyBytes)
  const report = await readValidatedBody(event, browserError)
  let error: Error | undefined
  for (const entry of report.error_chain.toReversed()) {
    error = Object.assign(new Error(entry.message, error ? { cause: error } : undefined), entry, { stack: entry.stack })
  }
  event.context.browserError = {
    event_id: report.event_id,
    source: report.source,
    page_path: redactErrorText(report.page_path, BROWSER_ERROR_LIMITS.pagePath),
    ...(report.context ? { context: redactErrorText(report.context, BROWSER_ERROR_LIMITS.context) } : {}),
  }
  // Await Nitro's canonical hook so an accepted report has reached operational logs.
  await useNitroHooks().callHook('error', error!, { event, tags: ['browser', report.source] })
  return { recorded: true, event_id: report.event_id }
})
