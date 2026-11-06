<template>
  <DashboardIndexPanel :id="personalScope ? 'account-today' : 'org-today'" title="Today">
    <template #right>
      <UButton v-if="canAddStay" :to="`/dashboard/${encodeURIComponent(orgSlug)}/bookings/stay/new`" icon="i-lucide-plus" color="neutral" variant="ghost" aria-label="Add stay" />
    </template>

    <div class="mx-auto w-full max-w-3xl">
      <div class="quest-tabs mb-6 flex gap-3 py-4" role="tablist" aria-label="Work view">
        <button v-for="item in ranges" :key="item.value" type="button" role="tab" :aria-selected="range === item.value" :tabindex="range === item.value ? 0 : -1" :data-testid="`today-range-${item.value}`" class="quest-tab" @click="range = item.value" @keydown="onRangeKeydown">{{ item.label }}</button>
      </div>

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
        <UAlert v-if="business.opportunityIssues.length" class="mb-6" color="warning" variant="soft" title="Some performance data could not be loaded" :description="business.opportunityIssues.join(' ')" />
        <section v-for="section in business.tasks" :key="section.id" class="mb-6" :data-testid="`today-section-${section.id}`">
          <h2 class="mb-2.5 text-sm font-semibold text-muted">{{ section.title }}</h2>
          <ul class="space-y-2.5" role="list" data-testid="today-list">
            <li v-for="task in section.tasks" :key="task.id">
              <TodayTaskCard :task="task" :assignees="business.assignees" :busy="taskBusy[task.id] ?? null" @open="openTask" @complete="complete" @assign="assign" />
            </li>
          </ul>
        </section>
        <section v-if="business.opportunities.length" class="mb-6" data-testid="today-opportunities">
          <h2 class="mb-2.5 text-sm font-semibold text-muted">Opportunities</h2>
          <ul class="space-y-2.5" role="list">
            <li v-for="opportunity in business.opportunities" :key="opportunity.id">
              <TodayOpportunityCard :opportunity="opportunity" :busy="opportunityBusy[opportunity.id] ?? null" @accept="accept" @dismiss="dismiss" @defer="defer" />
            </li>
          </ul>
        </section>
        <p v-if="!business.tasks.length && !business.opportunities.length && !pending" class="text-sm text-muted" data-testid="today-empty">{{ range === 'today' ? 'Nothing to do today' : 'Nothing planned yet' }}</p>

        <details v-if="canManage && range === 'today'" class="mt-8" role="group" aria-label="Your priority" data-testid="today-priorities">
          <summary class="cursor-pointer text-sm font-medium">Business goals</summary>
          <ul v-if="goals.length" class="mb-4 space-y-2">
            <li v-for="goal in goals" :key="goal.id" class="flex items-start justify-between gap-3 rounded-lg bg-elevated/50 px-3 py-2" data-testid="today-priority">
              <div class="min-w-0 text-sm">
                <span class="text-highlighted">{{ goal.intent }}</span>
                <p v-if="goal.strategy" class="mt-1 text-muted">{{ strategyDescription(goal.strategy) }}</p>
              </div>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Remove priority: ${goal.intent}`" :loading="goalBusy === goal.id" :disabled="goalBusy !== null" @click="removeGoal(goal)" />
            </li>
          </ul>
          <form class="space-y-3" @submit.prevent="addGoal">
            <div class="flex gap-2">
              <UInput v-model="goalDraft" class="flex-1" :maxlength="2000" required placeholder="What should the business focus on now?" aria-label="New priority" />
              <UButton type="submit" color="neutral" variant="soft" label="Add" :loading="goalBusy === 'new'" :disabled="goalBusy !== null || !goalDraft.trim()" />
            </div>
            <details>
              <summary class="cursor-pointer text-sm text-muted">Choose related work (optional)</summary>
              <div class="mt-3 flex flex-wrap gap-x-5 gap-y-3">
                <UCheckbox v-for="channel in strategyChannels" :key="channel.value" :model-value="goalChannels.includes(channel.value)" :label="channel.label" @update:model-value="toggleChannel(channel.value, $event === true)" />
                <UCheckbox v-model="goalPayments" label="Accept payments" />
                <UCheckbox v-model="goalAvailability" label="Booking availability" />
              </div>
            </details>
          </form>
        </details>
      </template>

      <div v-if="pending && !loadError" class="flex min-h-24 items-center justify-center" aria-live="polite">
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
      </div>
    </div>

    <TodayTaskSheet v-if="!personalScope && organizationId" v-model:open="sheetOpen" :task="openedTask" :organization-id="organizationId" @changed="taskChanged" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import TodayAgendaCard from './TodayAgendaCard.vue'
import TodayTaskCard from './TodayTaskCard.vue'
import TodayTaskSheet from './TodayTaskSheet.vue'
import TodayOpportunityCard from './TodayOpportunityCard.vue'
import { getErrorMessage } from '~/utils/errors'
import { agendaToTodayCard, todayFeedSchema, type TodayCard, type TodayFeedPayload } from '~/shared/dashboard-today'
import type { AgendaPayload } from '~/server/utils/dashboard-agenda'
import type { TaskPerson, TaskSection, TaskView } from '~/server/domain/tasks'
import type { OpportunityView } from '~/server/domain/opportunities'
import type { BusinessGoal, BusinessGoalStrategy } from '~/shared/business-progress'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { addLocalDays, localDateAt } from '~/utils/timezone'

useSeoMeta({ title: 'Today | KrabiClaw', robots: 'noindex, nofollow' })

const props = defineProps<{ personalScope?: boolean }>()
type Range = 'today' | 'upcoming'
interface BusinessToday { tasks: TaskSection[]; opportunities: OpportunityView[]; opportunityIssues: string[]; assignees: TaskPerson[]; resolvedAt: string }
const ranges: Array<{ label: string; value: Range }> = [{ label: 'Today', value: 'today' }, { label: 'Upcoming', value: 'upcoming' }]

const route = useRoute()
const router = useRouter()
const realtime = useDashboardInvalidations()
const orgSlug = computed(() => props.personalScope ? 'account' : String(route.params.orgSlug ?? ''))
const organizationId = props.personalScope ? null : useDashboardOrganizationId()
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const { organization, hasFeature } = useDashboardOrganization()
const roleAllows = (permissions: Parameters<typeof authClient.organization.checkRolePermission>[0]['permissions']) => {
  const role = organization.value?.role as keyof typeof organizationRoles | undefined
  return Boolean(role && authClient.organization.checkRolePermission({ role, permissions }))
}
const canAddStay = computed(() => !props.personalScope && hasFeature('stays') && roleAllows({ operations: ['update'] }))
const canManage = computed(() => !props.personalScope && roleAllows({ task: ['assign'] }))

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

const isBusinessToday = (value: unknown): value is BusinessToday => isRecord(value) && Array.isArray(value.tasks) && Array.isArray(value.opportunities) && Array.isArray(value.assignees) && typeof value.resolvedAt === 'string'
const isFeed = (value: unknown): value is TodayFeedPayload => todayFeedSchema.safeParse(value).success
const isAgenda = (value: unknown): value is AgendaPayload => isRecord(value) && Array.isArray(value.items)

const { data, pending, error: loadError, refresh } = await useAsyncData(
  () => `today-${orgSlug.value}-${range.value}`,
  async (): Promise<{ business: BusinessToday | null; visits: TodayCard[] }> => {
    if (!props.personalScope) return { business: await dashboardApi<BusinessToday>('/api/dashboard/today', { query: { range: range.value }, validate: isBusinessToday }), visits: [] }
    if (range.value === 'today') return { business: null, visits: (await applicationFetch<TodayFeedPayload>('/api/account/today', { validate: isFeed })).cards }
    // A guest's upcoming visits: the next year of their own agenda, after today.
    const now = new Date()
    const from = addLocalDays(now.toISOString().slice(0, 10), 1)
    const agenda = await applicationFetch<AgendaPayload>('/api/account/agenda', { query: { from, to: addLocalDays(from, 364), kinds: 'reservation,booking,stay' }, validate: isAgenda })
    return { business: null, visits: agenda.items.filter(item => item.dayKey > localDateAt(now, item.timeZone)).map(item => agendaToTodayCard(item, { resolvedAt: now.toISOString() })) }
  },
)
const business = computed(() => data.value?.business ?? null)
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
const taskBusy = ref<Record<string, 'assign' | 'complete'>>({})
const opportunityBusy = ref<Record<string, 'accept' | 'later'>>({})
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
const complete = (task: TaskView) => act(taskBusy, task.id, 'complete', () => applicationFetch(`${tasksApi.value}/tasks/${encodeURIComponent(task.id)}/complete`, { method: 'POST', validate: isTaskResult, body: {} }))
const assign = (task: TaskView, person: TaskPerson | null) => act(taskBusy, task.id, 'assign', () => applicationFetch(`${tasksApi.value}/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', validate: isTaskResult,
  body: { expectedVersion: task.version, assignedMemberId: person?.type === 'member' ? person.id : null, assignedTeamId: person?.type === 'team' ? person.id : null } }))
const isOpportunityResult = (value: unknown): value is { opportunity: { id: string } } => isRecord(value) && isRecord(value.opportunity) && typeof value.opportunity.id === 'string'
const accept = (opportunity: OpportunityView) => act(opportunityBusy, opportunity.id, 'accept', () => applicationFetch(`${tasksApi.value}/opportunities/${encodeURIComponent(opportunity.id)}/accept`, { method: 'POST', validate: isTaskResult, body: {} }))
const dismiss = (opportunity: OpportunityView) => act(opportunityBusy, opportunity.id, 'later', () => applicationFetch(`${tasksApi.value}/opportunities/${encodeURIComponent(opportunity.id)}/dismiss`, { method: 'POST', validate: isOpportunityResult, body: {} }))
const defer = (opportunity: OpportunityView, until: string) => act(opportunityBusy, opportunity.id, 'later', () => applicationFetch(`${tasksApi.value}/opportunities/${encodeURIComponent(opportunity.id)}/defer`, { method: 'POST', validate: isOpportunityResult, body: { until } }))

// Business goals steer which opportunities the selector finds.
const isProgress = (value: unknown): value is { goals: BusinessGoal[] } => isRecord(value) && Array.isArray(value.goals)
const { data: progress, refresh: refreshGoals } = await useAsyncData(() => `today-goals-${orgSlug.value}`,
  async () => canManage.value ? (await applicationFetch<{ goals: BusinessGoal[] }>(`${tasksApi.value}/progress`, { query: { limit: 1 }, validate: isProgress })).goals : [],
  { watch: [canManage] })
const goals = computed(() => (progress.value ?? []).filter(goal => goal.status === 'active'))
const goalDraft = ref('')
const strategyChannels: Array<{ value: BusinessGoalStrategy['channels'][number]; label: string }> = [
  { value: 'blog', label: 'Blog articles' }, { value: 'social', label: 'Social posts' }, { value: 'google_ads', label: 'Google Ads' },
]
const goalChannels = ref<BusinessGoalStrategy['channels']>([])
const goalPayments = ref(false)
const goalAvailability = ref(false)
const goalBusy = ref<string | null>(null)
const goalRequest = ref<{ signature: string; idempotencyKey: string } | null>(null)
const isSavedGoal = (value: unknown): value is { goal: BusinessGoal } => isRecord(value) && isRecord(value.goal) && typeof value.goal.id === 'string'
async function changeGoals(busy: string, request: () => Promise<unknown>): Promise<boolean> {
  goalBusy.value = busy
  actionError.value = null
  try {
    await request()
  } catch (cause) {
    actionError.value = cause
    return false
  } finally {
    goalBusy.value = null
  }
  await Promise.all([refreshGoals(), refresh()])
  return true
}
async function addGoal() {
  const intent = goalDraft.value.trim()
  if (!intent) return
  const strategy: BusinessGoalStrategy | null = goalChannels.value.length || goalPayments.value || goalAvailability.value
    ? { channels: [...goalChannels.value], payments: goalPayments.value, availability: goalAvailability.value } : null
  const signature = JSON.stringify({ intent, strategy })
  if (goalRequest.value?.signature !== signature) goalRequest.value = { signature, idempotencyKey: crypto.randomUUID() }
  if (await changeGoals('new', () => applicationFetch(`${tasksApi.value}/goals`, { method: 'POST', validate: isSavedGoal, body: { idempotencyKey: goalRequest.value!.idempotencyKey, intent, strategy } }))) {
    goalRequest.value = null
    goalDraft.value = ''
    goalChannels.value = []
    goalPayments.value = false
    goalAvailability.value = false
  }
}
function toggleChannel(channel: BusinessGoalStrategy['channels'][number], selected: boolean) {
  goalChannels.value = selected ? [...new Set([...goalChannels.value, channel])] : goalChannels.value.filter(value => value !== channel)
}
function strategyDescription(strategy: BusinessGoalStrategy): string {
  return [...strategyChannels.filter(channel => strategy.channels.includes(channel.value)).map(channel => channel.label),
    ...(strategy.payments ? ['Accept payments'] : []), ...(strategy.availability ? ['Booking availability'] : [])].join(' · ')
}
async function removeGoal(goal: BusinessGoal) {
  await changeGoals(goal.id, () => applicationFetch(`${tasksApi.value}/goals/${encodeURIComponent(goal.id)}`, { method: 'PATCH', validate: isSavedGoal, body: { revision: goal.revision, status: 'archived' } }))
}

watch(realtime.event, (event) => {
  if (!event) return
  if (['business.changed', 'stay.changed', 'access.changed', 'thread.created', 'thread.changed', 'entry.appended', 'delivery.changed'].includes(event.type)) void refresh()
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
.quest-tab { height: 40px; padding: 0 18px; border-radius: 9999px; font-size: 14px; font-weight: 500; box-shadow: inset 0 0 0 1px var(--ui-border); color: var(--ui-text-highlighted); }
.quest-tab[aria-selected="true"] { background: var(--ui-bg-inverted); color: var(--ui-text-inverted); box-shadow: none; }
.quest-tab:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: 4px; }
</style>
