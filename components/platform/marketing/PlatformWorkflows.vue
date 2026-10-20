<template>
  <section v-if="page.recipe === 'products'" :id="block.id" class="kc-product-workflows" data-parity-section="workflows">
    <div class="kc-product-workflows__inner">
      <div>
        <p class="kc-product-eyebrow">{{ eyebrow }}</p>
        <h2>{{ title }}</h2>
        <p class="kc-product-workflows__body">{{ description }}</p>
        <NuxtLink v-if="block.data.cta_label && block.data.cta_url" :to="route(String(block.data.cta_url))" class="kc-product-link">{{ block.data.cta_label }} <span aria-hidden="true">↗</span></NuxtLink>
        <ul class="kc-product-workflows__clients" aria-label="Compatible assistants"><li>ChatGPT</li><li>Claude</li><li>MCP</li></ul>
      </div>
      <div>
        <p class="kc-product-workflows__question">{{ block.data.prompt_heading }}</p>
        <ul class="kc-product-workflows__prompts"><li v-for="item in items" :key="item.title"><span aria-hidden="true">↗</span> {{ item.prompt }}</li></ul>
      </div>
      <ol class="kc-product-workflows__steps"><li v-for="(item, index) in items" :key="item.title"><span>{{ String(index + 1).padStart(2, '0') }}</span> {{ item.title }}</li></ol>
    </div>
  </section>
  <div v-else class="rounded-3xl border border-default bg-elevated/40 p-8 sm:p-12 mb-24 max-w-5xl mx-auto backdrop-blur-md" data-parity-section="workflows">
    <div class="text-center max-w-2xl mx-auto mb-10">
      <span v-if="eyebrow" class="kc-eyebrow" :class="eyebrowClass">{{ eyebrow }}</span>
      <h2 class="text-3xl font-extrabold text-default mt-2">{{ title }}</h2>
      <p v-if="description" class="text-sm text-muted mt-2">{{ description }}</p>
    </div>

    <div class="grid md:grid-cols-3 gap-6">
      <div
        v-for="(item, index) in items"
        :key="item.title"
        class="rounded-2xl border border-default bg-default p-6 flex flex-col justify-between shadow-sm"
      >
        <div>
          <div class="flex items-center gap-2 mb-4 text-xs font-bold uppercase" :class="labelClass(index)">
            <PlatformIcon :name="item.icon" class="size-4" />
            {{ item.title }}
          </div>
          <div class="rounded-xl bg-muted/40 p-3 text-xs font-mono text-muted mb-4 border border-default/50">
            “{{ item.prompt }}”
          </div>
          <p class="text-[13px] text-muted leading-relaxed m-0">{{ item.description }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords, isInternalRoute } from '~/utils/tenant-page-block-data'
import type { PlatformIconName } from '~/components/platform/PlatformIcon.vue'

export interface PlatformWorkflow {
  title: string
  icon: PlatformIconName
  prompt: string
  description: string
}

/**
 * Three conversational workflows: a labelled card, the prompt someone would
 * type, and what happens. Each card's label colour follows the vertical's own
 * sequence, which is why the accent order is a prop rather than a constant.
 */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath } = useI18n()
function route(url: string) { return isInternalRoute(url) ? localePath(url) : url }

/** KrabiClaw's verticals each carry their own accent; the page says which. */
const accent = computed<'primary' | 'teal' | 'navy'>(() => (
  props.page.path === '/experiences' ? 'teal' : props.page.path === '/legal' ? 'navy' : 'primary'))

const eyebrow = computed(() => blockTextOrNull(props.block.data.label))
const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const items = computed<PlatformWorkflow[]>(() => blockRecords(props.block.data.items).map(item => ({
  title: blockText(item.title),
  icon: (blockTextOrNull(item.icon) ?? 'sparkles') as PlatformIconName,
  // The prompt is a declared field now; it used to ride in `value`, a key the
  // feature grid meant for a statistic.
  prompt: blockText(item.prompt),
  description: blockText(item.description),
})).filter(item => item.title))

const EYEBROW: Record<typeof accent.value, string> = {
  primary: 'text-primary',
  teal: 'text-(--kc-teal-600)',
  navy: 'text-primary',
}
const LABELS: Record<typeof accent.value, readonly string[]> = {
  primary: ['text-(--kc-coral)', 'text-(--kc-teal)', 'text-primary'],
  teal: ['text-(--kc-teal)', 'text-primary', 'text-(--kc-coral)'],
  navy: ['text-primary', 'text-(--kc-teal)', 'text-(--kc-coral)'],
}
const eyebrowClass = computed(() => EYEBROW[accent.value])
function labelClass(index: number) {
  const sequence = LABELS[accent.value]
  return sequence[index % sequence.length]
}
</script>
