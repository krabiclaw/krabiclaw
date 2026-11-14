import type { HTTPEvent } from 'nitro/h3'
import { beginTranscriptMetrics, flushRequestMetrics } from '~/server/utils/request-metrics'
import { definePlugin } from 'nitro';

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('request', beginTranscriptMetrics)
  nitroApp.hooks.hook('response', async (response, event: HTTPEvent) => {
    await flushRequestMetrics(event, response)
  })
})
