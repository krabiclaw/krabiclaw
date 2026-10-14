/**
 * A navigation into an organization's dashboard completes once that
 * organization's context has answered. Until then the router has not moved:
 * the screen being left stays up, and no page, nav or Menu of the new scope
 * renders with the previous organization's context or none. A failed request
 * still completes the navigation; the layout shows its error.
 */
export default defineNuxtRouteMiddleware(async (to, from) => {
  if (import.meta.server || !to.path.startsWith('/dashboard/')) return
  const scope = useDashboardRouteScope(to).value
  if (!scope) return

  const context = useDashboardContext(scope)
  // Entering an organization fetches its context afresh rather than showing
  // what an earlier visit loaded; moving within it keeps what is held.
  const entering = useDashboardRouteScope(from).value?.orgSlug !== scope.orgSlug
  if (entering && context.status.value === 'success') await context.refresh()
  else await context
})
