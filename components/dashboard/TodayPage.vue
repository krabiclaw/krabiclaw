<template>
  <DashboardIndexPanel
    :id="personalScope ? 'account-today' : 'org-today'"
    title="Today"
    column="wide"
    :navbar-ui="{ title: 'sr-only', center: 'flex flex-1 items-center justify-center' }"
  >
    <!--
      The title is announced but not drawn: the pills say which range is on
      screen, and a "Today" heading beside a "Today" pill reads as two
      different controls.
    -->
    <template #center>
        <div class="flex items-center gap-2">
          <UTabs
            v-model="rangeModel"
            :items="ranges"
            :content="false"
            size="xl"
            aria-label="Booking range"
          />
  
          <!-- An account has one agenda and nothing to narrow it by. -->
          <AgendaFilters v-if="!personalScope" :locations="todayData?.locations ?? []" :kinds="todayData?.availableKinds ?? []" :organization-id="organizationId" />
        </div>
    </template>

    <div class="pb-24">
      <UAlert
        v-if="realtime.status.value === 'failed'"
        class="mb-6"
        color="warning"
        variant="soft"
        icon="i-lucide-wifi-off"
        title="Today's schedule may be out of date"
        description="The live dashboard connection is unavailable."
      >
        <template #actions>
          <UButton color="warning" variant="soft" size="xs" @click="retryRealtime">Refresh</UButton>
        </template>
      </UAlert>
      <UAlert
        v-if="activeError"
        class="mb-6"
        color="error"
        variant="soft"
        :title="`${activeLabel} could not be loaded`"
        :description="getErrorMessage(activeError, `${activeLabel} request failed`)"
      />

      <h1 class="text-center text-2xl font-semibold text-highlighted">
        {{ heading }}
      </h1>

      <div v-if="visibleItems.length" class="mt-6 space-y-4">
        <TodayAgendaCard
          v-for="item in visibleItems"
          :key="item.id"
          :item="item"
          :reference-day="referenceDay(item)"
          :personal="personalScope"
        />
      </div>

      <div v-else-if="!activeLoading && !activeError" class="py-24 text-center">
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
        <span v-else class="sr-only">Scroll to load more</span>
      </div>

      <!--
        Triage is a band, not a badge on every row. Marking each card with its
        status makes the operator read all of them to find the one waiting on
        a reply; naming the count once, pinned, does not. It stays out of the
        list so the cards keep the single shape they were redesigned for.
      -->
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { localDateAt } from '~/utils/timezone'
import AgendaFilters from './AgendaFilters.vue'
import TodayAgendaCard from './TodayAgendaCard.vue'
import { bookingCountLabel, resolveAggregateBookingPresentation, type BookingKind } from '~/utils/booking-presentation'
import { getErrorMessage } from '~/utils/errors'
import type { AgendaItem, AgendaKind, AgendaLocation, AgendaPayload, TodayAgendaPayload } from '~/server/utils/dashboard-agenda'

useSeoMeta({ title: 'Today | Krabiclaw', robots: 'noindex, nofollow' })

// One screen for both readers: the business sees who is arriving, the account
// sees where it is going. Personal scope reads the account agenda and nothing
// else changes.
const props = defineProps<{ personalScope?: boolean }>()

type TodayRange = 'today' | 'upcoming'

const PAGE_SIZE = 12
const UPCOMING_WINDOW_DAYS = 30
const UPCOMING_HORIZON_DAYS = 365
const BOOKING_KINDS: AgendaKind[] = ['reservation', 'booking']

const ranges: Array<{ label: string; value: TodayRange }> = [
  { label: 'Today', value: 'today' },
  { label: 'Upcoming', value: 'upcoming' },
]

const route = useRoute()
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const apiBase = props.personalScope ? '/api/account' : '/api/dashboard'
const dashboardOrganization = useDashboardOrganization()
const realtime = useDashboardInvalidations()
const orgSlug = computed(() => props.personalScope ? 'account' : String(route.params.orgSlug ?? ''))
const todayKey = computed(() => `dashboard-today-${orgSlug.value}`)
const { filters, signature: filterSignature, active: hasActiveFilters } = useAgendaFilters()
const organizationId = props.personalScope ? null : await useDashboardOrganizationId()

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isAgendaItem = (value: unknown): value is AgendaItem =>
  isRecord(value)
  && typeof value.id === 'string'
  && BOOKING_KINDS.includes(value.kind as AgendaKind)
  && typeof value.startsAt === 'string'
  && typeof value.dayKey === 'string'
  && typeof value.timeZone === 'string'
  && typeof value.title === 'string'
  && typeof value.status === 'string'
  && isNullableString(value.guestImageUrl)
  && isNullableString(value.resourceImageUrl)
  && isNullableString(value.resourceTitle)
  && (value.partySize === null || typeof value.partySize === 'number')
  && typeof value.to === 'string'

const isLocation = (value: unknown): value is AgendaLocation =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.title === 'string'

const isTodayResponse = (value: unknown): value is TodayAgendaPayload =>
  isRecord(value)
  && Array.isArray(value.items)
  && value.items.every(isAgendaItem)
  && Array.isArray(value.availableKinds)
  && Array.isArray(value.locations)
  && value.locations.every(isLocation)
  && typeof value.resolvedAt === 'string'

const isAgendaPayload = (value: unknown): value is AgendaPayload =>
  isRecord(value)
  && Array.isArray(value.items)
  && value.items.every(isAgendaItem)
  && Array.isArray(value.availableKinds)
  && Array.isArray(value.locations)
  && value.locations.every(isLocation)

const { data: todayData, pending, error: todayError, refresh: refreshToday } = await useAsyncData<TodayAgendaPayload>(
  todayKey,
  () => dashboardApi<TodayAgendaPayload>(`${apiBase}/today`, { validate: isTodayResponse }),
)

const activeRange = ref<TodayRange>('today')
// UTabs models `string | number`; the setter is where Upcoming is loaded on
// first selection, so switching range stays one code path.
const rangeModel = computed<string | number>({
  get: () => activeRange.value,
  set: value => void selectRange(value === 'upcoming' ? 'upcoming' : 'today'),
})
const todayVisibleCount = ref(PAGE_SIZE)
const upcomingItems = ref<AgendaItem[]>([])
const upcomingLoading = ref(false)
const upcomingError = ref<unknown>(null)
const resolvedAt = computed(() => todayData.value?.resolvedAt ?? new Date().toISOString())
const resolvedUtcDay = computed(() => resolvedAt.value.slice(0, 10))
// One organization can span time zones. Query one day on either side of the
// UTC range, then classify each item against its own location's local day.
const upcomingCursor = ref(addDays(resolvedUtcDay.value, -1))
const upcomingHorizon = computed(() => addDays(resolvedUtcDay.value, UPCOMING_HORIZON_DAYS + 1))

const filteredTodayItems = computed(() => (todayData.value?.items ?? []).filter(item =>
  (filters.locationId === AGENDA_FILTER_ALL || item.locationId === filters.locationId)
  && (filters.kind === AGENDA_FILTER_ALL || item.kind === filters.kind)
  && (filters.assignedMemberId === AGENDA_FILTER_ALL || item.assignedMemberId === filters.assignedMemberId)))
const allRangeItems = computed(() => activeRange.value === 'today' ? filteredTodayItems.value : upcomingItems.value)
const rangeItems = computed(() => activeRange.value === 'today'
  ? filteredTodayItems.value.slice(0, todayVisibleCount.value)
  : upcomingItems.value)
const visibleItems = computed(() => rangeItems.value)
const hasMore = computed(() => activeRange.value === 'today'
  ? todayVisibleCount.value < filteredTodayItems.value.length
  : upcomingCursor.value <= upcomingHorizon.value)
const activeLoading = computed(() => activeRange.value === 'today' ? pending.value : upcomingLoading.value)
const activeError = computed(() => activeRange.value === 'today' ? todayError.value : upcomingError.value)
const activeLabel = computed(() => activeRange.value === 'today' ? 'Today' : 'Upcoming')
// Derived from the organization and kinds in scope rather than from the loaded items,
// so the heading reads the same before anything has arrived and does not change
// noun as a page of Upcoming loads. The vertical is the organization's own,
// which the layout has loaded before this page renders.
// An account's visits span sites, so their one shared word is "booking".
const presentation = computed(() => {
  const vertical = dashboardOrganization.organization.value?.vertical
  const scoped: AgendaKind[] = filters.kind === AGENDA_FILTER_ALL
    ? todayData.value?.availableKinds ?? BOOKING_KINDS
    : [filters.kind as AgendaKind]
  const kinds = scoped.filter(isBookingKind)
  return resolveAggregateBookingPresentation(
    props.personalScope ? [] : kinds.map(kind => ({ kind, vertical })),
  )
})
const heading = computed(() => {
  const count = allRangeItems.value.length
  return `You have ${bookingCountLabel(presentation.value, count)}`
})
const emptyTitle = computed(() => activeRange.value === 'today'
  ? `No ${presentation.value.nounPlural} today`
  : `No upcoming ${presentation.value.nounPlural}`)
const emptyDescription = computed(() => hasActiveFilters.value
  ? 'Try adjusting the filters.'
  : activeRange.value === 'today'
    ? 'There are no arrivals scheduled for today.'
    : 'New arrivals will appear here as they are booked.')


async function selectRange(range: TodayRange) {
  activeRange.value = range
  if (range === 'upcoming' && upcomingItems.value.length === 0 && !upcomingLoading.value) {
    await loadUpcoming()
  }
}

async function loadMore() {
  if (activeLoading.value || !hasMore.value) return
  if (activeRange.value === 'today') {
    todayVisibleCount.value += PAGE_SIZE
    return
  }
  await loadUpcoming()
}

async function loadUpcoming() {
  if (upcomingLoading.value || upcomingCursor.value > upcomingHorizon.value) return
  upcomingLoading.value = true
  upcomingError.value = null
  const requestSignature = filterSignature.value
  try {
    while (upcomingCursor.value <= upcomingHorizon.value && requestSignature === filterSignature.value) {
      const from = upcomingCursor.value
      const to = minDate(addDays(from, UPCOMING_WINDOW_DAYS - 1), upcomingHorizon.value)
      const payload = await dashboardApi<AgendaPayload>(`${apiBase}/agenda`, {
        query: {
          from,
          to,
          locationId: filters.locationId !== AGENDA_FILTER_ALL ? filters.locationId : undefined,
          assigned_member_id: filters.assignedMemberId !== AGENDA_FILTER_ALL ? filters.assignedMemberId : undefined,
          kinds: filters.kind !== AGENDA_FILTER_ALL ? filters.kind : 'reservation, booking',
        },
        validate: isAgendaPayload,
      })
      if (requestSignature !== filterSignature.value) return
      const existing = new Set(upcomingItems.value.map(item => item.id))
      const additions = payload.items.filter(item => isUpcoming(item) && !existing.has(item.id))
      upcomingItems.value.push(...additions)
      upcomingItems.value.sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id))
      upcomingCursor.value = addDays(to, 1)
      if (additions.length) break
    }
  } catch (error) {
    if (requestSignature === filterSignature.value) upcomingError.value = error
  } finally {
    if (requestSignature === filterSignature.value) upcomingLoading.value = false
  }
}

async function refreshAgenda() {
  upcomingItems.value = []
  upcomingError.value = null
  upcomingCursor.value = addDays(resolvedUtcDay.value, -1)
  await refreshToday()
  if (activeRange.value === 'upcoming') await loadUpcoming()
}

function retryRealtime() {
  realtime.connect()
  void refreshAgenda()
}

// `AgendaKind` still admits 'post'; Today only ever lists the two booking kinds
// (`isAgendaItem` rejects the rest), so this narrows the type rather than
// standing in for missing data.
function isBookingKind(kind: AgendaKind): kind is BookingKind {
  return kind === 'reservation' || kind === 'booking'
}

function referenceDay(item: AgendaItem): string {
  return localDateAt(new Date(resolvedAt.value), item.timeZone)
}

function isUpcoming(item: AgendaItem): boolean {
  return item.dayKey > referenceDay(item)
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function minDate(left: string, right: string): string {
  return left < right ? left : right
}

watch(filterSignature, async () => {
  todayVisibleCount.value = PAGE_SIZE
  upcomingItems.value = []
  upcomingLoading.value = false
  upcomingError.value = null
  upcomingCursor.value = addDays(resolvedUtcDay.value, -1)
  if (activeRange.value === 'upcoming') await loadUpcoming()
}, { flush: 'post' })

watch(realtime.event, (event) => {
  if (event?.type === 'thread.created' || event?.type === 'thread.changed') void refreshAgenda()
})
watch(realtime.connectionEpoch, (epoch) => {
  if (epoch > 0) void refreshAgenda()
})

const loadMoreSentinel = ref<HTMLElement | null>(null)
let loadMoreObserver: IntersectionObserver | null = null

onMounted(() => {
  if (!('IntersectionObserver' in window)) return
  loadMoreObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) void loadMore()
  }, { rootMargin: '320px 0px' })
  if (loadMoreSentinel.value) loadMoreObserver.observe(loadMoreSentinel.value)
})

watch(loadMoreSentinel, (element, previous) => {
  if (previous) loadMoreObserver?.unobserve(previous)
  if (element) loadMoreObserver?.observe(element)
}, { flush: 'post' })

onBeforeUnmount(() => loadMoreObserver?.disconnect())
</script>
