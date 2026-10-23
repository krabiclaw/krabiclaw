<template>
  <!-- One row of a day: the Today card's shape, smaller — who, with the place as a badge, what, and when. -->
  <NuxtLink :to="to ?? item.to" :data-session-id="item.kind === 'session' ? item.id : undefined" class="group flex items-center gap-4 py-3" :class="cancelled ? 'text-muted' : 'text-highlighted'">
    <div class="relative size-12 shrink-0" aria-hidden="true">
      <UAvatar
        :src="item.guestImageUrl || undefined"
        alt=""
        :icon="item.kind === 'session' ? 'i-lucide-calendar-clock' : 'i-lucide-user'"
        class="size-12"
        :ui="{ icon: 'size-6' }"
      />
      <div class="absolute -bottom-1 -right-1 flex size-6 items-center justify-center overflow-hidden rounded-lg border-2 border-default bg-default">
        <img v-if="item.resourceImageUrl" :src="item.resourceImageUrl" alt="" class="size-full object-cover">
        <UIcon v-else :name="item.kind === 'session' || item.kind === 'booking' ? 'i-lucide-ticket' : item.kind === 'post' ? 'i-lucide-newspaper' : 'i-lucide-map-pin'" class="size-3 text-muted" />
      </div>
    </div>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium" :class="cancelled ? 'line-through' : ''">{{ item.title }}</p>
      <p class="mt-0.5 truncate text-xs text-muted">{{ details }}</p>
    </div>
    <div class="shrink-0 text-right text-sm tabular-nums" :class="cancelled ? 'line-through' : ''">
      {{ formattedTime }}
      <span v-if="item.showTimeZone" class="block text-xs font-normal text-muted">{{ item.timeZone }}</span>
    </div>
    <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-dimmed group-hover:text-highlighted" />
  </NuxtLink>
</template>

<script lang="ts">
import type { AgendaItem } from '~/server/utils/dashboard-agenda'

/** A row presents a scheduled record without treating an offered time as a guest booking. */
export type CalendarRowItem = Pick<AgendaItem, 'id' | 'startsAt' | 'timeZone' | 'showTimeZone' | 'title' | 'subtitle' | 'status' | 'locationTitle' | 'guestImageUrl' | 'resourceImageUrl' | 'to'> & { kind: AgendaItem['kind'] | 'session' }
</script>

<script setup lang="ts">
import { formatTimestamp } from '~/utils/timezone'

// The surface drawing the row says where it opens: under Today the record's
// own screen, under a calendar day the same record as a leaf of that day.
const props = defineProps<{ item: CalendarRowItem; to?: string }>()
const cancelled = computed(() => props.item.status === 'cancelled')
const formattedTime = computed(() => formatTimestamp(props.item.startsAt, 'en', props.item.timeZone, { hour: 'numeric', minute: '2-digit' }))
const details = computed(() => [cancelled.value ? 'Cancelled' : null, !cancelled.value || props.item.kind === 'session' ? props.item.subtitle : null, props.item.locationTitle].filter(Boolean).join(' · '))
</script>
