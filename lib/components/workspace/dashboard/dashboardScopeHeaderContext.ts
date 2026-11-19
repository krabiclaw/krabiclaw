import type { ComputedRef, InjectionKey } from 'vue'
import type { DashboardScopeHeaderModel } from './DashboardScopeHeader.vue'
import type { DashboardWorkspaceLink } from '~/composables/useDashboardOrganization'

export const dashboardScopeHeaderModelKey: InjectionKey<ComputedRef<DashboardScopeHeaderModel>> = Symbol('dashboard-scope-header-model')
export const dashboardWorkspaceLinksKey: InjectionKey<ComputedRef<readonly DashboardWorkspaceLink[]>> = Symbol('dashboard-workspace-links')
