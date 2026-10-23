import type { EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { authClient } from '~/lib/auth-client'
import { canOpenPlatformAccounts } from '~/utils/platform-admin-access'
import type { organizationRoles } from '~/utils/organization-access'

// The rows on Menu. Menu is a launcher: every row is a destination of its own
// — Website, Posts, Locations, Team, Plan and billing — or an action, with no headings. The Menu
// page and the desktop slideover render this one list, so a row exists in one
// place. A destination is not nested under Menu; it names Menu as its tab.
//
// The organization is the shell's (useDashboardMenu): the route's, otherwise
// Better Auth's active one, so Account settings opened from inside an
// organization keeps that organization's Menu.
export function useOrganizationSettingsNavigation(organization: Ref<{ id: string; slug: string } | null>) {
  const route = useRoute()
  const router = useRouter()
  const dashboard = useDashboardOrganization()
  const session = authClient.useSession()

  const base = computed(() => organization.value ? `/dashboard/${encodeURIComponent(organization.value.slug)}` : null)

  /**
   * Every account on the platform, and impersonation: KrabiClaw runs on
   * KrabiClaw, so only its own organization's Menu carries this row, and only
   * for a Better Auth admin. The template is read off the route's loaded
   * organization context, the same reading the page itself gates on. Airbnb
   * has no equivalent; internal admin tooling is not in the host's dashboard.
   */
  const showPlatformAccounts = computed(() => {
    const loaded = dashboard.organization.value
    return Boolean(loaded && canOpenPlatformAccounts(loaded, (session.value.data?.user as { role?: string | null } | undefined)?.role))
  })

  /**
   * Plan and billing is read by owners and admins, by Better Auth's billing
   * permission: the routed organization's role, otherwise the active member's,
   * since the shell outside an organization's routes is the active one.
   */
  const activeMemberRole = authClient.useActiveMemberRole()
  const memberRole = computed(() => {
    const routed = dashboard.organization.value
    return routed && routed.id === organization.value?.id ? routed.role : activeMemberRole.value.data?.role
  })
  const showBilling = computed(() => Boolean(memberRole.value) && authClient.organization.checkRolePermission({ role: memberRole.value as keyof typeof organizationRoles, permissions: { billing: ['read'] } }))
  const showTeam = computed(() => Boolean(memberRole.value) && authClient.organization.checkRolePermission({ role: memberRole.value as keyof typeof organizationRoles, permissions: { members: ['read'] } }))

  const items = computed(() => {
    if (!base.value) return []
    return [
      { id: 'website', icon: 'i-lucide-panels-top-left', label: 'Website', to: `${base.value}/website` },
      { id: 'locations', icon: 'i-lucide-map-pin', label: 'Locations', to: `${base.value}/locations` },
      ...(showTeam.value ? [{ id: 'team', icon: 'i-lucide-users', label: 'Team', to: `${base.value}/team` }] : []),
      { id: 'integrations', icon: 'i-lucide-plug', label: 'Integrations', to: `${base.value}/integrations` },
      // What the organization pays KrabiClaw. Owners change it and admins read it; members have no row.
      ...(showBilling.value ? [{ id: 'billing', icon: 'i-lucide-receipt', label: 'Plan and billing', to: `${base.value}/billing` }] : []),
      // "Team" is this organization's members; this is every account there is.
      ...(showPlatformAccounts.value
        ? [{ id: 'platform-accounts', icon: 'i-lucide-shield-user', label: 'Platform accounts', to: `${base.value}/platform-accounts` }]
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

  const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'organization', items: items.value }])

  /** The row whose destination is open, for the slideover's current row. */
  const activeItem = computed(() => {
    const open = new Set(route.matched.map(record => routeRecordPath(router, record, route.params)))
    return items.value.find(item => item.to && open.has(item.to))?.id ?? null
  })

  return { groups, activeItem }
}
