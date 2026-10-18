import { resolvePublicTemplate } from '~/utils/template-registry'

/*
  Platform routes on the `access` and `standalone` layouts render Nuxt UI, so
  they load the app stylesheet instead of the lean marketing one. Only the
  publicly reachable ones are listed: the rest sit behind prefixes that
  server/plugins/public-resource-hints.ts already treats as private and never
  hints. Preloading the wrong sheet costs a download and warms nothing.
*/
const PLATFORM_APP_ROUTE_PREFIXES = ['/help', '/unsubscribe', '/accept-invitation', '/invite']

const isPlatformAppRoute = (path: string) =>
  PLATFORM_APP_ROUTE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))

export function publicSurfaceStylesheetForRequest(input: {
  pathname: string
  tenantType?: string | null
  themeId?: string | null
  vertical?: string | null
}): string | null {
  if (input.tenantType === 'platform') {
    return isPlatformAppRoute(input.pathname)
      ? '/_nuxt/surfaces/platform-app.css'
      : '/_nuxt/surfaces/platform.css'
  }
  if (input.tenantType !== 'tenant') return null

  const template = resolvePublicTemplate({
    themeId: input.themeId,
    vertical: input.vertical,
  })
  if (template.slug === 'blawby' || template.slug === 'saya') {
    return '/_nuxt/surfaces/tenant.css'
  }
  throw new Error(`Unsupported public template "${template.slug}".`)
}
