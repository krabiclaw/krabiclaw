import { isDashboardPath } from '~/utils/dashboard-path'

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.client && isDashboardPath(to.path) && !to.matched.some(record => isDashboardPath(record.path))) {
    return navigateTo(to.fullPath, { external: true })
  }
})
