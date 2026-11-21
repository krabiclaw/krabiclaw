import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readPublicAuthoredPage } from '~/server/utils/public-tenant-pages'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event =>
  jsonResponse(finalizeRequestMetrics(event, 'public-authored-page', await readPublicAuthoredPage(event, getQuery(event)))))
