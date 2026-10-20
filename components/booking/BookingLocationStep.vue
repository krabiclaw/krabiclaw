<template>
  <div class="booking-location-step">
    <div
      class="grid gap-3"
      :class="locations.length === 1 ? 'grid-cols-1' : 'grid-cols-2'"
    >
      <button
        v-for="loc in locations"
        :key="loc.id"
        type="button"
        class="group relative flex flex-col text-left rounded-xl border transition-all overflow-hidden"
        :class="[
          modelValue === loc.id
            ? 'border-primary ring-1 ring-primary'
            : 'border-default hover:border-primary/40'
        ]"
        @click="$emit('update:modelValue', loc.id)"
      >
        <!-- Location image if available -->
        <div v-if="locationMedia(loc)?.public_url" class="aspect-16/7 w-full overflow-hidden bg-muted shrink-0">
          <img
            v-if="locationMedia(loc)?.kind === 'image'"
            :src="locationMedia(loc)?.public_url ?? ''"
            :alt="loc.title ?? ''"
            class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
          <div
            v-else-if="locationMedia(loc)?.kind === 'video'"
            class="relative h-full w-full bg-muted"
          >
            <img
              v-if="locationMedia(loc)?.thumbnail_url"
              :src="locationMedia(loc)?.thumbnail_url || ''"
              :alt="loc.title ?? ''"
              class="h-full w-full object-cover"
            />
            <div class="absolute inset-0 flex items-center justify-center">
              <svg viewBox="0 0 24 24" class="w-12 h-12" :class="locationMedia(loc)?.thumbnail_url ? 'text-white drop-shadow' : 'text-muted'" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </div>
          </div>
        </div>

        <div class="p-4 flex flex-col gap-1.5">
          <!-- Selected indicator -->
          <div class="flex items-start justify-between gap-2">
            <h3 class="font-semibold text-default text-[15px] leading-snug">{{ loc.title }}</h3>
            <div
              class="shrink-0 mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors"
              :class="modelValue === loc.id
                ? 'border-primary bg-primary'
                : 'border-default'"
            >
              <svg
                v-if="modelValue === loc.id"
                class="w-2.5 h-2.5 text-on-primary"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M2 6l3 3 5-5" />
              </svg>
            </div>
          </div>

          <!-- Address -->
          <p v-if="loc.address" class="text-sm text-muted leading-snug">
            {{ formatAddress(loc.address) }}
          </p>

          <!-- Today's hours -->
          <p v-if="loc.todayHours" class="text-sm text-muted">
            <span class="text-default font-medium">{{ t('saya.location.today') }}: </span>{{ loc.todayHours }}
          </p>

          <!-- Phone -->
          <p v-if="loc.phone" class="text-sm text-muted">{{ formatPhone(loc.phone) }}</p>
        </div>
      </button>
    </div>

    <!-- Continue button -->
    <div class="pt-6">
      <TenantButton size="lg" block :disabled="!modelValue" @click="$emit('next')">
        {{ t('saya.experience_detail.continue') }}
      </TenantButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import { formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'

const { t } = useI18n()

export interface BookingLocation {
  id: string
  title?: string | null
  address?: unknown
  phone?: string | null
  media?: Array<{ slot: string; public_url?: string | null; thumbnail_url?: string | null; kind?: 'image' | 'video' | null }>
  opening_hours?: unknown
  timezone?: string | null
  todayHours?: string | null
}

defineProps<{
  modelValue?: string | null
  locations: BookingLocation[]
}>()

defineEmits<{
  'update:modelValue': [id: string]
  next: []
}>()

const locationMedia = (location: BookingLocation) => location.media?.find(item => item.slot === 'hero') ?? null

function formatAddress(address: unknown): string {
  return formatPostalAddress(parsePostalAddress(address))
}

</script>
