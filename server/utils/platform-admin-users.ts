import { isAPIError } from 'better-auth/api'
import { HTTPError, type H3Event } from 'nitro'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'
import type { PlatformAdminPermission } from '~/utils/platform-admin-access'

export async function hasPlatformEventPermission(
  event: H3Event,
  env: CloudflareEnv,
  permissions: PlatformAdminPermission,
): Promise<boolean> {
  try {
    const result = await createAuth(env).api.userHasPermission({
      body: { permissions },
      headers: event.req.headers,
    })
    return result.success
  } catch (error) {
    if (!isAPIError(error)) throw error
    if (error.statusCode === 401 || error.statusCode === 403) return false
    throw new HTTPError({ statusCode: error.statusCode, message: error.message, data: error.body, cause: error })
  }
}
