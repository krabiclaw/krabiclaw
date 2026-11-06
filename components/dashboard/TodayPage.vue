<template>
  <DashboardIndexPanel
    :id="personalScope ? 'account-today' : 'org-today'"
    title="Today"
  >
    <template #right>
      <!-- An account has one agenda and nothing to narrow it by. -->
      <AgendaFilters v-if="!personalScope" :locations="todayData?.locations ?? []" :kinds="todayData?.availableKinds ?? []" :organization-id="schedulingOrganizationId" />
      <UButton v-if="canAddStay" :to="`/dashboard/${encodeURIComponent(orgSlug)}/bookings/stay/new`" icon="i-lucide-plus" color="neutral" variant="ghost" aria-label="Add stay" />
    </template>

    <div>
      <DashboardFilterPills
        id="today-range"
        v-model="rangeModel"
        label="Agenda view"
        :items="ranges"
        role="tablist"
        class="mb-8"
      />

      <UAlert
        v-if="activeError"
        class="mb-6"
        color="error"
        variant="soft"
        :title="`${activeLabel} could not be loaded`"
        :description="getErrorMessage(activeError, `${activeLabel} request failed`)"
      >
        <template #actions>
          <UButton color="error" variant="soft" size="xs" @click="refreshAgenda">Retry</UButton>
        </template>
      </UAlert>

      <UAlert v-if="decisionError" class="mb-6" color="error" variant="soft" title="Your choice was not saved" :description="getErrorMessage(decisionError, 'The request failed')" />

      <ul v-if="visibleItems.length && !activeError" class="space-y-4" role="list" data-testid="today-list">
        <li v-for="item in visibleItems" :key="item.id">
          <TodayAgendaCard :item="item" :surface="activeRange" :on-decide="decide" />
        </li>
      </ul>

      <p v-if="!visibleItems.length && !activeLoading && !activeError && !hasMore" class="text-sm text-muted">{{ emptyTitle }}</p>

      <div v-if="!personalScope && activeRange === 'today' && !activeError && priorities" class="mt-8" role="group" aria-label="Your priority" data-testid="today-priorities">
        <ul v-if="priorities.length" class="mb-4 space-y-2">
          <li v-for="goal in priorities" :key="goal.id" class="flex items-start justify-between gap-3 rounded-lg bg-elevated/50 px-3 py-2" data-testid="today-priority">
            <span class="min-w-0 text-sm text-highlighted">{{ goal.intent }}</span>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Remove priority: ${goal.intent}`" :loading="priorityBusy === goal.id" :disabled="priorityBusy !== null" @click="removePriority(goal)" />
          </li>
        </ul>
        <form class="flex gap-2" @submit.prevent="addPriority">
          <UInput v-model="priorityDraft" class="flex-1" :maxlength="2000" required placeholder="What should the business focus on now?" aria-label="New priority" />
          <UButton type="submit" color="neutral" variant="soft" label="Add" :loading="priorityBusy === 'new'" :disabled="priorityBusy !== null || !priorityDraft.trim()" />
        </form>
      </div>

      <div
        v-if="(hasMore || activeLoading) && !activeError"
        :key="`${activeRange}-${filterSignature}`"
        ref="loadMoreSentinel"
        class="flex min-h-24 items-center justify-center"
        aria-live="polite"
      >
        <UIcon v-if="activeLoading" name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
        <UButton v-else color="neutral" variant="soft" label="Load more" @click="loadMore" />
      </div>

    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { localDateAt } from '~/utils/timezone'
import AgendaFilters from './AgendaFilters.vue'
import TodayAgendaCard from './TodayAgendaCard.vue'
import { getErrorMessage } from '~/utils/errors'
import { agendaToTodayCard, todayFeedSchema, type TodayCard, type TodayDecisionInput, type TodayFeedPayload, type TodayPriority } from '~/shared/dashboard-today'
import type { AgendaItem, AgendaPayload } from '~/server/utils/dashboard-agenda'
import { useDashboardTelemetry } from '~/composables/useDashboardTelemetry'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'

useSeoMeta({ title: 'Today | KrabiClaw', robots: 'noindex, nofollow' })

const props = defineProps<{ personalScope?: boolean }>()
type TodayRange = 'today' | 'upcoming'
const PAGE_SIZE = 12
const UPCOMING_WINDOW_DAYS = 30
const UPCOMING_HORIZON_DAYS = 365
const ranges: Array<{ label: string; value: TodayRange }> = [
  { label: 'Today', value: 'today' },
  { label: 'Upcoming', value: 'upcoming' },
]

const route = useRoute()
const router = useRouter()
const telemetry = useDashboardTelemetry()
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const apiBase = props.personalScope ? '/api/account' : '/api/dashboard'
const realtime = useDashboardInvalidations()
const orgSlug = computed(() => props.personalScope ? 'account' : String(route.params.orgSlug ?? ''))
const { signature: filterSignature, active: hasActiveFilters, query: filterQuery, range: activeRange, failure: navigationError } = useAgendaFilters()
const organizationId = props.personalScope ? null : useDashboardOrganizationId()
const { organization, hasFeature } = useDashboardOrganization()
const canAddStay = computed(() => {
  const role = organization.value?.role as keyof typeof organizationRoles | undefined
  return !props.personalScope && hasFeature('stays') && Boolean(role && authClient.organization.checkRolePermission({ role, permissions: { operations: ['update'] } }))
})
const schedulingOrganizationId = computed(() => organization.value?.vertical === 'lodging' ? null : organizationId)
const todayKey = computed(() => `dashboard-today-${orgSlug.value}-${props.personalScope ? '' : filterSignature.value}`)
const isTodayFeed = (value: unknown): value is TodayFeedPayload => todayFeedSchema.safeParse(value).success
const { data: todayData, pending, error: todayError, refresh: refreshToday } = await useAsyncData<TodayFeedPayload>(
  todayKey,
  () => dashboardApi<TodayFeedPayload>(`${apiBase}/today`, {
    query: props.personalScope ? undefined : filterQuery.value,
    validate: isTodayFeed,
  }),
)

const rangeModel = computed<string>({
  get: () => activeRange.value,
  set: value => {
    const next = value === 'upcoming' ? 'upcoming' : 'today'
    if (next !== activeRange.value) {
      activeRange.value = next
      if (!props.personalScope) {
        telemetry.track({
          action: 'today_range_switch',
          surface: 'today',
          range: next,
          locationId: typeof route.query.locationId === 'string' ? route.query.locationId : undefined,
        })
      }
    }
  },
})
const todayVisibleCount = ref(PAGE_SIZE)
const upcomingItems = ref<TodayCard[]>([])
const upcomingLoading = ref(false)
const upcomingError = ref<unknown>(null)
const upcomingCursor = ref<string | null>(null)
let upcomingEpoch = 0
const resolvedAt = computed(() => todayData.value?.resolvedAt ?? null)
const upcomingHorizon = computed(() => resolvedAt.value ? addDays(resolvedAt.value.slice(0, 10), UPCOMING_HORIZON_DAYS + 1) : null)
const todayCards = computed(() => todayData.value?.cards ?? [])
const priorities = computed(() => props.personalScope ? null : todayData.value?.priorities ?? null)
const priorityDraft = ref('')
const priorityBusy = ref<string | null>(null)
const decisionError = ref<unknown>(null)
const visibleItems = computed(() => (activeRange.value === 'today' ? todayCards.value.slice(0, todayVisibleCount.value) : upcomingItems.value).map(cardWithContext))
const hasMore = computed(() => activeRange.value === 'today'
  ? todayVisibleCount.value < todayCards.value.length
  : upcomingCursor.value !== null && upcomingHorizon.value !== null && upcomingCursor.value <= upcomingHorizon.value)
const activeLoading = computed(() => activeRange.value === 'today' ? pending.value : upcomingLoading.value)
const activeError = computed(() => navigationError.value ?? todayError.value ?? (activeRange.value === 'upcoming' ? upcomingError.value : null))
const activeLabel = computed(() => activeRange.value === 'today' ? 'Today' : 'Upcoming')
const emptyTitle = computed(() => hasActiveFilters.value && !props.personalScope ? 'No items match these filters.' : activeRange.value === 'today'
  ? props.personalScope ? 'No bookings today' : 'Nothing for today'
  : props.personalScope ? 'No upcoming bookings' : 'Nothing upcoming')

function resetUpcoming() {
  upcomingEpoch += 1
  upcomingItems.value = []
  upcomingLoading.value = false
  upcomingError.value = null
  upcomingCursor.value = resolvedAt.value ? addDays(resolvedAt.value.slice(0, 10), -1) : null
}

function cardWithContext(card: TodayCard): TodayCard {
  if (card.priority !== 'schedule' && card.bookingKind === null) return card
  const target = router.resolve(card.to)
  const query = {
    range: activeRange.value === 'upcoming' ? 'upcoming' : undefined,
    locationId: route.query.locationId,
    kinds: route.query.kinds,
    assigned_member_id: route.query.assigned_member_id,
    ...target.query,
  }
  return { ...card, to: router.resolve({ path: target.path, query, hash: target.hash }).fullPath }
}

function isPersonalAgenda(value: unknown): value is AgendaPayload {
  const nullableString = (field: unknown) => field === null || typeof field === 'string'
  return isRecord(value) && Array.isArray(value.items) && value.items.every((item): item is AgendaItem =>
    isRecord(item) && typeof item.id === 'string' && (item.kind === 'reservation' || item.kind === 'booking' || item.kind === 'stay')
    && typeof item.startsAt === 'string' && typeof item.dayKey === 'string' && typeof item.timeZone === 'string'
    && typeof item.title === 'string' && typeof item.to === 'string'
    && nullableString(item.subtitle) && nullableString(item.locationTitle)
    && nullableString(item.guestImageUrl) && nullableString(item.resourceImageUrl) && nullableString(item.resourceTitle)
    && nullableString(item.locationId) && nullableString(item.assignedMemberId) && nullableString(item.productId) && nullableString(item.stayChannel)
    && (item.partySize === null || typeof item.partySize === 'number'))
}

async function loadUpcoming() {
  if (upcomingLoading.value || !hasMore.value || !resolvedAt.value || !upcomingHorizon.value) return
  const epoch = upcomingEpoch
  const reference = resolvedAt.value
  const horizon = upcomingHorizon.value
  upcomingLoading.value = true
  upcomingError.value = null
  try {
    while (upcomingCursor.value && upcomingCursor.value <= horizon && epoch === upcomingEpoch) {
      const from = upcomingCursor.value
      const to = minDate(addDays(from, UPCOMING_WINDOW_DAYS - 1), horizon)
      let cards: TodayCard[]
      if (props.personalScope) {
        const payload = await dashboardApi<AgendaPayload>(`${apiBase}/agenda`, { query: { from, to, kinds: 'reservation,booking,stay' }, validate: isPersonalAgenda })
        cards = payload.items.filter(item => item.dayKey > localDateAt(new Date(reference), item.timeZone))
          .map(item => agendaToTodayCard(item, { resolvedAt: reference, personal: true }))
      } else {
        const payload = await dashboardApi<TodayFeedPayload>(`${apiBase}/today`, {
          query: { ...filterQuery.value, range: 'upcoming', from, to }, validate: isTodayFeed,
        })
        cards = payload.cards
      }
      if (epoch !== upcomingEpoch) return
      const existing = new Set(upcomingItems.value.map(item => item.id))
      const additions = cards.filter(item => !existing.has(item.id))
      // Each window arrives in the server's order and windows arrive in date order.
      upcomingItems.value.push(...additions)
      upcomingCursor.value = addDays(to, 1)
      if (additions.length) break
    }
  } catch (cause) {
    if (epoch === upcomingEpoch) upcomingError.value = cause
  } finally {
    if (epoch === upcomingEpoch) upcomingLoading.value = false
  }
}

async function loadMore() {
  if (activeLoading.value || !hasMore.value || activeError.value) return
  if (activeRange.value === 'today') todayVisibleCount.value += PAGE_SIZE
  else await loadUpcoming()
}

async function refreshAgenda() {
  await refreshToday()
}

const organizationApi = computed(() => `/api/organizations/${encodeURIComponent(organizationId ?? '')}`)
const isSavedGoal = (value: unknown): value is { goal: TodayPriority } => isRecord(value) && isRecord(value.goal) && typeof value.goal.id === 'string' && typeof value.goal.revision === 'string'
const isSavedFeedback = (value: unknown): value is { feedback: { id: string; decision: string } } => isRecord(value) && isRecord(value.feedback) && typeof value.feedback.id === 'string' && typeof value.feedback.decision === 'string'

/** Saves one decision against the evidence the card was suggested on, then reads Today again. */
async function decide(item: TodayCard, input: TodayDecisionInput) {
  if (!item.decision) throw new Error(`Card ${item.id} has no decision to record`)
  decisionError.value = null
  const { operation, subjectId, evidenceRevision, goalId, goalRevision, revision } = item.decision
  try {
    await applicationFetch(`${organizationApi.value}/recommendation-feedback`, { method: 'PUT', validate: isSavedFeedback, body: {
      operation, subjectId, evidenceRevision, decision: input.decision, note: input.note, deferUntil: input.deferUntil, revision,
      ...(goalId && goalRevision ? { goalId, goalRevision } : {}),
    } })
  } catch (cause) {
    decisionError.value = cause
    return false
  }
  await refreshToday()
  return true
}

async function changePriorities(busy: string, request: () => Promise<unknown>) {
  priorityBusy.value = busy
  decisionError.value = null
  try {
    await request()
  } catch (cause) {
    decisionError.value = cause
    return
  } finally {
    priorityBusy.value = null
  }
  await refreshToday()
}

async function addPriority() {
  const intent = priorityDraft.value.trim()
  if (!intent) return
  await changePriorities('new', () => applicationFetch(`${organizationApi.value}/goals`, { method: 'POST', validate: isSavedGoal, body: { idempotencyKey: crypto.randomUUID(), intent } }))
  if (!decisionError.value) priorityDraft.value = ''
}

async function removePriority(goal: TodayPriority) {
  await changePriorities(goal.id, () => applicationFetch(`${organizationApi.value}/goals/${encodeURIComponent(goal.id)}`, { method: 'PATCH', validate: isSavedGoal, body: { revision: goal.revision, status: 'archived' } }))
}
function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
function minDate(left: string, right: string): string { return left < right ? left : right }

resetUpcoming()
// Nuxt carries the previous async-data value into a new reactive key while
// fetching. A card for the previous scope must never remain actionable.
watch(todayKey, () => { todayData.value = undefined }, { flush: 'sync' })
watch(activeRange, async range => {
  if (range === 'upcoming' && !upcomingItems.value.length) await loadUpcoming()
})
watch(filterSignature, (newSig, oldSig) => {
  todayVisibleCount.value = PAGE_SIZE
  resetUpcoming()
  upcomingCursor.value = null
  if (!props.personalScope && oldSig !== undefined && newSig !== oldSig) {
    telemetry.track({
      action: 'today_filter_change',
      surface: activeRange.value,
      range: activeRange.value,
      locationId: typeof route.query.locationId === 'string' ? route.query.locationId : undefined,
      metadata: {
        filterSignature: newSig,
      },
    })
  }
}, { flush: 'sync' })
watch(todayData, async (data) => {
  const loadedThrough = upcomingItems.value.length ? upcomingCursor.value : null
  resetUpcoming()
  if (activeRange.value === 'upcoming') {
    const epoch = upcomingEpoch
    do { await loadUpcoming() }
    while (epoch === upcomingEpoch && loadedThrough && upcomingCursor.value && upcomingCursor.value < loadedThrough && hasMore.value && !upcomingError.value)
  }
  if (!props.personalScope && data) {
    telemetry.track({
      action: 'today_view',
      surface: activeRange.value,
      range: activeRange.value,
      locationId: typeof route.query.locationId === 'string' ? route.query.locationId : undefined,
      metadata: {
        totalCards: data.cards.length,
        attentionCount: data.cards.filter(c => c.priority === 'attention').length,
        scheduledCount: data.cards.filter(c => c.priority === 'schedule').length,
      },
    })
  }
}, { flush: 'post' })
watch(realtime.event, event => {
  if (event?.type === 'thread.created' || event?.type === 'thread.changed' || event?.type === 'notification.created'
    || event?.type === 'entry.appended' || event?.type === 'delivery.changed' || event?.type === 'access.changed'
    || event?.type === 'stay.changed' || event?.type === 'nights.changed') void refreshAgenda()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refreshAgenda() })

const loadMoreSentinel = ref<HTMLElement | null>(null)
let loadMoreObserver: IntersectionObserver | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  if (document.visibilityState !== 'visible') return
  // Re-read at the next known due instant, including later today, and at least
  // once a minute for midnight/eligibility changes that have no write event.
  const now = Date.now()
  const next = [...todayCards.value, ...upcomingItems.value]
    .flatMap(card => [card.actionAt, card.occurrenceAt])
    .filter((at): at is string => at !== null && Date.parse(at) > now)
    .reduce((soonest, at) => Math.min(soonest, Date.parse(at)), now + 60_000)
  refreshTimer = setTimeout(() => { void refreshAgenda() }, Math.max(1000, next - now + 100))
}
function resumeAgenda() {
  if (document.visibilityState === 'visible') void refreshAgenda()
  else if (refreshTimer) clearTimeout(refreshTimer)
}
watch([todayData, upcomingItems], () => {
  if (import.meta.client) scheduleRefresh()
}, { flush: 'post', deep: true })
onMounted(() => {
  window.addEventListener('focus', resumeAgenda)
  document.addEventListener('visibilitychange', resumeAgenda)
  scheduleRefresh()
  if (activeRange.value === 'upcoming') void loadUpcoming()
  if (!('IntersectionObserver' in window)) return
  loadMoreObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void loadMore()
  }, { rootMargin: '320px 0px' })
  if (loadMoreSentinel.value) loadMoreObserver.observe(loadMoreSentinel.value)
})
watch(loadMoreSentinel, (element, previous) => {
  if (previous) loadMoreObserver?.unobserve(previous)
  if (element) loadMoreObserver?.observe(element)
}, { flush: 'post' })
onBeforeUnmount(() => {
  upcomingEpoch += 1
  if (refreshTimer) clearTimeout(refreshTimer)
  window.removeEventListener('focus', resumeAgenda)
  document.removeEventListener('visibilitychange', resumeAgenda)
  loadMoreObserver?.disconnect()
})
</script>
