import { HTTPError, type H3Event } from 'nitro'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'
import { isPlatformTemplate } from '~/utils/template-registry'

/**
 * Platform reports, like Platform accounts, exist only inside KrabiClaw's own
 * organization and only for a Better Auth admin who may ban users; anywhere
 * else they are not a route.
 */
export async function requirePlatformReportsAccess(event: H3Event) {
  const context = await getDashboardContext(event)
  if (!isPlatformTemplate({ themeId: context.organization.theme_id })
    || !await hasPlatformEventPermission(event, context.env, { platform: ['support'], user: ['ban'] })) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Not found', data: { code: 'NOT_FOUND', field: 'route' } })
  }
  return context
}
