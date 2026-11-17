import type { EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import type { DashboardScopeHeaderModel } from '~/lib/components/workspace/dashboard/DashboardScopeHeader.vue'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { canOpenPlatformAccounts, canOpenPlatformReports } from '~/utils/platform-admin-access'
import { onboardingLink } from '~/composables/useOnboardingFlow'
import type { WebsiteOnboardingResumeAction } from '~/shared/onboarding-flow'

// The rows on Menu. Menu is a launcher: every row is a destination of its own
// — Website, Posts, Locations, Team, Plan and billing — or an action, with no headings. The Menu
// page and the desktop slideover render this one list, so a row exists in one
// place. A destination is not nested under Menu; it names Menu as its tab.
//
// The organization is the shell's (useDashboardMenu): the route's, otherwise
// Better Auth's active one, so Account settings opened from inside an
// organization keeps that organization's Menu.
export function useOrganizationSettingsNavigation(
  organization: Ref<{ id: string; slug: string } | null>,
  scopeModel: Readonly<Ref<DashboardScopeHeaderModel | null>>,
  resumeAction?: Readonly<Ref<WebsiteOnboardingResumeAction | null | undefined>>,
) {
  const route = useRoute()
  const router = useRouter()
  const dashboard = useDashboardOrganization()
  const session = authClient.useSession()

  const base = computed(() => organization.value ? `/dashboard/${encodeURIComponent(organization.value.slug)}` : null)

  // Menu and Search share these exact organization checks, made locally from the
  // member's role. The loaded workspace context carries the role; Account
  // settings opened outside a workspace route asks Better Auth for it once.
  // The context's role is part of the key, so a role change (a self-demotion
  // on Team refreshes it) checks again.
  const contextRole = computed(() => dashboard.organization.value?.id === organization.value?.id ? dashboard.organization.value?.role ?? '' : '')
  const permissionLoad = useAsyncData(
    () => `menu-organization:${session.value.data?.user.id ?? ''}:${organization.value?.id ?? ''}:${contextRole.value}`,
    async (_app, { signal }) => {
      const target = organization.value
      const userId = session.value.data?.user.id
      if (!target || !userId) return null
      let role = contextRole.value
      if (!role) {
        const result = await authClient.organization.getActiveMemberRole({ query: { organizationId: target.id }, fetchOptions: { signal } })
        if (result.error) throw new Error(result.error.message || 'Your role could not be read.')
        role = result.data.role
      }
      const can = (permissions: Parameters<typeof authClient.organization.checkRolePermission>[0]['permissions']) =>
        authClient.organization.checkRolePermission({ role: role as keyof typeof organizationRoles, permissions })
      return { organizationId: target.id, userId, payments: can({ payments: ['read'] }), billing: can({ billing: ['read'] }), team: can({ members: ['read'] }) }
    },
    { enabled: () => Boolean(organization.value && session.value.data?.user.id), dedupe: 'defer' },
  )
  const permissions = computed(() => {
    const loaded = permissionLoad.data.value
    return loaded && loaded.organizationId === organization.value?.id && loaded.userId === session.value.data?.user.id ? loaded : null
  })

  /**
   * Every account on the platform, and impersonation: Blawby runs on
   * Blawby, so only its own organization's Menu carries this row, and only
   * for a Better Auth admin. The template is read off the route's loaded
   * organization context, the same reading the page itself gates on. Airbnb
   * has no equivalent; internal admin tooling is not in the host's dashboard.
   */
  const showPlatformAccounts = computed(() => {
    const loaded = dashboard.organization.value
    return Boolean(loaded && canOpenPlatformAccounts(loaded, (session.value.data?.user as { role?: string | null } | undefined)?.role))
  })
  const showPlatformReports = computed(() => {
    const loaded = dashboard.organization.value
    return Boolean(loaded && canOpenPlatformReports(loaded, (session.value.data?.user as { role?: string | null } | undefined)?.role))
  })

  // Airbnb's "Switch to hosting": one organization switches straight to it;
  // several open the list under Account settings; none offers to start one.
  const switchRow = computed(() => {
    const organizations = (scopeModel.value?.peers ?? []).filter(peer => peer.id)
    if (organizations.length === 1) return organizations[0]!.to ? { id: 'switch-organization', icon: 'i-lucide-repeat-2', label: `Switch to ${organizations[0]!.label}`, to: organizations[0]!.to } : { id: 'switch-organization', icon: 'i-lucide-repeat-2', label: `Switch to ${organizations[0]!.label}`, action: {} }
    if (organizations.length > 1) return { id: 'switch-organization', icon: 'i-lucide-repeat-2', label: 'Switch to an organization', to: '/dashboard/account/profile/organizations' }
    const action = resumeAction?.value ?? scopeModel.value?.createAction
    return action ? { id: 'switch-organization', icon: resumeAction?.value ? 'i-lucide-arrow-right' : 'i-lucide-plus', label: action.label, to: onboardingLink(action.to, route.fullPath) } : null
  })

  const items = computed(() => {
    if (!base.value) return [
      { id: 'account', icon: 'i-lucide-user-round-cog', label: 'Account settings', to: '/dashboard/account/profile' },
      ...(switchRow.value ? [switchRow.value] : []),
      { id: 'log-out', icon: 'i-lucide-log-out', label: 'Log out', action: {} },
    ]
    return [
      { id: 'website', icon: 'i-lucide-panels-top-left', label: 'Website', to: `${base.value}/website` },
      { id: 'locations', icon: 'i-lucide-map-pin', label: dashboard.organization.value?.vertical === 'service' ? 'Offices' : 'Locations', to: `${base.value}/locations` },
      ...(permissions.value?.team ? [{ id: 'team', icon: 'i-lucide-users', label: 'Team', to: `${base.value}/team` }] : []),
      { id: 'integrations', icon: 'i-lucide-plug', label: 'Connections', to: `${base.value}/integrations` },
      // What the organization pays Blawby. Owners change it and admins read it; members have no row.
      ...(permissions.value?.billing ? [{ id: 'billing', icon: 'i-lucide-receipt', label: 'Plan and billing', to: `${base.value}/billing` }] : []),
      // "Team" is this organization's members; this is every account there is.
      ...(showPlatformAccounts.value
        ? [{ id: 'platform-accounts', icon: 'i-lucide-shield-user', label: 'Platform accounts', to: `${base.value}/platform-accounts` }]
        : []),
      // Members' reports of guests and teammates, decided by Blawby staff within 24 hours.
      ...(showPlatformReports.value
        ? [{ id: 'platform-reports', icon: 'i-lucide-flag', label: 'Platform reports', to: `${base.value}/platform-reports` }]
        : []),
      // The way to the account on a phone, where there is no header to carry an
      // avatar. Airbnb's mobile Menu lists "Account settings" in the same place,
      // second from last, above Log out (measured 2026-09-22).
      { id: 'account', icon: 'i-lucide-user-round-cog', label: 'Account settings', to: '/dashboard/account/profile' },
      // Airbnb's "Switch to travelling": the last row before Log out.
      { id: 'switch-personal', icon: 'i-lucide-repeat-2', label: 'Switch to Personal', action: {} },
      { id: 'log-out', icon: 'i-lucide-log-out', label: 'Log out', action: {} },
    ]
  })

  const groups = computed<EditorNavigationGroup[]>(() => [{ id: organization.value ? 'organization' : 'account', items: items.value }])

  /** The row whose destination is open, for the slideover's current row. */
  const activeItem = computed(() => {
    const open = new Set(route.matched.map(record => routeRecordPath(router, record, route.params)))
    return items.value.find(item => item.to && open.has(item.to))?.id ?? null
  })

  return { groups, activeItem, permissions, error: permissionLoad.error, pending: permissionLoad.pending, ready: permissionLoad }
}
