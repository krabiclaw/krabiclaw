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
    const context = useDashboardContext(scope)
    const provider = useRequestEvent()?.context.dashboardDocumentProvider as {
      read: (orgSlug: string, resource: string, query: Record<string, unknown>) => Promise<unknown>
      catalog: (orgSlug: string) => Promise<unknown>
      today: (orgSlug: string) => Promise<unknown>
    } | undefined
    if (/^\/dashboard\/[^/]+\/products\/?$/.test(to.path)) {
      await Promise.allSettled([context, provider?.catalog(scope.orgSlug)])
    } else if (to.name === 'dashboard-org_slug') {
      await Promise.allSettled([context, provider?.today(scope.orgSlug)])
    } else if (/^\/dashboard\/[^/]+\/earnings(?:\/performance)?\/?$/.test(to.path)) {
      const current = new Date().toISOString().slice(0, 7)
      const selected = typeof to.query.month === 'string' && /^\d{4}-\d{2}$/.test(to.query.month) ? to.query.month : current
      const months = new Set(to.path.endsWith('/performance') ? [current, selected] : [current])
      await Promise.allSettled([context, ...Array.from(months, month =>
        provider?.read(scope.orgSlug, '/api/dashboard/payments', { view: 'performance', year: Number(month.slice(0, 4)), month }))])
    } else if (/^\/dashboard\/[^/]+\/integrations(?:\/google-calendar)?\/?$/.test(to.path)) {
      const calendar = /\/google-calendar\/?$/.test(to.path)
        ? provider?.read(scope.orgSlug, '/api/dashboard/integrations/google-calendar', {})
        : undefined
      await Promise.allSettled([context, calendar, provider?.read(scope.orgSlug, '/api/dashboard/settings', { connections: '1' })])
    } else if (isReservation) {
      await Promise.all([context, useDashboardReservation(scope, String(to.params.record_id))])
    } else {
      await context
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
