import { HTTPError, type H3Event } from 'nitro'
import { useNitroApp } from 'nitro/app'
import { MEMBER_BUSY_SCOPES } from '~/shared/member-scheduling'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, STARTER_PLAN_ID } from '~/shared/billing-model'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { INTEGRATIONS, type IntegrationKey } from '~/shared/integrations'
import type { CatalogAnswer, CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import { getOrganizationEntitlements } from '~/server/utils/billing-access'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { getSocialConnections } from '~/server/utils/social-publication'
import { loadOrganizationFeatures } from '~/server/utils/cms-capabilities'
import { createAuth, requireIntegrationAccount } from '~/server/utils/auth'
import { readIntegration } from '~/server/utils/organization-integrations'
import { loadSettingsPayload } from '~/server/utils/organization-settings'
import { assertOrganizationWideAccess, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { requireSchedulingAccess, readMemberScheduling } from '~/server/domain/member-scheduling'
import type { getDashboardMemberContext } from '~/server/utils/dashboard-context'

const inventory = {
  facebook: { path: 'pages', list: 'choices', id: 'id', name: 'name', key: 'page_id' },
  discord: { path: 'channels', list: 'choices', id: 'id', name: 'name', key: 'channel_id' },
  'google-analytics': { path: 'properties', list: 'properties', id: 'property_id', name: 'property_name', key: 'property_id', nameKey: 'property_name' },
  'google-search-console': { path: 'sites', list: 'properties', id: 'site_url', name: 'site_url', key: 'site_url' },
  'google-ads': { path: 'accounts', list: 'accounts', id: 'customerId', name: 'descriptiveName', key: 'customer_id', nameKey: 'customer_name' },
  'meta-ads': { path: 'accounts', list: 'accounts', id: 'id', name: 'name', key: 'ad_account_id', nameKey: 'ad_account_name' },
} as const

const plans = [STARTER_PLAN_ID, GROWTH_PLAN_ID, BUSINESS_PLAN_ID] as const
const planLabel = (plan: string) => plan === STARTER_PLAN_ID ? 'Free' : plan.charAt(0).toUpperCase() + plan.slice(1)
export const connectionGroups = [{ id: 'sync', label: 'Sync' }, { id: 'connection', label: 'Connections' }]
export const connectionFilters = [{ value: 'all', label: 'All' }, ...plans.map(plan => ({ value: plan, label: planLabel(plan) }))]

type Summary = Awaited<ReturnType<typeof loadSettingsPayload>>['integrations']
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
  { db, env, organization }: Pick<Awaited<ReturnType<typeof getDashboardMemberContext>>, 'db' | 'env' | 'organization'>, summary: Summary,
): Promise<ConnectionRow[]> {
  const [features, allowed] = await Promise.all([
    loadOrganizationFeatures(db, organization.id),
    getOrganizationEntitlements(env, organization.id),
  ])
  const base = `/dashboard/${encodeURIComponent(organization.slug)}/integrations`
  const maps = summary.google_maps
  const mapped = maps.filter(location => location.google_place_id).length
  const rows = INTEGRATIONS.filter(item => !item.feature || features.includes(item.feature)).map((item): ConnectionRow => {
    const state = target(summary, item.key)
    const plan = plans.find(plan => !item.entitlement || getPlanEntitlements(plan)[item.entitlement] === true) ?? BUSINESS_PLAN_ID
    const locked = item.entitlement && allowed[item.entitlement] !== true
    const status = locked ? undefined
      : item.key === 'google-maps' ? mapped ? 'success' : 'neutral'
        : state?.state === 'error' || state?.state === 'needs_review' ? 'error'
          : state && state.state !== 'disabled' && state.state !== 'not_connected' ? 'success' : 'neutral'
    const description = locked ? `Included with ${planLabel(plan)}`
      : item.key === 'google-maps' ? maps.length ? `${mapped} of ${maps.length} ${maps.length === 1 ? 'location' : 'locations'} connected` : 'No locations yet'
        : state?.state === 'error' ? [state.name, 'Needs attention'].filter(Boolean).join(' · ')
          : state?.state === 'needs_review' ? 'Needs review'
            : state?.state === 'disabled' || state?.state === 'not_connected' ? 'Not connected' : state?.name ?? (state ? 'Connected' : 'Not connected')
    return {
      id: item.key, label: item.name, summary: description, status, group: item.group, plan, icon: item.logo,
      to: `${base}/${item.key}`, native: item.key === 'airbnb' ? 'airbnb-connections' : 'connection', query: { integration: item.key },
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

function invalid(message: string, statusCode = 422): never {
  throw new HTTPError({ statusCode, message })
}

export async function dashboardConnections(
  event: H3Event, context: Awaited<ReturnType<typeof getDashboardMemberContext>>,
  view: string, query: Record<string, unknown>, answer?: CatalogAnswer,
): Promise<CatalogScreen> {
  const { db, env, organization } = context
  const personal = view === 'connection-personal-calendar' || query.integration === 'personal-calendar'
  if (!personal) await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  const definition = INTEGRATIONS.find(item => item.key === query.integration)
  const row = (id: string, label: string, native: string, params: Record<string, string>, description?: string): CatalogRow =>
    ({ id, label, native, query: params, summary: description })
  const index = (title: string, rows: CatalogRow[]): CatalogScreen => ({ title, rows, fields: [] })
  const form = (title: string, revision: string, fields: CatalogScreen['fields'], save_label: string): CatalogScreen =>
    ({ title, fields, revision, save_label, rows: [] })
  const base = `/api/organizations/${encodeURIComponent(organization.id)}/integrations`
  async function api<T>(path: string, body?: object): Promise<T> {
    const headers = new Headers(event.req.headers)
    for (const key of ['content-length', 'content-type', 'transfer-encoding']) headers.delete(key)
    if (body) headers.set('content-type', 'application/json')
    const request = Object.assign(new Request(new URL(path, event.url), {
      method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}),
    }), { runtime: event.req.runtime })
    const response = await useNitroApp().fetch(request)
    const result = await response.json() as T & { success?: boolean; error?: string; message?: string }
    if (!response.ok || result.success === false || result.error) {
      invalid(result.error || result.message || 'The connection operation failed', response.ok ? 422 : response.status)
    }
    return result
  }
  if (personal) {
    const memberId = typeof query.member_id === 'string' ? query.member_id : invalid('Member not found', 404)
    const actor = { env, organizationId: organization.id, userId: context.userId }
    const member = await requireSchedulingAccess(actor, memberId)
    if (member.userId !== context.userId) return invalid('Connect your own Google account', 403)
    const schedule = await readMemberScheduling(db, env, organization.id, memberId)
    const connected = Boolean(schedule?.calendar_ids.length)
    const entitled = await hasOrganizationEntitlement(env, organization.id, 'calendar_sync')
    const scope = { member_id: memberId, integration: 'personal-calendar' }
    const title = 'Google Calendar sync'
    if (view === 'connection-personal-calendar') {
      if (answer) return invalid('Choose an action')
      return index(title, [
        { id: 'status', label: schedule?.calendar_status === 'ready' ? 'Checking for conflicts' : 'Not connected',
          summary: 'Google Calendar busy times block bookings with you.' },
        ...(!schedule?.timezone ? [{ id: 'timezone', label: 'Set your timezone first', native: 'member-profile-field', query: { member_id: memberId, field: 'timezone' } }] : []),
        ...(schedule?.timezone && entitled ? [{ id: 'authorize', label: connected ? 'Reconnect Google Calendar' : 'Connect Google Calendar', authorization: 'personal-calendar', query: { member_id: memberId } }] : []),
        ...(connected ? [row('disconnect', 'Disconnect', 'connection-action', { ...scope, action: 'disconnect' })] : []),
        ...(!entitled ? [{ id: 'plan', label: 'Google Calendar sync comes with the Business plan' }] : []),
      ])
    }
    const disconnect = view === 'connection-action' && query.action === 'disconnect'
    const accountId = typeof query.account_id === 'string' ? query.account_id : null
    if (!disconnect && (view !== 'connection-select' || !entitled || !schedule?.timezone || !accountId)) return invalid('Link your Google account first', 403)
    const label = disconnect ? 'Disconnect' : 'Connect'
    if (!disconnect) await requireIntegrationAccount(env, accountId!, { userId: context.userId, currentAccountId: null, providerId: 'google', scopes: MEMBER_BUSY_SCOPES })
    const revision = JSON.stringify([schedule?.updated_at, accountId])
    const screen = form(title, revision, [{ key: 'confirm', label: `${label} your calendar`, kind: 'toggle', value: 'false' }], label)
    if (!answer) return screen
    if (answer.revision !== revision || answer.values.confirm !== 'true') return invalid('Review and confirm your current calendar')
    await api(`/api/organizations/${encodeURIComponent(organization.id)}/members/${encodeURIComponent(memberId)}/calendar`,
      { enabled: !disconnect, ...(accountId && !disconnect ? { account_id: accountId } : {}) })
    return { ...screen, destination: { view: 'connection-personal-calendar', query: scope } }
  }
  const { integrations: summary } = await loadSettingsPayload(db, env, organization.id)
  if (view === 'connections') {
    if (answer) return invalid('Choose a connection')
    return { ...index('Connections', await connectionRows(context, summary)), groups: connectionGroups, filters: connectionFilters }
  }
  if (!definition || definition.key === 'airbnb') return invalid('Connection not found', 404)
  const integration = definition.key
  const managedAds = integration === 'google-ads' && query.service === 'managed-ads'
  const scope: Record<string, string> = { integration, ...(managedAds ? { service: 'managed-ads' } : {}) }
  const entitled = !definition.entitlement || await hasOrganizationEntitlement(env, organization.id, definition.entitlement)
  if (integration === 'google-maps') {
    if (view === 'connection') {
      if (answer) return invalid('Choose a location')
      return index(definition.name, summary.google_maps.map(location => ({
        ...row(location.id, location.title, 'connection-map', { ...scope, location_id: location.id }, location.google_place_id ? 'Connected' : 'Not connected'),
        image: location.image,
      })))
    }
    const location = summary.google_maps.find(item => item.id === query.location_id) ?? invalid('Location not found', 404)
    const mapScope = { ...scope, location_id: location.id }
    if (view === 'connection-map') {
      if (answer) return invalid('Choose an action')
      return index(location.title, [
        { id: 'status', label: location.google_place_id ? 'Connected to Google Maps' : 'Not connected', summary: location.address ?? undefined },
        ...(location.phone ? [{ id: 'phone', label: 'Phone', summary: location.phone }] : []),
        ...(location.website_url ? [{ id: 'website', label: 'Website', summary: location.website_url }] : []),
        ...(location.rating !== null ? [{ id: 'rating', label: `${location.rating} stars`, summary: location.review_count === null ? undefined : `${location.review_count} reviews` }] : []),
        ...(location.last_synced_at ? [{ id: 'updated', label: 'Last imported', summary: location.last_synced_at }] : []),
        ...(entitled ? [row('search', location.google_place_id ? 'Connect a different place' : 'Find this location', 'connection-map-search', mapScope),
          ...(location.google_place_id ? [row('import', 'Re-import details', 'connection-map-import', mapScope)] : [])]
          : [{ id: 'plan', label: 'Google Maps requires the Growth plan' }]),
      ])
    }
    if (!entitled) return invalid('Google Maps requires the Growth plan', 403)
    const revision = JSON.stringify([location.id, location.google_place_id, location.last_synced_at])
    if (view === 'connection-map-search') {
      const screen = form('Find this location', revision, [{ key: 'input', label: 'Business name or address', kind: 'text', value: '' }], 'Search')
      if (!answer) return screen
      if (answer.revision !== revision) return invalid('The location changed. Reopen it before searching.', 409)
      return { ...screen, destination: { view: 'connection-map-results', query: { ...mapScope, input: answer.values.input ?? '', session_token: answer.idempotency_key } } }
    }
    const input = typeof query.input === 'string' ? query.input : ''
    const session_token = typeof query.session_token === 'string' ? query.session_token : ''
    if (view === 'connection-map-results') {
      if (answer) return invalid('Choose a place')
      const { suggestions } = await api<{ suggestions: Array<{ google_place_id: string; name: string; address_label: string }> }>('/api/dashboard/google-places/autocomplete', { input, session_token })
      return { ...index('Google Maps results', suggestions.map(place => row(place.google_place_id, place.name, 'connection-map-import',
        { ...mapScope, place_id: place.google_place_id, session_token, place_name: place.name }, place.address_label))), empty_title: 'No places found' }
    }
    if (view !== 'connection-map-import') return invalid('Connection not found', 404)
    const placeId = typeof query.place_id === 'string' ? query.place_id : location.google_place_id
    if (!placeId) return invalid('Choose a Google Maps place')
    const screen = form(typeof query.place_name === 'string' ? query.place_name : 'Re-import details', revision,
      [{ key: 'confirm', label: 'Replace this location’s details with Google Maps data', kind: 'toggle', value: 'false' }], 'Import')
    if (!answer) return screen
    if (answer.revision !== revision) return invalid('The location changed. Reopen it before importing.', 409)
    if (answer.values.confirm !== 'true') return invalid('Confirm replacing the location details')
    await api('/api/integrations/google-places/sync', { organization_id: organization.id, location_id: location.id, google_place_id: placeId, ...(session_token ? { session_token } : {}) })
    return { ...screen, destination: { view: 'connection-map', query: mapScope } }
  }

  const connection = target(summary, integration)
  const calendar = integration === 'google-calendar'
  const connected = Boolean(connection && connection.state !== 'disabled')
  const path = `${base}/${integration}`
  const calendarState = calendar ? await api<{ cleanup_pending: boolean; calendar: { calendar_id: string; revision: string } | null }>(path) : null
  const members = calendar && view === 'connection' && connected
    ? await api<{ members: Array<{ scheduling: { calendar_ids: string[] } | null }> }>(`/api/organizations/${encodeURIComponent(organization.id)}/members/scheduling`)
    : null
  const accountId = typeof query.account_id === 'string' && query.account_id ? query.account_id : null
  const social = integration === 'facebook' || integration === 'instagram' || integration === 'discord'
  const authorize = { id: 'authorize', label: connected ? 'Reconnect account' : 'Link account', authorization: integration, query: scope }
  if (view === 'connection') {
    if (answer) return invalid('Choose an action')
    const health = social && connected ? (await getSocialConnections(env, organization.id, {
      dashboardBase: new URL(`/dashboard/${encodeURIComponent(organization.slug)}`, event.url).href,
    })).channels.find(item => item.channel === integration) : null
    return index(definition.name, [
      { id: 'status', label: connected ? connection?.name ?? 'Connected' : 'Not connected', summary: connection?.problem ?? definition.purpose },
      ...(health?.problems.map(item => ({ id: `problem:${item.code}`, label: 'Needs attention', summary: item.message })) ?? []),
      ...(connection?.owner ? [{ id: 'account', label: 'Linked by', summary: connection.owner.name ?? connection.owner.email ?? undefined }] : []),
      ...(members ? [{ id: 'conflicts', label: 'Check for conflicts',
        summary: `${members.members.filter(member => member.scheduling?.calendar_ids.length).length} of ${members.members.length} team members checking their calendar` }] : []),
      ...(calendarState?.calendar && connected ? [{ id: 'calendar', label: 'Add bookings to', summary: connection?.name ?? undefined,
        external_url: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(Buffer.from(calendarState.calendar.calendar_id).toString('base64').replace(/=+$/, ''))}` }] : []),
      ...(entitled && !calendarState?.cleanup_pending && (!connected || social || calendar || managedAds) ? [authorize] : []),
      ...(connected ? [row('disconnect', 'Disconnect', 'connection-action', { ...scope, action: 'disconnect' })] : []),
      ...(calendar && (connection?.state === 'error' || calendarState?.cleanup_pending) ? [row('retry', 'Retry sync', 'connection-action', { ...scope, action: 'sync' })] : []),
      ...(!entitled ? [{ id: 'plan', label: 'Your plan does not include this connection' }] : []),
    ])
  }
  if (view === 'connection-action') {
    const action = query.action
    if (action !== 'disconnect' && !(action === 'sync' && calendar)) return invalid('Action unavailable', 404)
    const title = action === 'disconnect' ? 'Disconnect' : 'Retry sync'
    const current = social ? await readIntegration(db, organization.id, integration) : null
    if (social && !current) return invalid('Connection not found', 404)
    const revision = JSON.stringify([connection, calendarState?.calendar?.revision, current?.revision])
    const screen = form(title, revision, [{ key: 'confirm', label: `${title} ${definition.name}`, kind: 'toggle', value: 'false' }], title)
    if (!answer) return screen
    if (answer.revision !== revision || answer.values.confirm !== 'true') return invalid('Review and confirm the current connection')
    await api(`${path}/${action}`, current ? { revision: current.revision } : {})
    return screen
  }
  if (view !== 'connection-select' || !accountId || !entitled) return invalid('Link an eligible account first', 403)
  const provider = integration.startsWith('google-') ? 'google' : integration === 'meta-ads' ? 'facebook' : integration
  const auth = createAuth(env)
  const accounts = await auth.api.listUserAccounts({ headers: event.req.headers })
  if (!accounts.some(account => account.id === accountId && account.providerId === provider)) return invalid('The account is not linked to you', 404)
  const spec = inventory[integration as keyof typeof inventory]
  let choices: Array<{ value: string; label: string; name?: string }> = []
  if (spec) {
    const data = await api<Record<string, unknown>>(`${path}/${spec.path}?${new URLSearchParams({ account_id: accountId, ...(managedAds ? { service: 'managed-ads' } : {}) })}`)
    const items = data[spec.list]
    if (!Array.isArray(items)) return invalid('Could not read provider destinations', 502)
    choices = items.flatMap(item => {
      if (!item || typeof item[spec.id] !== 'string' || item.not_enabled || item.error || (integration === 'google-ads' && item.is_manager)) return []
      const name = typeof item[spec.name] === 'string' ? item[spec.name] : item[spec.id]
      return [{ value: item[spec.id], label: typeof item.server === 'string' ? `${item.server} · ${name}` : name, name }]
    })
    if (integration === 'google-search-console' && typeof data.site_url === 'string' && !choices.some(choice => choice.value === data.site_url)) {
      choices.unshift({ value: data.site_url, label: `${data.site_url} (verify for me)` })
    }
    if (!choices.length) {
      const message = managedAds ? 'No eligible Google Ads accounts billed in USD' : 'No destinations found'
      if (answer) return invalid(message, 409)
      return { ...index(definition.name, [authorize]), empty_title: message }
    }
  } else if (integration === 'instagram') {
    const account = await auth.api.accountInfo({ headers: event.req.headers, query: { accountId } })
    if (!account.user.name) return invalid('Instagram did not return an account name', 502)
    choices = [{ value: accountId, label: account.user.name }]
  }
  const title = connected ? `Reconnect ${definition.name}` : `Connect ${definition.name}`
  const current = social ? await readIntegration(db, organization.id, integration)
    : managedAds ? await readIntegration(db, organization.id, 'google_ads') : null
  const revision = JSON.stringify([connection, current?.revision, accountId, choices])
  const screen = form(title, revision, [
    ...(choices.length ? [{ key: 'destination', kind: 'select' as const, label: managedAds ? 'Google Ads account billed in USD' : 'Destination', value: choices.length === 1 ? choices[0]!.value : '', choices }] : []),
    { key: 'confirm', label: title, kind: 'toggle', value: 'false' },
  ], managedAds ? 'Use this account' : 'Connect')
  if (!answer) return screen
  if (answer.revision !== revision || answer.values.confirm !== 'true') return invalid('Review and confirm the current selection')
  const selected = choices.find(item => item.value === answer.values.destination)
  if (choices.length && !selected) return invalid('Choose a destination')
  const body = { account_id: accountId, ...(current ? { revision: current.revision } : {}), ...(spec && selected ? { [spec.key]: selected.value,
    ...('nameKey' in spec ? { [spec.nameKey]: selected.name } : {}) } : {}) }
  if (connected && !calendar && !social && !managedAds) return invalid('Disconnect this account before selecting a new one', 409)
  await api(`${path}/${calendar ? 'connect' : integration === 'discord' ? 'channels' : 'select'}`, { ...body, ...(managedAds ? { service: 'managed-ads', revision: current?.revision ?? null } : {}) })
  return managedAds ? screen : { ...screen, destination: { view: 'connection', query: scope } }
}
