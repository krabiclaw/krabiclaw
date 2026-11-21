import { getDashboardContext } from '~/server/utils/dashboard-context'
import type { H3Event } from 'nitro'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, STARTER_PLAN_ID } from '~/shared/billing-model'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { vrboEnabled } from '~/server/integrations/channex/hosted-channel'
import { INTEGRATIONS, type IntegrationKey } from '~/shared/integrations'
import type { CatalogRow } from '~/shared/catalog-screen'
import { readDashboardWorkspaceAccess } from '~/server/utils/dashboard-context-service'
import { loadConnectionSummary } from '~/server/utils/organization-settings'
import { oncePerRequest } from '~/server/utils/request-scope'

const plans = [STARTER_PLAN_ID, GROWTH_PLAN_ID, BUSINESS_PLAN_ID] as const
const planLabel = (plan: string) => plan === STARTER_PLAN_ID ? 'Free' : plan.charAt(0).toUpperCase() + plan.slice(1)
export const connectionGroups = [{ id: 'sync', label: 'Sync' }, { id: 'connection', label: 'Connections' }]
export const connectionFilters = [{ value: 'all', label: 'All' }, ...plans.map(plan => ({ value: plan, label: planLabel(plan) }))]

type Summary = Awaited<ReturnType<typeof loadConnectionSummary>>
type ConnectionRow = CatalogRow & { group: 'sync' | 'connection'; plan: typeof plans[number] | null }

function target(summary: Summary, integration: IntegrationKey) {
  const key = integration.replaceAll('-', '_') as keyof Summary
  const connection = summary[key]
  if (!connection || Array.isArray(connection)) return null
  const name = 'target_name' in connection ? connection.target_name : 'calendar_name' in connection ? connection.calendar_name : null
  return {
    name: name && integration === 'instagram' ? `@${name}` : name && integration === 'discord' ? `#${name}` : name,
    problem: 'last_error' in connection ? connection.last_error : null,
    state: connection.status,
    account: 'account_id' in connection ? connection.account_id : null,
    owner: 'connected_through' in connection ? connection.connected_through : null,
  }
}

export async function connectionRows(
  event: H3Event, context: Parameters<typeof readDashboardWorkspaceAccess>[1], summary: Summary,
): Promise<ConnectionRow[]> {
  const { env, organization } = context
  const { effective_plan, features } = await readDashboardWorkspaceAccess(event, context)
  const allowed = getPlanEntitlements(effective_plan)
  const base = `/dashboard/${encodeURIComponent(organization.slug)}/integrations`
  const maps = summary.google_maps
  const mapped = maps.filter(location => location.google_place_id).length
  const rows = INTEGRATIONS.filter(item => (!item.feature || features.includes(item.feature))
    && (item.key !== 'vrbo' || vrboEnabled(env))).map((item): ConnectionRow => {
    const state = target(summary, item.key)
    const plan = plans.find(plan => !item.entitlement || getPlanEntitlements(plan)[item.entitlement] === true) ?? BUSINESS_PLAN_ID
    const locked = item.entitlement && allowed[item.entitlement] !== true
    const status = locked ? undefined
      : item.key === 'google-maps' ? mapped ? 'success' : 'neutral'
        : state?.state === 'error' || state?.state === 'needs_review' ? 'error'
          : state && state.state !== 'disabled' && state.state !== 'not_connected' ? 'success' : 'neutral'
    const description = locked ? `Included with ${planLabel(plan)}`
      : item.key === 'google-maps' ? maps.length ? `${mapped} of ${maps.length} ${maps.length === 1 ? 'location' : 'locations'} connected` : 'No locations yet'
        : item.key === 'vrbo' ? 'Manage listings'
        : state?.state === 'error' ? [state.name, 'Needs attention'].filter(Boolean).join(' · ')
          : state?.state === 'needs_review' ? 'Needs review'
            : state?.state === 'disabled' || state?.state === 'not_connected' ? 'Not connected' : state?.name ?? (state ? 'Connected' : 'Not connected')
    return {
      id: item.key, label: item.name, summary: description, status, group: item.group, plan, icon: item.logo,
      to: `${base}/${item.key}`, native: item.key === 'airbnb' || item.key === 'vrbo' ? `${item.key}-connections` : 'connection', query: { integration: item.key },
    }
  })
  if (features.includes('stays') && await roleAllows({ ...organization, permissions: { operations: ['update'] } })) {
    rows.push({
      id: 'hostaway-migration', label: 'Migrate from Hostaway', group: 'connection', plan: null,
      native: 'hostaway-migration', to: `${base}/hostaway-migration`, summary: 'Move existing stays and check blocked dates', icon: 'i-lucide-arrow-right-left',
    })
  }
  return rows
}

export function readDashboardConnectionsDocument(event: H3Event, orgSlug: string, preloaded?: Summary) {
  return oncePerRequest(event, `dashboard-connections:${orgSlug}`, () => readDashboardConnections(event, orgSlug, preloaded))
}

export async function readDashboardConnections(event: H3Event, orgSlug?: string, preloaded?: Summary) {
  const { db, env, organization } = await getDashboardContext(event, { organizationSlug: orgSlug })
  const integrations = preloaded ?? await loadConnectionSummary(db, organization.id)
  const connections = await connectionRows(event, { db, env, organization }, integrations)
  return { success: true as const, settings: { integrations }, connectionFilters, connectionGroups, connections }
}
