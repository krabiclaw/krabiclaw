<template>
  <UCard
    :as="NuxtLink"
    :to="item.to"
    variant="subtle"
    data-testid="today-card"
    :data-card-id="item.id"
    :data-card-priority="item.priority"
    class="group block transition-colors hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    :ui="{ body: 'flex min-h-36 items-center justify-between gap-4 sm:min-h-40 sm:gap-6' }"
    @click="onCardClick"
  >
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-highlighted">
        <span>{{ item.eyebrow }}</span>
      </div>
      <p class="mt-1 text-base font-semibold leading-snug text-highlighted">
        {{ item.headline }}
      </p>
      <p v-if="item.description" class="mt-5 line-clamp-2 text-base leading-normal text-muted">
        {{ item.description }}
      </p>
    </div>

    <div class="relative h-14 w-18 shrink-0 self-start sm:h-20 sm:w-26" aria-hidden="true">
      <UAvatar
        :src="item.imageUrl || undefined"
        alt=""
        :icon="item.imageIcon"
        class="size-14 sm:size-20"
        :ui="{ icon: 'size-7 sm:size-10', image: item.imageFit === 'contain' ? 'object-contain p-1.5 sm:p-2' : undefined }"
      />

      <div v-if="item.badgeImageUrl || item.badgeIcon" class="absolute bottom-0 right-0 flex size-8 items-center justify-center overflow-hidden rounded-xl border-2 border-default bg-default shadow-sm sm:size-11">
        <img v-if="item.badgeImageUrl" :src="item.badgeImageUrl" alt="" class="size-full object-cover">
        <UIcon v-else-if="item.badgeIcon" :name="item.badgeIcon" class="size-4 text-muted sm:size-5" />
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TodayCard } from '~/shared/dashboard-today'
import { useDashboardTelemetry } from '~/composables/useDashboardTelemetry'

const props = defineProps<{
  item: TodayCard
  surface?: string
}>()

const telemetry = useDashboardTelemetry()

function onCardClick() {
  telemetry.track({
    action: 'today_card_click',
    surface: props.surface ?? 'today',
    cardId: props.item.id,
    cardPriority: props.item.priority,
    cardKind: props.item.bookingKind ?? undefined,
    locationId: props.item.locationId ?? undefined,
    targetPath: props.item.to,
  })
}
</script>
