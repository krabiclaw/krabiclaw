import type { RouterConfig } from '@nuxt/schema'
import { isDashboardPath } from '~/utils/dashboard-path'

export default {
  async routes(publicRoutes) {
    const pathname = import.meta.server ? useRequestURL().pathname : window.location.pathname
    if (!isDashboardPath(pathname)) return publicRoutes
    const { default: dashboardRoutes } = await import('#build/dashboard-routes.mjs')
    return [...publicRoutes, ...dashboardRoutes]
  },
} satisfies RouterConfig
