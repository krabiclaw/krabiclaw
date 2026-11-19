import { defineHandler } from 'nitro'
import { setResponseHeaders } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { buildAiCatalog } from '~/server/utils/mcp-discovery'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  setResponseHeaders(event, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=3600',
  })
  return buildAiCatalog(env)
})
