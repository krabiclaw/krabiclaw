<template>
  <DashboardIndexPanel :id="personalScope ? 'account-today' : 'org-today'" title="Today">
    <template #center>
      <div class="tog" role="tablist" aria-label="Work view">
        <button v-for="item in ranges" :key="item.value" type="button" role="tab" :aria-selected="range === item.value" :tabindex="range === item.value ? 0 : -1" :data-testid="`today-range-${item.value}`" @click="range = item.value" @keydown="onRangeKeydown">{{ item.label }}</button>
      </div>
    </template>
    <template #right>
      <UDropdownMenu v-if="canCreate && canAddStay" :items="addItems" :content="{ align: 'end' }">
        <UButton icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add" />
      </UDropdownMenu>
      <UButton v-else-if="canCreate" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add task" data-testid="today-add-task" @click="createOpen = true" />
      <UButton v-else-if="canAddStay" :to="addStayPath" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add stay" />
      <UDropdownMenu v-if="!personalScope" :items="kindItems" :content="{ align: 'end' }">
        <UButton icon="i-lucide-sliders-horizontal" color="neutral" :variant="taskKind ? 'solid' : 'soft'" square aria-label="Filter tasks" />
      </UDropdownMenu>
    </template>

    <div class="mx-auto w-full max-w-[640px]">
      <UAlert v-if="loadError" class="mb-6" color="error" variant="soft" :title="`${range === 'today' ? 'Today' : 'Upcoming'} could not be loaded`" :description="getErrorMessage(loadError, 'The request failed')">
        <template #actions><UButton color="error" variant="soft" size="xs" @click="() => refresh()">Retry</UButton></template>
      </UAlert>
      <UAlert v-if="actionError" class="mb-6" color="error" variant="soft" title="Your change could not be saved" :description="getErrorMessage(actionError, 'The request failed')" />

      <!-- A guest account's own visits. -->
      <template v-if="personalScope">
        <ul v-if="visits.length" class="space-y-4" role="list" data-testid="today-list">
          <li v-for="item in visits" :key="item.id"><TodayAgendaCard :item="item" /></li>
        </ul>
        <p v-else-if="!pending && !loadError" class="text-sm text-muted">{{ range === 'today' ? 'No bookings today' : 'No upcoming bookings' }}</p>
      </template>

      <!-- The business's stored tasks and opportunities. -->
      <template v-else-if="business">
        <UAlert v-if="business.opportunity_issues.length" class="mb-6" color="warning" variant="soft" title="Some performance data could not be loaded" :description="business.opportunity_issues.join(' ')" />
        <section v-if="business.website" class="mb-6 overflow-hidden rounded-3xl border border-default" data-testid="today-website">
          <div class="relative aspect-video overflow-hidden bg-elevated">
            <iframe :src="business.website.preview_url" :title="business.website.preview_label" class="absolute left-0 top-0 h-[200%] w-[200%] origin-top-left scale-50 border-0" referrerpolicy="no-referrer" loading="lazy" />
            <UButton
              :to="business.website.preview_url"
              :aria-label="business.website.preview_label"
              icon="i-lucide-maximize-2"
              color="neutral"
              variant="solid"
              class="absolute right-3 top-3 rounded-full"
              external
              target="_blank"
              rel="noopener noreferrer"
            />
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span class="inline-flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1 text-sm font-medium">
              <UIcon :name="business.website.action.type === 'publish' ? 'i-lucide-lock' : 'i-lucide-globe'" class="size-4" />
              {{ business.website.status_label }}
            </span>
            <UButton :to="business.website.action.to" :external="business.website.action.type === 'visit'" :target="business.website.action.type === 'visit' ? '_blank' : undefined" :label="business.website.action.label" />
          </div>
        </section>
        <!-- Airbnb's reservations: one card per booking, its suggestion at the foot. -->
        <template v-if="business.reservations.cards.length">
          <h2 class="wtitle" data-testid="today-reservations-title">{{ business.reservations.title }}</h2>
          <ul class="wgrid" role="list" data-testid="today-reservations">
            <li v-for="card in business.reservations.cards" :key="card.id">
              <TaskCard :booking="card" :busy="card.suggestion ? opportunityBusy[card.suggestion.id] !== undefined : false" @dismiss="card.suggestion && dismiss(card.suggestion)" />
            </li>
          </ul>
        </template>
        <!-- Open work, then Opportunities full width, then Done (or Upcoming's days). -->
        <template v-for="part in parts" :key="part.key">
          <template v-if="part.section">
            <h2 v-if="part.section.title" class="wh2">{{ part.section.title }}<small v-if="part.section.subtitle">{{ part.section.subtitle }}</small></h2>
            <ul class="wgrid" role="list" :data-testid="`today-section-${part.section.id}`">
              <li v-for="task in part.section.tasks" :key="task.id">
                <TaskCard :task="task" :busy="taskBusy[task.id] !== undefined" @open="openTask(task)" @skip="skip(task)" />
              </li>
            </ul>
          </template>
          <template v-else>
            <ul class="wgrid" role="list" data-testid="today-opportunities">
              <li v-for="opportunity in business.opportunities" :key="opportunity.id">
                <TaskCard :opportunity="opportunity" :busy="opportunityBusy[opportunity.id] !== undefined" @dismiss="dismiss(opportunity)" />
              </li>
            </ul>
          </template>
        </template>
        <p v-if="!business.website && !business.tasks.length && !business.opportunities.length && !business.reservations.cards.length && !pending" class="text-sm text-muted" data-testid="today-empty">{{ range === 'today' ? 'Nothing to do today' : 'Nothing planned yet' }}</p>
      </template>

      <div v-if="pending && !loadError" class="flex min-h-24 items-center justify-center" aria-live="polite">
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
      </div>
    </div>

    <TodayTaskSheet v-if="!personalScope && organizationId" v-model:open="sheetOpen" :task="openedTask" :organization-id="organizationId" :assignees="business?.assignees ?? []" @changed="taskChanged" />
    <TodayTaskCreate v-if="canCreate && organizationId" v-model:open="createOpen" :organization-id="organizationId" :assignees="business?.assignees ?? []" @created="taskChanged" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import TodayAgendaCard from './TodayAgendaCard.vue'
import TaskCard from './TaskCard.vue'
import TodayTaskSheet from './TodayTaskSheet.vue'
import TodayTaskCreate from './TodayTaskCreate.vue'
import { getErrorMessage } from '~/utils/errors'
import { agendaToTodayCard, todayFeedSchema, type TodayCard, type TodayFeedPayload, type TodayReservation } from '~/shared/dashboard-today'
import type { AgendaPayload } from '~/server/utils/dashboard-agenda'
import type { TaskKind, TaskPerson, TaskSection, TaskView } from '~/server/domain/tasks'
import type { OpportunityView } from '~/server/domain/opportunities'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { addLocalDays, localDateAt } from '~/utils/timezone'

useSeoMeta({ title: 'Today | KrabiClaw', robots: 'noindex, nofollow' })

const props = defineProps<{ personalScope?: boolean }>()
type Range = 'today' | 'upcoming'
interface BusinessToday {
  website: { preview_url: string; preview_label: string; status_label: string; action: { label: string; to: string; type: 'publish' | 'visit' } } | null
  reservations: { title: string | null; cards: TodayReservation[] }
  tasks: TaskSection[]
  opportunities: OpportunityView[]
  opportunity_issues: string[]
  assignees: TaskPerson[]
  resolved_at: string
}
const ranges: Array<{ label: string; value: Range }> = [{ label: 'Today', value: 'today' }, { label: 'Upcoming', value: 'upcoming' }]

const route = useRoute()
const router = useRouter()
const realtime = useDashboardInvalidations()
const orgSlug = computed(() => props.personalScope ? 'account' : String(route.params.org_slug ?? ''))
const organizationId = props.personalScope ? null : useDashboardOrganizationId()
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const { organization, hasFeature } = useDashboardOrganization()
const roleAllows = (permissions: Parameters<typeof authClient.organization.checkRolePermission>[0]['permissions']) => {
  const role = organization.value?.role as keyof typeof organizationRoles | undefined
  return Boolean(role && authClient.organization.checkRolePermission({ role, permissions }))
}
const canAddStay = computed(() => !props.personalScope && hasFeature('stays') && roleAllows({ operations: ['update'] }))
const canCreate = computed(() => !props.personalScope && roleAllows({ task: ['create'] }))
const createOpen = ref(false)
const addStayPath = computed(() => `/dashboard/${encodeURIComponent(orgSlug.value)}/bookings/stay/new`)
const addItems = computed(() => [
  { label: 'Add task', icon: 'i-lucide-list-plus', onSelect: () => { createOpen.value = true } },
  { label: 'Add stay', icon: 'i-lucide-bed-double', to: addStayPath.value },
])

const kindLabels: Record<TaskKind, string> = {
  turnover: 'Turnovers',
  guest_reply: 'Guest replies',
  message_delivery: 'Message delivery',
  booking_review: 'Booking reviews',
  booking_change: 'Booking changes',
  opportunity: 'Accepted opportunities',
  custom: 'Custom tasks',
  stay_ready: 'Homes to get ready',
  consultation_prep: 'Consultation preparation',
  consultation_follow_up: 'Consultation follow-ups',
}
const taskKind = computed(() => !props.personalScope && typeof route.query.kind === 'string' ? route.query.kind : undefined)
const kindItems = computed(() => [[
  { label: 'All tasks', type: 'checkbox' as const, checked: !taskKind.value, onSelect: () => setTaskKind(undefined) },
  ...Object.entries(kindLabels).map(([kind, label]) => ({ label, type: 'checkbox' as const, checked: taskKind.value === kind, onSelect: () => setTaskKind(kind) })),
]])
function setTaskKind(kind: string | undefined) {
  void router.replace({ query: { ...route.query, kind } })
}

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

const isWebsite = (value: unknown) => value === null || isRecord(value) && typeof value.preview_url === 'string'
  && typeof value.preview_label === 'string' && typeof value.status_label === 'string' && isRecord(value.action)
  && typeof value.action.label === 'string' && typeof value.action.to === 'string' && (value.action.type === 'publish' || value.action.type === 'visit')
const isBusinessToday = (value: unknown): value is BusinessToday => isRecord(value) && isWebsite(value.website) && isRecord(value.reservations) && Array.isArray(value.reservations.cards) && Array.isArray(value.tasks) && Array.isArray(value.opportunities) && Array.isArray(value.assignees) && typeof value.resolved_at === 'string'
const isFeed = (value: unknown): value is TodayFeedPayload => todayFeedSchema.safeParse(value).success
const isAgenda = (value: unknown): value is AgendaPayload => isRecord(value) && Array.isArray(value.items)

const { data, pending, error: loadError, refresh } = await useAsyncData(
  () => `today-${orgSlug.value}-${range.value}-${taskKind.value ?? 'all'}`,
  async (): Promise<{ business: BusinessToday | null; visits: TodayCard[] }> => {
    if (!props.personalScope) return { business: await dashboardApi<BusinessToday>('/api/dashboard/today', { query: { range: range.value, kind: taskKind.value }, validate: isBusinessToday }), visits: [] }
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
const parts = computed(() => {
  const sections = business.value?.tasks ?? []
  const open = sections.filter(section => section.id === 'open'), rest = sections.filter(section => section.id !== 'open')
  return [...open.map(section => ({ key: section.id, section })),
    ...(business.value?.opportunities.length ? [{ key: 'opportunities', section: null }] : []),
    ...rest.map(section => ({ key: section.id, section }))]
})
const visits = computed(() => data.value?.visits ?? [])

// The task sheet; `?task=` opens it, which is where an alert's link lands.
const sheetOpen = ref(false)
const openedTask = ref<TaskView | null>(null)
const isTaskResult = (value: unknown): value is { task: TaskView } => isRecord(value) && isRecord(value.task) && typeof value.task.id === 'string'
function openTask(task: TaskView) {
  openedTask.value = task
  sheetOpen.value = true
}
watch(() => route.query.task, async (id) => {
  if (props.personalScope || typeof id !== 'string' || !organizationId) return
  try {
    openTask((await applicationFetch<{ task: TaskView }>(`/api/organizations/${encodeURIComponent(organizationId)}/tasks/${encodeURIComponent(id)}`, { validate: isTaskResult })).task)
  } catch (cause) {
    actionError.value = cause
  }
}, { immediate: true })
watch(sheetOpen, (isOpen) => {
  if (!isOpen && route.query.task) void router.replace({ query: { ...route.query, task: undefined } })
})
async function taskChanged() { await refresh() }

const actionError = ref<unknown>(null)
const taskBusy = ref<Record<string, 'skip'>>({})
const opportunityBusy = ref<Record<string, 'later'>>({})
const tasksApi = computed(() => `/api/organizations/${encodeURIComponent(organizationId ?? '')}`)

async function act<T extends Record<string, string>>(busy: Ref<T>, id: string, state: T[string], request: () => Promise<unknown>) {
  busy.value = { ...busy.value, [id]: state }
  actionError.value = null
  try {
    await request()
    await refresh()
  } catch (cause) {
    actionError.value = cause
  } finally {
    const { [id]: _done, ...rest } = busy.value
    busy.value = rest as T
  }
}
const skip = (task: TaskView) => act(taskBusy, task.id, 'skip', () => applicationFetch(`${tasksApi.value}/tasks/${encodeURIComponent(task.id)}/skip`, { method: 'POST', validate: isTaskResult, body: {} }))
const isOpportunityResult = (value: unknown): value is { opportunity: { id: string } } => isRecord(value) && isRecord(value.opportunity) && typeof value.opportunity.id === 'string'
const dismiss = (opportunity: OpportunityView) => act(opportunityBusy, opportunity.id, 'later', () => applicationFetch(`${tasksApi.value}/opportunities/${encodeURIComponent(opportunity.id)}/dismiss`, { method: 'POST', validate: isOpportunityResult, body: {} }))

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
.wh2 { margin: 28px 2px 16px; font-size: 22px; line-height: 28px; font-weight: 700; letter-spacing: -.02em; color: var(--ui-text-highlighted); }
.wh2 small { margin-left: 8px; font-size: 15px; line-height: 20px; font-weight: 400; letter-spacing: 0; color: var(--ui-text-muted); }
.wgrid { display: grid; gap: 20px; }
.wgrid + .wgrid { margin-top: 20px; }
@media (max-width: 767px) { .wgrid { gap: 12px; } .wgrid + .wgrid { margin-top: 12px; } }
</style>
