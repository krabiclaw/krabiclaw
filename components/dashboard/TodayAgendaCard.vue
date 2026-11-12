<template>
  <NuxtLink :to="item.to" data-testid="today-card" :data-card-id="item.id" class="quest-card">
    <div class="quest-card__content">
      <p v-if="item.eyebrow" class="quest-card__eyebrow">{{ item.eyebrow }}</p>
      <p class="quest-card__title">{{ item.headline }}</p>
      <p v-if="item.description" class="quest-card__description">{{ item.description }}</p>
    </div>
    <UAvatar :src="avatarSrc" alt="" :icon="item.image_icon" class="quest-card__avatar" :ui="{ icon: 'size-8', image: 'object-cover' }" aria-hidden="true" />
  </NuxtLink>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TodayCard } from '~/shared/dashboard-today'
import { cfImageVariant } from '~/utils/cf-image'

/** One of the visits a guest account booked, on that account's Today. */
const props = defineProps<{ item: TodayCard }>()
const avatarSrc = computed(() => cfImageVariant(props.item.image_url, { width: 160, height: 160, fit: 'cover', format: 'auto' }) || props.item.image_url || undefined)
</script>

<style scoped>
.quest-card { display: flex; align-items: center; justify-content: space-between; gap: 24px; width: 100%; padding: 24px; border-radius: 16px; background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: 0 0 0 1px rgb(0 0 0 / 2%), 0 8px 24px rgb(0 0 0 / 10%); transition: box-shadow .2s ease; }
.quest-card:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: 4px; }
.quest-card:hover { box-shadow: 0 0 0 1px rgb(0 0 0 / 4%), 0 8px 24px rgb(0 0 0 / 14%); }
.quest-card__content { min-width: 0; flex: 1; }
.quest-card__eyebrow { margin-bottom: 8px; font-size: 12px; line-height: 16px; color: var(--ui-text-muted); }
.quest-card__title { font-size: 16px; line-height: 20px; font-weight: 500; }
.quest-card__description { margin-top: 8px; font-size: 14px; line-height: 18px; color: var(--ui-text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.quest-card__avatar { width: 60px; height: 60px; flex: 0 0 auto; }
@media (prefers-reduced-motion: reduce) { .quest-card { transition: none; } }
</style>
