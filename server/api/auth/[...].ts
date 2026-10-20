import { defineHandler } from 'nitro'
import { createAuth } from '~/server/utils/auth'
import { cloudflareEnv } from '~/server/utils/api-response'

export default defineHandler(event => createAuth(cloudflareEnv(event)).handler(event.req as unknown as Request))
