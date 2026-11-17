<template>
  <article class="ti" data-testid="today-item" :data-item-id="item.id">
    <component :is="item.to ? NuxtLink : 'div'" v-bind="item.to ? { to: { path: item.to, state: item.draft ? { draft: item.draft } : undefined }, 'aria-describedby': actionId } : {}" class="ti-main">
      <span v-if="item.when" class="ti-when">{{ item.when }}</span>
      <span v-if="src" class="ti-pic"><img :src="src" alt="" class="size-full object-cover"></span>
      <span v-else class="ti-tile"><UIcon :name="item.icon" class="size-6" /></span>
      <span class="ti-what">{{ item.headline }}</span>
      <span v-if="item.line" class="ti-where">{{ item.line }}</span>
    </component>
    <button v-if="item.done || item.claim" type="button" class="ti-strip" :disabled="busy" :data-testid="item.claim ? 'today-item-claim' : 'today-item-done'" @click="emit('done', item)">
      <span class="min-w-0"><b>{{ item.claim?.label ?? item.action.title }}</b><small v-if="item.action.detail">{{ item.action.detail }}</small></span>
      <UIcon :name="busy ? 'i-lucide-loader-circle' : 'i-lucide-circle-check'" class="size-6 shrink-0" :class="{ 'animate-spin': busy }" aria-hidden="true" />
    </button>
    <!-- One keyboard stop: the strip repeats the card's link, and the link is described by its action. -->
    <NuxtLink v-else-if="item.to" :to="{ path: item.to, state: item.draft ? { draft: item.draft } : undefined }" class="ti-strip" tabindex="-1" aria-hidden="true">
      <span :id="actionId" class="min-w-0"><b>{{ item.action.title }}</b><small>{{ item.action.detail }}</small></span>
      <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0" />
    </NuxtLink>
  </article>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TodayItem } from '~/shared/dashboard-today'
import { cfImageVariant } from '~/utils/cf-image'

/**
 * One card of the business's Today: when, the picture (or a small tile when
 * there is none), who and how many, where, then what to do. It opens the
 * conversation about it; a task someone added closes from its strip.
 */
const props = defineProps<{ item: TodayItem; busy?: boolean }>()
const emit = defineEmits<{ done: [item: TodayItem] }>()
const actionId = useId()
const src = computed(() => cfImageVariant(props.item.image_url, { width: 760, height: 570, fit: 'cover', format: 'auto' }) || props.item.image_url || undefined)
</script>

<style scoped>
.ti { display: grid; overflow: hidden; border-radius: 18px; background: var(--ui-bg); color: var(--ui-text-highlighted); box-shadow: 0 6px 20px rgb(0 0 0 / 12%), 0 0 0 1px rgb(0 0 0 / 4%); }
.ti-main { display: grid; align-content: start; justify-items: center; gap: 6px; padding: 16px 16px 18px; text-align: center; }
.ti-main:focus-visible, .ti-strip:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: -2px; }
.ti-when { font-size: 14px; font-weight: 500; }
.ti-pic { display: block; width: 100%; aspect-ratio: 4 / 3; margin: 6px 0 8px; overflow: hidden; border-radius: 14px; background: var(--ui-bg-accented); }
.ti-tile { display: grid; place-items: center; width: 56px; height: 56px; margin: 6px 0 8px; border-radius: 999px; background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.ti-what { font-size: 22px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }
.ti-where { font-size: 14px; color: var(--ui-text-muted); }
.ti-strip { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--ui-border); text-align: left; }
.ti-strip b { display: block; font-weight: 500; }
.ti-strip small { display: block; font-size: 13px; color: var(--ui-text-muted); }
.ti-strip:disabled { opacity: .6; }
</style>
