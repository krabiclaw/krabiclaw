<template>
  <div>
    <div class="mb-3 min-h-12 text-sm" aria-live="polite">
      <template v-if="selectedIndex !== null">
        <p class="font-medium text-highlighted">{{ dates[selectedIndex]!.label }}</p>
        <p class="mt-1 text-muted">{{ chart.points[selectedIndex]!.display }}</p>
      </template>
    </div>
    <svg v-if="dates.length" viewBox="0 0 800 260" class="w-full overflow-visible" role="group" :aria-label="label" @mouseleave="selectedIndex = null">
      <g v-for="tick in chart.axis" :key="tick.value">
        <line x1="60" :y1="y(tick.value)" x2="780" :y2="y(tick.value)" class="stroke-default" />
        <text x="48" :y="y(tick.value) + 5" text-anchor="end" class="fill-muted text-[20px]">{{ tick.label }}</text>
      </g>
      <polyline v-for="(run, index) in runs" :key="index" :points="run.map(point => `${x(point)},${y(chart.points[point]!.value!)}`).join(' ')"
        fill="none" stroke="var(--ui-text-highlighted)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      <g v-for="(date, index) in dates" :key="date.date" tabindex="0" role="button"
        :aria-label="`${date.label}: ${chart.points[index]!.display}`"
        @focus="selectedIndex = index" @blur="selectedIndex = null" @mouseenter="selectedIndex = index"
        @click="selectedIndex = index" @keydown.enter="selectedIndex = index" @keydown.space.prevent="selectedIndex = index">
        <rect :x="x(index) - 360 / dates.length" y="35" :width="720 / dates.length" height="190" fill="transparent" />
        <line v-if="selectedIndex === index" :x1="x(index)" y1="40" :x2="x(index)" y2="218" class="stroke-muted" />
        <circle v-if="chart.points[index]!.value !== null" :cx="x(index)" :cy="y(chart.points[index]!.value!)" :r="selectedIndex === index ? 5 : 2" fill="var(--ui-text-highlighted)" />
      </g>
      <text x="60" y="248" class="fill-muted text-[20px]">{{ dates[0]!.label }}</text>
      <text x="420" y="248" text-anchor="middle" class="fill-muted text-[20px]">{{ dates[Math.floor((dates.length - 1) / 2)]!.label }}</text>
      <text x="780" y="248" text-anchor="end" class="fill-muted text-[20px]">{{ dates.at(-1)!.label }}</text>
    </svg>
  </div>
</template>

<script setup lang="ts">
import type { InsightsPage } from '~/shared/insights'

/** One number over the range as the page composed it: its axis ticks, and each day's point; a null day had nothing to measure and breaks the line. */
const props = defineProps<{
  label: string
  dates: InsightsPage['series']['dates']
  chart: InsightsPage['series']['charts'][string]
}>()
const selectedIndex = ref<number | null>(null)
const maximum = computed(() => props.chart.axis.at(-1)!.value)
const x = (index: number) => 60 + (props.dates.length > 1 ? index * 720 / (props.dates.length - 1) : 0)
const y = (value: number) => 218 - value / maximum.value * 178
/** The runs of consecutive measured days, each drawn as its own line. */
const runs = computed(() => {
  const result: number[][] = []
  props.chart.points.forEach((point, index) => {
    if (point.value === null) return
    const last = result.at(-1)
    if (last && last.at(-1) === index - 1) last.push(index)
    else result.push([index])
  })
  return result
})
</script>
