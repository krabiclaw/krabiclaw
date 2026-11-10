<template>
  <div class="rounded-2xl border border-default bg-default p-6 shadow-2xs">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 class="text-base font-semibold text-highlighted">{{ title }}</h2>
        <p v-if="description" class="mt-1 text-sm text-muted">{{ description }}</p>
      </div>

      <div v-if="showCompare" class="flex items-center gap-2">
        <label for="chart-compare-select" class="text-xs text-muted">Compare</label>
        <USelect
          id="chart-compare-select"
          v-model="compareMode"
          :items="compareOptions"
          size="xs"
          class="w-36"
        />
      </div>
    </div>

    <div class="mt-6">
      <AnalyticsTrendChart
        v-if="hasData"
        :label="title"
        :dates="dates"
        :series="series"
      />
      <!-- Airbnb-Parity Baseline Grid for Empty / Inactive States -->
      <div v-else class="space-y-4">
        <svg viewBox="0 0 800 240" class="w-full overflow-visible text-xs" aria-hidden="true">
          <g v-for="step in [0, 1, 2, 3, 4]" :key="step">
            <line
              x1="60"
              :y1="200 - step * 45"
              x2="780"
              :y2="200 - step * 45"
              class="stroke-default"
              stroke-dasharray="2 2"
            />
            <text
              x="48"
              :y="205 - step * 45"
              text-anchor="end"
              class="fill-muted text-[13px]"
            >
              {{ isPercentage ? `${step * 25}.0%` : step * 10 }}
            </text>
          </g>
          <text x="60" y="225" class="fill-muted text-[13px]">{{ dateStartLabel }}</text>
          <text x="780" y="225" text-anchor="end" class="fill-muted text-[13px]">{{ dateEndLabel }}</text>
        </svg>

        <div class="rounded-xl bg-muted/40 p-4 text-center">
          <p class="text-sm font-medium text-highlighted">{{ emptyTitle ?? 'No activity recorded yet' }}</p>
          <p class="mt-1 text-xs text-muted">{{ emptyDescription ?? 'Activity will appear here automatically once visitors browse and book.' }}</p>
        </div>
      </div>
    </div>

    <div v-if="learnMoreHref" class="mt-4 pt-3 border-t border-default text-xs">
      <NuxtLink :to="learnMoreHref" class="font-medium text-primary hover:underline">
        {{ learnMoreLabel ?? 'Learn more about hosting performance' }}
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import AnalyticsTrendChart from '~/components/dashboard/AnalyticsTrendChart.vue'
import { formatCalendarDate } from '~/utils/timezone'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  dates: string[]
  series: Array<{ label: string; values: number[]; color: string }>
  isPercentage?: boolean
  showCompare?: boolean
  emptyTitle?: string
  emptyDescription?: string
  learnMoreLabel?: string
  learnMoreHref?: string
}>(), {
  isPercentage: false,
  showCompare: true,
})

const compareMode = ref('over_time')
const compareOptions = [
  { label: 'Over time', value: 'over_time' },
  { label: 'Prior period', value: 'prior_period' },
]

const hasData = computed(() => {
  return props.dates.length > 0 && props.series.some(s => s.values.some(v => v > 0))
})

const dateStartLabel = computed(() => {
  if (!props.dates.length) return 'Start'
  return formatCalendarDate(props.dates[0]!, 'en', { month: 'short', day: 'numeric' })
})

const dateEndLabel = computed(() => {
  if (!props.dates.length) return 'End'
  return formatCalendarDate(props.dates[props.dates.length - 1]!, 'en', { month: 'short', day: 'numeric' })
})
</script>
