<template>
  <div class="relative rounded-[28px] overflow-hidden border border-default p-8 sm:p-12 mb-24 bg-(--kc-navy) text-white shadow-2xl" data-parity-section="proof">
    <div class="absolute w-80 h-80 rounded-full blur-3xl opacity-80" :class="orbClass"></div>
    <div class="relative z-10 grid lg:grid-cols-12 gap-8 items-center">
      <div class="lg:col-span-7 space-y-6">
        <span v-if="pill" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider bg-white/10 text-white/90 border border-white/20">
          <PlatformIcon v-if="pillIcon" :name="pillIcon" class="size-3.5" :class="pillIconClass" />
          {{ pill }}
        </span>
        <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-white m-0">{{ title }}</h2>
        <TenantPageMarkdown v-if="description" :content="description" class="text-white/80 text-[15px] sm:text-base leading-relaxed m-0" />
        <div v-if="stats.length" class="grid sm:grid-cols-3 gap-4 pt-2">
          <div v-for="(stat, index) in stats" :key="stat.label" class="rounded-xl bg-white/5 border border-white/10 p-4">
            <div class="text-2xl font-black" :class="statClass(index)">{{ stat.value }}</div>
            <div class="text-xs text-white/70 mt-0.5">{{ stat.label }}</div>
          </div>
        </div>
      </div>
      <div v-if="card" class="lg:col-span-5 flex justify-center">
        <div class="rounded-2xl border border-white/15 bg-white/5 p-6 backdrop-blur-md shadow-xl w-full max-w-sm space-y-4">
          <div class="flex items-center justify-between border-b border-white/10 pb-4">
            <div class="font-bold text-white text-base">{{ card.title }}</div>
            <span v-if="card.badge" class="text-xs font-semibold px-2 py-0.5 rounded-full" :class="badgeClass">{{ card.badge }}</span>
          </div>
          <div class="space-y-2 text-xs text-white/80">
            <div v-for="(row, index) in card.rows" :key="row.label" class="flex justify-between py-1 border-b border-white/5">
              <span class="text-white/60">{{ row.label }}</span>
              <span :class="index === card.rows.length - 1 && highlightLastRow ? lastRowClass : ''">{{ row.value }}</span>
            </div>
          </div>
          <div v-if="card.ctaLabel && card.ctaUrl" class="pt-2">
            <PlatformButton :to="card.ctaUrl" variant="outline" size="sm" class="w-full text-white border-white/30 hover:bg-white/10 justify-center">
              {{ card.ctaLabel }} →
            </PlatformButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords } from '~/utils/tenant-page-block-data'
import type { PlatformIconName } from '~/components/platform/PlatformIcon.vue'

export interface PlatformProofStat { value: string; label: string }
export interface PlatformProofCard {
  title: string
  badge?: string | null
  rows: Array<{ label: string; value: string }>
  ctaLabel?: string | null
  ctaUrl?: string | null
}

/**
 * The navy "verified production showcase" band each vertical page carries:
 * a pill, a headline, a paragraph, three stats, and a mock of the customer's
 * own site in a glass card. The orb's corner, the stat colours and the badge
 * tint are the vertical's — restaurants and legal light the top-right in
 * coral, experiences the bottom-left in teal.
 */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

/** KrabiClaw's verticals each carry their own accent; the page says which. */
const accent = computed<'primary' | 'teal' | 'navy'>(() => (
  props.page.path === '/experiences' ? 'teal' : props.page.path === '/legal' ? 'navy' : 'primary'))

const pill = computed(() => blockTextOrNull(props.block.data.label))
const pillIcon = computed<PlatformIconName | null>(() => null)
const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const stats = computed<PlatformProofStat[]>(() => blockRecords(props.block.data.items)
  .map(item => ({ value: blockText(item.value), label: blockText(item.title) }))
  .filter(stat => stat.value && stat.label))
// The card beside the figures was a second block pretending to be a stat grid.
// It is a callout now, and draws itself.
const card = computed<PlatformProofCard | null>(() => null)

const orbClass = computed(() => (accent.value === 'teal'
  ? '-bottom-32 -left-32 bg-(--kc-teal)/20'
  : '-top-32 -right-32 bg-primary/20'))
const pillIconClass = computed(() => (accent.value === 'teal' ? 'text-(--kc-coral)' : 'text-(--kc-teal)'))
const badgeClass = computed(() => (accent.value === 'teal' ? 'bg-primary/20 text-primary' : 'bg-(--kc-teal)/20 text-(--kc-teal)'))

const STAT_CLASSES: Record<typeof accent.value, readonly string[]> = {
  primary: ['text-white', 'text-(--kc-teal)', 'text-(--kc-coral)'],
  teal: ['text-(--kc-teal)', 'text-white', 'text-(--kc-coral)'],
  navy: ['text-white', 'text-(--kc-teal)', 'text-(--kc-coral)'],
}
function statClass(index: number) {
  const sequence = STAT_CLASSES[accent.value]
  return sequence[index % sequence.length]
}

// Restaurants and legal end the mock card on a highlighted row (a review score,
// an intake system); experiences does not.
const highlightLastRow = computed(() => accent.value !== 'teal')
const lastRowClass = computed(() => (accent.value === 'primary' ? 'text-(--kc-coral) font-semibold' : 'text-(--kc-teal) font-semibold'))
</script>
