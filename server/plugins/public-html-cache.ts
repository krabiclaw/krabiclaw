import type { HTTPEvent } from 'nitro/h3'
import { definePlugin } from 'nitro'
import { isNonIndexableHost, isPrivateSeoPath } from '~/server/utils/seo-policy'
import { hostnameOf, isNonProductionHost } from '~/server/utils/tenant-hosts'
import { PREVIEW_COOKIE_NAME, PREVIEW_TOKEN_QUERY } from '~/server/utils/preview-token'
import { isDemoHost, isDemoOrganization } from '~/shared/demo'

const PRODUCTION_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300, max-age=0'
const NON_PRODUCTION_CACHE_CONTROL = 'private, no-store, max-age=0'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('response', (response, event: HTTPEvent) => {
    if (response.status === 101) return
    const request = event.req
    const url = new URL(request.url)
    const pathname = url.pathname
    // A preview is one owner looking at their own site: never public-cached,
    // never indexed. It is signalled by the token in the URL on the first
    // request and by the preview cookie on every request after it.
    const cookies = request.headers.get('cookie') ?? ''
    const isPreviewRequest = url.searchParams.has(PREVIEW_TOKEN_QUERY) || cookies.includes(`${PREVIEW_COOKIE_NAME}=`)
    const privatePath = isPrivateSeoPath(pathname) || isPreviewRequest
    const requestHost = hostnameOf(request.headers.get('host') || '')
    const organization = (event as { context?: { organization?: { subdomain?: string } } }).context?.organization
    const isDemo = isDemoHost(url.hostname) || isDemoHost(requestHost) || isDemoOrganization(organization)
    if (isNonIndexableHost(url.hostname) || isNonIndexableHost(requestHost) || isDemo || privatePath) {
      response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive')
    }
    if (privatePath) response.headers.set('cache-control', NON_PRODUCTION_CACHE_CONTROL)
    if (isPreviewRequest) response.headers.set('referrer-policy', 'no-referrer')

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) return
    if (privatePath) return

    const hostname = requestHost
    const nonProduction = isNonProductionHost(hostname) || isNonIndexableHost(hostname) || isDemo
    const hasSession = cookies.includes('better-auth.session_token')

    response.headers.set('cache-control', nonProduction || hasSession ? NON_PRODUCTION_CACHE_CONTROL : PRODUCTION_CACHE_CONTROL)
    if (nonProduction) {
      response.headers.set('pragma', 'no-cache')
      response.headers.set('expires', '0')
    }
  })
})
