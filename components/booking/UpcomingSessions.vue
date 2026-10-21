<template>
  <!-- Airbnb's dates: each upcoming session is a card the guest presses to book that time. -->
  <ul class="space-y-3">
    <li v-for="session in sessions" :key="session.id">
      <!-- A label for the booking dialog's checkbox, like every booking control: it opens before hydration too. -->
      <label
        :for="controlId"
        role="button"
        tabindex="0"
        class="block w-full cursor-pointer rounded-xl border border-default bg-default px-5 py-4 text-left transition-colors hover:border-inverted"
        :aria-label="`${pickLabel} ${dayLabel(session)} ${timeLabel(session)}`"
        @click="$emit('pick', session)"
        @keydown.enter.prevent="press"
        @keydown.space.prevent="press"
      >
        <span class="block font-semibold text-default">{{ dayLabel(session) }}</span>
        <span class="mt-0.5 block text-sm text-muted">
          {{ timeLabel(session) }}<template v-if="showRemaining && session.remaining !== null"> · {{ t('site.experience_detail.left', { count: session.remaining }) }}</template>
        </span>
      </label>
    </li>
  </ul>
</template>

<script setup lang="ts">
import type { PublicProductSession } from '~/server/utils/public-products'

defineProps<{
  sessions: PublicProductSession[]
  dayLabel: (session: PublicProductSession) => string
  timeLabel: (session: PublicProductSession) => string
  pickLabel: string
  controlId: string
  showRemaining: boolean
}>()
defineEmits<{ pick: [session: PublicProductSession] }>()
const { t } = useI18n()
const press = (event: KeyboardEvent) => (event.currentTarget as HTMLElement).click()
</script>
