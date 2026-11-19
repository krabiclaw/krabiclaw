/**
 * A navigation into an organization's dashboard completes once that
 * organization's context has answered. Until then the router has not moved:
 * the screen being left stays up, and no page, nav or Menu of the new scope
 * renders with the previous organization's context or none. A failed request
 * still completes the navigation; the layout shows its error.
 */
export default defineNuxtRouteMiddleware(async (to, from) => {
  if (to.name === 'dashboard-org_slug-payments' && to.query.stripe_connect === 'returned') {
    return navigateTo({
      name: 'dashboard-org_slug-payments-payout-method',
      params: to.params,
      query: to.query,
      hash: to.hash,
    }, { replace: true })
  }
  if (to.path.startsWith('/dashboard/')) {
    const preferenceMatch = to.path.match(/^\/dashboard\/([^/]+)\/website\/(status|domains|localization|currency)(\/.*)?$/)
    if (preferenceMatch) {
      return navigateTo({ path: `/dashboard/${preferenceMatch[1]}/website/preferences/${preferenceMatch[2]}${preferenceMatch[3] ?? ''}`, query: to.query, hash: to.hash })
    }
  }
  if (!to.path.startsWith('/dashboard/')) return
  const scope = useDashboardRouteScope(to).value
  if (!scope) return

  const isReservation = typeof to.params.record_id === 'string' && !to.params.booking_type
    && /^dashboard-org_slug-(?:bookings|messages-conversation_id-reservation)(?:-|$)/.test(String(to.name))
  if (import.meta.server) {
    if (/^\/dashboard\/[^/]+\/products\/?$/.test(to.path)) {
      const provider = useRequestEvent()?.context.dashboardDocumentProvider as { catalog: (orgSlug: string) => Promise<unknown> } | undefined
      const catalog = provider?.catalog(scope.orgSlug)
      // The page reads the same promise and owns how a catalog failure is shown.
      await Promise.allSettled([useDashboardContext(scope), catalog])
    } else if (isReservation) {
      await Promise.all([useDashboardContext(scope), useDashboardReservation(scope, String(to.params.record_id))])
    }
    return
  }

  const context = useDashboardContext(scope)
  // Entering an organization fetches its context afresh rather than showing
  // what an earlier visit loaded; moving within it keeps what is held.
  const entering = useDashboardRouteScope(from).value?.orgSlug !== scope.orgSlug
  if (entering && !useNuxtApp().isHydrating && context.status.value !== 'pending') await context.refresh()
  else await context
})
