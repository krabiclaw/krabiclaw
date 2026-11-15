<template>
  <NuxtLink :to="{ path: item.to, state: item.draft ? { draft: item.draft } : undefined }" class="ti" data-testid="today-item" :data-item-id="item.id">
    <span class="ti-main">
      <span class="ti-when">{{ item.when }}</span>
      <span class="ti-pic">
        <img v-if="src" :src="src" alt="" class="size-full object-cover">
      </span>
      <span class="ti-what">{{ item.headline }}</span>
      <span v-if="item.line" class="ti-where">{{ item.line }}</span>
    </span>
    <span class="ti-strip">
      <span class="min-w-0"><b>{{ item.action.title }}</b><small>{{ item.action.detail }}</small></span>
      <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0" aria-hidden="true" />
    </span>
  </NuxtLink>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TodayItem } from '~/shared/dashboard-today'
import { cfImageVariant } from '~/utils/cf-image'

/** One card of the business's Today: when, the picture, who and how many, where, then what to do. It opens the conversation about it. */
const props = defineProps<{ item: TodayItem }>()
const src = computed(() => cfImageVariant(props.item.image_url, { width: 960, height: 720, fit: 'cover', format: 'auto' }) || props.item.image_url || undefined)
</script>

<style scoped>
.ti { display: grid; overflow: hidden; border-radius: 18px; background: var(--ui-bg); color: var(--ui-text-highlighted); box-shadow: 0 6px 20px rgb(0 0 0 / 12%), 0 0 0 1px rgb(0 0 0 / 4%); }
.ti:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: 2px; }
.ti-main { display: grid; justify-items: center; gap: 6px; padding: 16px 16px 18px; text-align: center; }
.ti-when { font-size: 14px; font-weight: 500; }
.ti-pic { display: block; width: 100%; aspect-ratio: 4 / 3; margin: 6px 0 8px; overflow: hidden; border-radius: 14px; background: var(--ui-bg-accented); }
.ti-what { font-size: 22px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }
.ti-where { font-size: 14px; color: var(--ui-text-muted); }
.ti-strip { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--ui-border); text-align: left; }
.ti-strip b { display: block; font-weight: 500; }
.ti-strip small { display: block; font-size: 13px; color: var(--ui-text-muted); }
</style>
