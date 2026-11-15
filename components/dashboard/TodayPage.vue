<template>
  <DashboardIndexPanel :id="personalScope ? 'account-today' : 'org-today'" title="Today">
    <template #center>
      <div class="tog" role="tablist" aria-label="Work view">
        <button v-for="item in ranges" :key="item.value" type="button" role="tab" :aria-selected="range === item.value" :tabindex="range === item.value ? 0 : -1" :data-testid="`today-range-${item.value}`" @click="range = item.value" @keydown="onRangeKeydown">{{ item.label }}</button>
      </div>
    </template>
    <template #right>
      <UButton v-if="canAddStay" :to="addStayPath" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add stay" />
    </template>

    <div class="mx-auto w-full max-w-[640px]">
      <UAlert v-if="loadError" class="mb-6" color="error" variant="soft" :title="`${range === 'today' ? 'Today' : 'Upcoming'} could not be loaded`" :description="getErrorMessage(loadError, 'The request failed')">
        <template #actions><UButton color="error" variant="soft" size="xs" @click="() => refresh()">Retry</UButton></template>
      </UAlert>

      <!-- A guest account's own visits. -->
      <template v-if="personalScope">
        <ul v-if="visits.length" class="space-y-4" role="list" data-testid="today-list">
          <li v-for="item in visits" :key="item.id"><TodayAgendaCard :item="item" /></li>
        </ul>
        <p v-else-if="!pending && !loadError" class="text-sm text-muted">{{ range === 'today' ? 'No bookings today' : 'No upcoming bookings' }}</p>
      </template>

      <!-- The business's one list for the person looking. -->
      <template v-else-if="business">
        <h2 class="wtitle" data-testid="today-title">{{ business.title }}</h2>
        <ul v-if="business.cards.length" class="wgrid" role="list" data-testid="today-list">
          <li v-for="item in business.cards" :key="item.id"><TodayItemCard :item="item" /></li>
        </ul>
      </template>

      <div v-if="pending && !loadError" class="flex min-h-24 items-center justify-center" aria-live="polite">
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
      </div>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import TodayAgendaCard from './TodayAgendaCard.vue'
import TodayItemCard from './TodayItemCard.vue'
import { getErrorMessage } from '~/utils/errors'
import { agendaToTodayCard, todayFeedSchema, type BusinessToday, type TodayCard, type TodayFeedPayload } from '~/shared/dashboard-today'
import { businessChanged, type HeldRead } from '~/composables/useDashboardInvalidations'
import type { AgendaPayload } from '~/server/utils/dashboard-agenda'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { addLocalDays, localDateAt } from '~/utils/timezone'

useSeoMeta({ title: 'Today | KrabiClaw', robots: 'noindex, nofollow' })

const props = defineProps<{ personalScope?: boolean }>()
type Range = 'today' | 'upcoming'
const ranges: Array<{ label: string; value: Range }> = [{ label: 'Today', value: 'today' }, { label: 'Upcoming', value: 'upcoming' }]

const route = useRoute()
const router = useRouter()
const realtime = useDashboardInvalidations()
const orgSlug = computed(() => props.personalScope ? 'account' : String(route.params.org_slug ?? ''))
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const { organization, hasFeature } = useDashboardOrganization()
const roleAllows = (permissions: Parameters<typeof authClient.organization.checkRolePermission>[0]['permissions']) => {
  const role = organization.value?.role as keyof typeof organizationRoles | undefined
  return Boolean(role && authClient.organization.checkRolePermission({ role, permissions }))
}
const canAddStay = computed(() => !props.personalScope && hasFeature('stays') && roleAllows({ operations: ['update'] }))
const addStayPath = computed(() => `/dashboard/${encodeURIComponent(orgSlug.value)}/bookings/stay/new`)

const range = computed<Range>({
  get: () => route.query.range === 'upcoming' ? 'upcoming' : 'today',
  set: value => { void router.replace({ query: { ...route.query, range: value === 'upcoming' ? 'upcoming' : undefined } }) },
})
function onRangeKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (ranges.findIndex(item => item.value === range.value) + 1) % 2
  range.value = ranges[index]!.value
  ;(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
}

const isBusinessToday = (value: unknown): value is BusinessToday => isRecord(value) && typeof value.title === 'string' && Array.isArray(value.cards) && typeof value.resolved_at === 'string'
const isFeed = (value: unknown): value is TodayFeedPayload => todayFeedSchema.safeParse(value).success
const isAgenda = (value: unknown): value is AgendaPayload => isRecord(value) && Array.isArray(value.items)

// A return within the live connection shows the Today it left, as the Messages inbox does: kept for
// 30 seconds while the socket stays open, dropped by any event Today re-reads on.
const todayKey = () => `today-${orgSlug.value}-${range.value}`
let reading: HeldRead | undefined
let reuseExpiresAt: number | undefined
const { data, pending, status: loadStatus, error: loadError, refresh } = await useAsyncData(
  todayKey,
  async (): Promise<{ business: BusinessToday | null; visits: TodayCard[] }> => {
    if (!props.personalScope) {
      const held = realtime.held.take(`today:${todayKey()}`)
      reading = realtime.held.begin(`today:${todayKey()}`, businessChanged)
      reuseExpiresAt = held?.expiresAt
      if (isBusinessToday(held?.value)) return { business: held.value, visits: [] }
      return { business: await dashboardApi<BusinessToday>('/api/dashboard/today', { query: { range: range.value }, validate: isBusinessToday }), visits: [] }
    }
    if (range.value === 'today') return { business: null, visits: (await applicationFetch<TodayFeedPayload>('/api/account/today', { validate: isFeed })).cards }
    // A guest's upcoming visits: the next year of their own agenda, after today.
    const now = new Date()
    // From yesterday's UTC date, so every zone's tomorrow is inside; each visit is then compared in its own zone.
    const from = addLocalDays(now.toISOString().slice(0, 10), -1)
    const agenda = await applicationFetch<AgendaPayload>('/api/account/agenda', { query: { from, to: addLocalDays(from, 364), kinds: 'booking,stay' }, validate: isAgenda })
    return { business: null, visits: agenda.items.filter(item => item.day_key > localDateAt(now, item.timezone)).map(item => agendaToTodayCard(item, { resolved_at: now.toISOString() })) }
  },
)
const business = computed(() => data.value?.business ?? null)
onScopeDispose(() => {
  const current = business.value
  // Reusing a held read does not extend its life.
  if (!props.personalScope && current && reading && loadStatus.value === 'success') realtime.held.hold(reading, current, reuseExpiresAt ?? Date.now() + 30_000, 1)
})
const visits = computed(() => data.value?.visits ?? [])

watch(realtime.event, (event) => {
  if (!event) return
  if (['business.changed', 'stay.changed', 'access.changed', 'MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(event.type)) void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refresh() })
function resume() { if (document.visibilityState === 'visible') void refresh() }
// Today changes at the viewer's midnight with no write; re-read each minute while visible.
let minute: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  window.addEventListener('focus', resume)
  document.addEventListener('visibilitychange', resume)
  minute = setInterval(resume, 60_000)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', resume)
  document.removeEventListener('visibilitychange', resume)
  if (minute) clearInterval(minute)
})
</script>

<style scoped>
.tog { display: flex; min-width: 0; gap: 12px; }
.tog button { min-height: 46px; padding: 0 clamp(12px, 5vw, 24px); border-radius: 999px; background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); font-size: 15px; font-weight: 600; }
.tog button[aria-selected="true"] { background: var(--ui-bg-inverted); color: var(--ui-text-inverted); box-shadow: 0 3px 8px rgb(0 0 0 / 14%); }
.tog button:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: 2px; }
.wtitle { margin: 8px 0 24px; text-align: center; font-size: 28px; line-height: 34px; font-weight: 700; letter-spacing: -.02em; color: var(--ui-text-highlighted); text-wrap: balance; }
.wgrid { display: grid; gap: 20px; }
.wgrid + .wgrid { margin-top: 20px; }
@media (max-width: 767px) { .wgrid { gap: 12px; } .wgrid + .wgrid { margin-top: 12px; } }
</style>
