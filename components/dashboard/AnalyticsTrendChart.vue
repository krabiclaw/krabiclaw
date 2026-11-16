<template>
  <div>
    <div class="mb-3 min-h-12 text-sm" aria-live="polite">
      <template v-if="selectedIndex !== null">
        <p class="font-medium text-highlighted">{{ dates[selectedIndex]!.label }}</p>
        <p class="mt-1 text-muted">{{ chart.points[selectedIndex]!.display }}</p>
      </template>
    </div>
    <div v-if="dates.length" class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs text-muted" role="group" :aria-label="label" @mouseleave="selectedIndex = null">
      <!-- The ticks, top to bottom, each on its grid line. -->
      <div class="flex h-56 flex-col-reverse justify-between text-right sm:h-72">
        <span v-for="tick in chart.axis" :key="tick.value" class="h-0 -translate-y-2 whitespace-nowrap leading-4">{{ tick.label }}</span>
      </div>
      <div class="relative h-56 sm:h-72">
        <div class="absolute inset-0 flex flex-col justify-between" aria-hidden="true">
          <div v-for="tick in chart.axis" :key="tick.value" class="h-0 border-t border-default" />
        </div>
        <div class="absolute inset-0 flex items-end">
          <button v-for="(date, index) in dates" :key="date.date" type="button" class="flex h-full min-w-0 flex-1 items-end justify-center px-px focus-visible:outline-2 focus-visible:outline-primary"
            :class="selectedIndex === index ? 'bg-elevated' : ''" :aria-label="`${date.label}: ${chart.points[index]!.display}`"
            @focus="selectedIndex = index" @blur="selectedIndex = null" @mouseenter="selectedIndex = index" @click="selectedIndex = index">
            <span v-if="chart.points[index]!.value" class="w-full max-w-6 rounded-t-sm bg-inverted" :style="{ height: `${Math.max(chart.points[index]!.value! / maximum * 100, 1)}%` }" />
          </button>
        </div>
      </div>
      <div />
      <div class="mt-2 flex justify-between">
        <span>{{ dates[0]!.label }}</span>
        <span v-if="dates.length > 2">{{ dates[Math.floor((dates.length - 1) / 2)]!.label }}</span>
        <span v-if="dates.length > 1">{{ dates.at(-1)!.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InsightsPage } from '~/shared/insights'

/** One number over the range as the page composed it: its axis ticks, and a bar for each day that has a value; a day with nothing, or nothing to measure, has no bar. */
const props = defineProps<{
  label: string
  dates: InsightsPage['series']['dates']
  chart: InsightsPage['series']['charts'][string]
}>()
const selectedIndex = ref<number | null>(null)
const maximum = computed(() => props.chart.axis.at(-1)!.value)
</script>
