<template>
  <DashboardIndexPanel
    :id="personalScope ? 'account-today' : 'org-today'"
    title="Today"
    column="wide"
  >
    <template #right>
      <!-- An account has one agenda and nothing to narrow it by. -->
      <AgendaFilters v-if="!personalScope" :locations="todayData?.locations ?? []" :kinds="todayData?.availableKinds ?? []" :organization-id="schedulingOrganizationId" />
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

      <h2 class="text-base font-semibold text-highlighted">
        {{ heading }}
      </h2>

      <div v-if="visibleItems.length" class="mt-6 space-y-4">
        <TodayAgendaCard
          v-for="item in visibleItems"
          :key="item.id"
          :item="item"
          :surface="activeRange"
        />
      </div>

      <div v-else-if="!activeLoading && !activeError && !hasMore" class="py-24 text-center">
        <img
          src="https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/0b7e08d0-6b7d-471b-2957-9845392cc200/w=224"
          alt=""
          aria-hidden="true"
          width="112"
          height="112"
          class="mx-auto size-28 object-contain"
        >
        <p class="mt-6 text-base font-semibold text-highlighted">{{ emptyTitle }}</p>
        <p class="mt-1 text-sm text-muted">{{ emptyDescription }}</p>
      </div>

      <div
        v-if="hasMore"
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
import { bookingCountLabel, resolveAggregateBookingPresentation } from '~/utils/booking-presentation'
import { getErrorMessage } from '~/utils/errors'
import { agendaToTodayCard, todayFeedSchema, type TodayCard, type TodayFeedPayload } from '~/shared/dashboard-today'
import type { AgendaItem, AgendaPayload } from '~/server/utils/dashboard-agenda'
import { useDashboardTelemetry } from '~/composables/useDashboardTelemetry'

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
const organizationId = props.personalScope ? null : await useDashboardOrganizationId()
const { organization } = useDashboardOrganization()
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
const allRangeItems = computed(() => activeRange.value === 'today' ? todayCards.value : upcomingItems.value)
const visibleItems = computed(() => (activeRange.value === 'today' ? todayCards.value.slice(0, todayVisibleCount.value) : upcomingItems.value).map(cardWithContext))
const hasMore = computed(() => activeRange.value === 'today'
  ? todayVisibleCount.value < todayCards.value.length
  : upcomingCursor.value !== null && upcomingHorizon.value !== null && upcomingCursor.value <= upcomingHorizon.value)
const activeLoading = computed(() => activeRange.value === 'today' ? pending.value : upcomingLoading.value)
const activeError = computed(() => navigationError.value ?? todayError.value ?? (activeRange.value === 'upcoming' ? upcomingError.value : null))
const activeLabel = computed(() => activeRange.value === 'today' ? 'Today' : 'Upcoming')
const attentionCount = computed(() => todayCards.value.filter(card => card.priority === 'attention').length)
const personalPresentation = resolveAggregateBookingPresentation([])
const heading = computed(() => {
  if (props.personalScope) return `You have ${bookingCountLabel(personalPresentation, new Set(allRangeItems.value.map(item => item.stayId ?? item.id)).size)}`
  if (activeRange.value === 'upcoming') return 'Your upcoming schedule'
  return attentionCount.value ? `You have ${attentionCount.value} ${attentionCount.value === 1 ? 'thing' : 'things'} to do` : 'Your day at a glance'
})
const emptyTitle = computed(() => activeRange.value === 'today'
  ? props.personalScope ? 'No bookings today' : 'Nothing needs your attention today'
  : props.personalScope ? 'No upcoming bookings' : 'Nothing upcoming')
const emptyDescription = computed(() => hasActiveFilters.value && !props.personalScope
  ? 'Try adjusting the filters.'
  : activeRange.value === 'today' ? 'Your scheduled activity and outstanding work will appear here.' : 'Future scheduled activity will appear here.')

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
    && nullableString(item.locationId) && nullableString(item.assignedMemberId)
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
      upcomingItems.value.push(...additions)
      upcomingItems.value.sort((left, right) => (left.occurrenceAt ?? '').localeCompare(right.occurrenceAt ?? '') || left.id.localeCompare(right.id))
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
  resetUpcoming()
  if (activeRange.value === 'upcoming') await loadUpcoming()
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
    || event?.type === 'stay.changed' || event?.type === 'nights.changed') void refreshAgenda()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refreshAgenda() })

const loadMoreSentinel = ref<HTMLElement | null>(null)
let loadMoreObserver: IntersectionObserver | null = null
onMounted(() => {
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
  loadMoreObserver?.disconnect()
})
</script>
