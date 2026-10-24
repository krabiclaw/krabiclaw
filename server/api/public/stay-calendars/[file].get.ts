import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { stayCalendarExport } from '~/server/domain/stays'

/** A home's taken nights as iCal, for the linked site (Vrbo) to read. The address's token is the only credential. */
export default defineHandler(async (event) => {
  const file = getRouterParam(event, 'file') ?? ''
  if (!file.endsWith('.ics')) throw new HTTPError({ statusCode: 404, message: 'This calendar address does not exist', data: { code: 'STAY_CALENDAR_NOT_FOUND', field: 'token' } })
  const body = await stayCalendarExport(cloudflareEnv(event).DB, file.slice(0, -'.ics'.length))
  return new Response(body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' } })
})
