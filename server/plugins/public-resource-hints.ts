import type { HTTPEvent } from 'nitro/h3';
import { publicSurfaceStylesheetForRequest } from '~/utils/public-surface-hints'
import { definePlugin } from 'nitro';

const PRIVATE_ROUTE_PREFIXES = [
  '/dashboard',
  '/account',
  '/admin',
  '/api/',
  '/auth/',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/oauth/',
]

const isPrivateRoute = (path: string) =>
  PRIVATE_ROUTE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))

function addStylesheetPreload(response: Response, event: HTTPEvent) {
  const request = event.req
  const path = new URL(request.url).pathname
  if (import.meta.dev) return
  if (request.method !== 'GET' || isPrivateRoute(path)) return
  if (!request.headers.get('accept')?.includes('text/html')) return

  const context = (request.context ?? {}) as Record<string, unknown>
  const organization = context.organization as { vertical?: string | null } | undefined
  const href = publicSurfaceStylesheetForRequest({
    pathname: path,
    tenantType: context.tenantType as string | undefined,
    themeId: context.themeId as string | undefined,
    vertical: organization?.vertical,
  })
  if (!href) return

  const cors = context.tenantType === 'tenant' ? '; crossorigin=anonymous' : ''
  response.headers.set('link', [response.headers.get('link'), `<${href}>; rel=preload; as=style${cors}`].filter(Boolean).join(', '))
}

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('response', (response, event: HTTPEvent) => {
    addStylesheetPreload(response, event)
  })
})
