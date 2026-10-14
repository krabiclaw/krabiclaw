<template>
  <NuxtLink
    :to="item.to"
    class="group flex min-h-36 items-center justify-between gap-4 rounded-2xl bg-elevated/50 px-5 py-5 shadow-sm ring ring-default transition-colors hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-40 sm:gap-6 sm:px-7 sm:py-6"
  >
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-highlighted">
        <span>{{ formattedTime }}</span>
        <span v-if="item.showTimeZone" class="font-normal text-muted">{{ item.timeZone }}</span>
      </div>
      <p class="mt-1 text-base font-semibold leading-snug text-highlighted">
        {{ headline }}
      </p>
      <p v-if="where" class="mt-5 line-clamp-2 text-base leading-normal text-muted">
        {{ where }}
      </p>
    </div>

    <!-- The business sees the guest with the place as a badge; the account sees the place. -->
    <div class="relative h-14 w-18 shrink-0 self-start sm:h-20 sm:w-26" aria-hidden="true">
      <UAvatar
        :src="(personal ? item.resourceImageUrl : item.guestImageUrl) || undefined"
        alt=""
        :icon="personal ? resourceIcon : 'i-lucide-user'"
        class="size-14 sm:size-20"
        :ui="{ icon: 'size-7 sm:size-10' }"
      />

      <div v-if="!personal" class="absolute bottom-0 right-0 flex size-8 items-center justify-center overflow-hidden rounded-xl border-2 border-default bg-default shadow-sm sm:size-11">
        <img v-if="item.resourceImageUrl" :src="item.resourceImageUrl" alt="" class="size-full object-cover">
        <UIcon v-else :name="resourceIcon" class="size-4 text-muted sm:size-5" />
      </div>
    </div>
  </NuxtLink>
</template>

<script setup lang="ts">
import { formatTimestamp } from '~/utils/timezone'
import type { AgendaItem } from '~/server/utils/dashboard-agenda'

const props = defineProps<{
  item: AgendaItem
  referenceDay: string
  /** The account's own visit rather than a guest the business is hosting. */
  personal?: boolean
}>()

const formattedTime = computed(() => formatTimestamp(props.item.startsAt, 'en', props.item.timeZone, { hour: 'numeric', minute: '2-digit' }))

const headline = computed(() => {
  const dayDistance = differenceInDays(props.referenceDay, props.item.dayKey)
  const when = dayDistance <= 0 ? 'today' : dayDistance === 1 ? 'tomorrow' : `in ${dayDistance} days`
  const guests = props.item.partySize && props.item.partySize > 0
    ? `${props.item.partySize} ${props.item.partySize === 1 ? 'guest' : 'guests'}`
    : ''
  if (props.personal) return `${props.item.title} ${when}${guests ? ` for ${guests}` : ''}`
  return `${firstName(props.item.title)} ${props.item.stayMoment === 'departure' ? 'leaves' : 'arrives'} ${when}${guests ? ` with ${guests}` : ''}`
})

// Under personal scope the subtitle is the business; the business's own card names the branch.
const where = computed(() => props.personal
  ? [...new Set([props.item.subtitle, props.item.locationTitle].filter((part): part is string => !!part && part !== props.item.title))].join(' · ')
  : props.item.locationTitle)

const resourceIcon = computed(() => props.item.kind === 'booking'
  ? 'i-lucide-ticket'
  : props.item.kind === 'stay' ? 'i-lucide-house' : 'i-lucide-map-pin')

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}

function differenceInDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
</script>
